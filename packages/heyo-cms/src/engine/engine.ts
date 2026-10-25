import { parseDuration } from "../duration";
import { CmsError } from "../errors";
import { createId, createOrderedId } from "../ids";
import { and, eq } from "../query";
import { documentsTableName } from "../schema/snapshot";
import type { Actor, OperationSource } from "../types/actor";
import type {
  CollectionApi,
  CountArgs,
  CreateArgs,
  DeleteArgs,
  FindArgs,
  FindOneArgs,
  FindResult,
  GlobalApi,
  GlobalScheduleArgs,
  OperationArgs,
  PreviousSlug,
  PreviousSlugsArgs,
  PreviousSlugWriteArgs,
  ReadArgs,
  ResolveSlugArgs,
  RestoreArgs,
  ScheduleArgs,
  SlugResolution,
  UnscheduleArgs,
  UpdateArgs,
} from "../types/api";
import type {
  AccessOperation,
  ResolvedCmsConfig,
  ResolvedCollection,
} from "../types/config";
import type { DatabaseAdapter } from "../types/database";
import type { FieldDefinition } from "../types/fields";
import type { HookContext, HookOperation, ScopedDb } from "../types/hooks";
import type { CmsInstance } from "../types/instance";
import type { JsonObject } from "../types/json";
import type { OrderBy, Row, Tx, Where } from "../types/query";
import type { CmsTrash, TrashListArgs, TrashTargetArgs } from "../types/trash";
import {
  collectMediaReferences,
  referencesMedia,
  syncMediaUsages,
} from "../media/usages";
import { accessFilter } from "./access";
import { cursorWhere, encodeCursor } from "./cursor";
import {
  asObject,
  changedFields,
  rowToDocument,
  scheduledPatch,
  toRevision,
  toStoredData,
  validateFields,
} from "./documents";
import {
  applyFieldReadAccess,
  assertFieldWriteAccess,
  hasFieldAccessRules,
} from "./field-access";
import {
  buildHookPipeline,
  runAfterHooks,
  runBeforeHooks,
  type CollectionHookPipeline,
} from "./hooks";
import { JobRunner } from "./jobs";
import { localeContext, type LocaleContext } from "./locales";
import {
  EventBuffer,
  Outbox,
  type BufferedEvent,
  type EventDispatch,
  type OutboxEntryMeta,
} from "./outbox";
import { RelationLoader } from "./relations";
import { scopedDb } from "./scoped-db";
import {
  assertFree,
  prepareSlugs,
  previousSlugRows,
  recordSlugMoves,
  releaseSlugs,
  removePreviousSlugRow,
  slugCandidates,
  slugCleaner,
  slugFields,
  slugOptions,
  type SlugMove,
} from "./slugs";
import { listTrashed } from "./trash";

const defaultLimit = 25;
const maxLimit = 500;
const activityTable = "activity";
const mediaUsagesTable = "media_usages";
const aiMutationsTable = "cms_ai_mutations";

export interface EngineOptions {
  config: ResolvedCmsConfig;
  /** Resolved lazily: a D1 binding only exists inside a request. */
  database: () => Promise<DatabaseAdapter>;
  dispatch: EventDispatch;
}

/**
 * What one write means.
 *
 * `operation` in the hook contract is CRUD and stays CRUD (section 5); this
 * is the finer question the engine has to answer anyway — which event to
 * emit, what the activity log should say, whether the `delete` hooks have
 * already run. Keeping the two apart is what lets the trash exist without
 * adding a fourth hook family nobody asked for.
 */
export type WriteIntent =
  | "create"
  | "update"
  | "trash"
  | "restore"
  | "purge"
  | "schedule"
  | "unschedule";

/** Which hook family an intent belongs to, when it runs hooks at all. */
const hookFamily: Record<WriteIntent, HookOperation> = {
  create: "create",
  update: "update",
  trash: "delete",
  purge: "delete",
  restore: "update",
  schedule: "update",
  unschedule: "update",
};

/** What one operation-specific step is handed by the shared write path. */
interface WriteScope {
  adapter: DatabaseAdapter;
  tx: Tx;
  db: ScopedDb;
  hooks: CollectionHookPipeline;
  context: HookContext;
}

interface WriteOutcome {
  doc: JsonObject;
  previous: JsonObject | null;
  /** Fields whose value actually changed; drives `document.field.changed`. */
  changed: string[];
  /**
   * The document body as it was stored, across every locale.
   *
   * Media reference counting reads this rather than `doc`: a German
   * translation dropping an image has not stopped the English one from using
   * it, and counting only the locale of the current request would orphan a
   * file that is on a live page (section 6).
   */
  stored?: JsonObject;
  /**
   * Whether this operation releases every reference the document held.
   *
   * Set by a purge, and only by a purge. The trash deliberately keeps its
   * usages: a picture used by a document an editor can still restore is not
   * an unused picture (stage 5).
   */
  releaseMedia?: boolean;
  /** Slugs this write retired, which become previous addresses. */
  slugMoves?: SlugMove[];
  /**
   * Whether this operation's `after` hooks run.
   *
   * Set by the step rather than by the intent because only the step knows
   * what it found: purging a document that was already in the trash must not
   * run the `delete` hooks a second time, and purging a live one must.
   */
  after?: boolean;
}

interface WriteRequest {
  collection: ResolvedCollection;
  intent: WriteIntent;
  actor: Actor | null;
  source: OperationSource;
  locale: LocaleContext;
  depth: number | undefined;
  includeTrashed: boolean | undefined;
  /** The AI run this write belongs to, for the activity entry. */
  runId?: string | undefined;
  /** Written with the document, so a replay never writes twice. */
  idempotencyKey?: string | undefined;
  step: (scope: WriteScope) => Promise<WriteOutcome | null>;
  /** Events this operation owes on top of the engine's own. */
  emit?: (events: EventBuffer, outcome: WriteOutcome) => void;
}

/**
 * The engine: one read path, one write path.
 *
 * Every document write in the product — local API, REST, the panel, a job,
 * the scheduler — goes through `runWrite`. That is a deliberate constraint
 * rather than tidiness: hooks, the outbox, the activity log and the future
 * versions plugin all attach at one point, and a second write path would be a
 * second place for each of them to be forgotten (stage 3).
 */
export class CmsEngine {
  private cms: CmsInstance | undefined;
  private readonly pipelines = new Map<string, CollectionHookPipeline>();
  /** Collections and globals by name, for relation targets. */
  private readonly byName: Record<string, ResolvedCollection>;
  /** The same by storage slug: a stored row knows its slug, not its name. */
  private readonly bySlug: Record<string, ResolvedCollection>;
  /**
   * Which collections can point at a file at all.
   *
   * Answered once per collection, because the alternative is three extra
   * queries on every write to a collection that has no images — which is most
   * of them.
   */
  private readonly media = new Map<string, boolean>();
  private outbox: Outbox | undefined;
  private delivery: Promise<void> = Promise.resolve();

  constructor(private readonly options: EngineOptions) {
    this.byName = { ...options.config.collections, ...options.config.globals };
    this.bySlug = Object.fromEntries(
      Object.values(this.byName).map((entry) => [entry.slug, entry]),
    );
  }

  /**
   * Hands the engine the instance hooks receive as `ctx.cms`.
   *
   * Separate from the constructor because the two refer to each other: the
   * instance exposes `api`, and `api` has to be able to call back into the
   * instance with access control enforced.
   */
  bind(cms: CmsInstance): void {
    this.cms = cms;
  }

  /** `cms.api`, built once: one entry per declared collection. */
  buildApi(): Record<string, CollectionApi<JsonObject>> {
    const api: Record<string, CollectionApi<JsonObject>> = {};
    for (const collection of Object.values(this.options.config.collections)) {
      api[collection.name] = this.collectionApi(collection);
    }
    return api;
  }

  /** `cms.globals`: the same machinery, one row, no `find` and no `create`. */
  buildGlobals(): Record<string, GlobalApi<JsonObject>> {
    const globals: Record<string, GlobalApi<JsonObject>> = {};
    for (const global of Object.values(this.options.config.globals)) {
      globals[global.name] = this.globalApi(global);
    }
    return globals;
  }

  /** `cms.trash`: deleted documents across every collection at once. */
  buildTrash(): CmsTrash {
    return {
      list: async (args: TrashListArgs = {}) => {
        const adapter = await this.options.database();
        return listTrashed({
          adapter,
          config: this.options.config,
          collections: this.byName,
          args,
        });
      },
      restore: (args: TrashTargetArgs) =>
        this.restore(this.requireCollection(args.collection), {
          ...args,
          id: args.id,
        }),
      purge: (args: TrashTargetArgs) =>
        this.purge(this.requireCollection(args.collection), {
          ...args,
          id: args.id,
        }),
    };
  }

  /** `cms.jobs`: the sweeps. Returned concrete so media can register its own. */
  buildJobs(): JobRunner {
    return new JobRunner({
      config: this.options.config,
      database: () => this.options.database(),
      applyScheduled: (row) => this.applyScheduled(row),
      purgeExpired: (row) => this.purgeExpired(row),
      recordFailure: (type, payload, error) =>
        this.recordFailure(type, payload, error),
    });
  }

  /**
   * Delivers everything the outbox owes.
   *
   * A commit already schedules a delivery in the background; this is how a
   * caller waits for it — a test, a CLI, or a serverless runtime that is
   * about to freeze the process. Returns what this call delivered, which may
   * be zero because the background pass got there first.
   */
  async drainEvents(limit?: number): Promise<number> {
    await this.delivery;
    const outbox = await this.outboxWorker();
    return outbox.drain(limit);
  }

  /** Waits for in-flight deliveries. Called by `cms.close()`. */
  async settle(): Promise<void> {
    await this.delivery;
  }

  /**
   * Writes events for an operation that is not a document write.
   *
   * Auth is the first caller: an invitation or a role change has to reach a
   * webhook the same way a document change does — inside the transaction that
   * caused it, delivered after the commit — and giving it a second mechanism
   * would give it a second set of failure modes (section 5).
   */
  async appendEvents(
    tx: Tx,
    events: BufferedEvent[],
    meta: OutboxEntryMeta,
  ): Promise<void> {
    const outbox = await this.outboxWorker();
    await outbox.append(tx, events, meta);
  }

  /** Delivers what the last committed transaction queued, in the background. */
  deliverSoon(): void {
    this.scheduleDelivery();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private collectionApi(
    collection: ResolvedCollection,
  ): CollectionApi<JsonObject> {
    return {
      find: (args) => this.find(collection, args),
      findOne: (args) => this.findOne(collection, args),
      findById: (id, args) => this.findById(collection, id, args),
      count: (args) => this.count(collection, args),
      create: (args) => this.create(collection, args),
      update: (args) => this.update(collection, args),
      delete: (args) => this.remove(collection, args),
      restore: (args) => this.restore(collection, args),
      purge: (args) => this.purge(collection, args),
      schedule: (args) => this.schedule(collection, args),
      unschedule: (args) => this.unschedule(collection, args),
      resolveSlug: (slug, args) => this.resolveSlug(collection, slug, args),
      previousSlugs: (args) => this.previousSlugs(collection, args),
      addPreviousSlug: (args) =>
        this.changePreviousSlug(collection, args, "add"),
      removePreviousSlug: (args) =>
        this.changePreviousSlug(collection, args, "remove"),
    };
  }

  // -------------------------------------------------------------------------
  // Slugs
  // -------------------------------------------------------------------------

  /**
   * The slug field a slug operation is about: the one named, or the
   * collection's first — with `history`, when the operation needs one.
   */
  private slugField(
    collection: ResolvedCollection,
    requested: string | undefined,
    needsHistory: boolean,
  ): string {
    const fields = slugFields(collection).filter(
      ([, field]) => !needsHistory || slugOptions(field).history === true,
    );
    const name =
      requested === undefined
        ? fields[0]?.[0]
        : fields.find(([candidate]) => candidate === requested)?.[0];
    if (name === undefined) {
      throw CmsError.validation(
        requested === undefined
          ? `${collection.name} has no slug field${needsHistory ? " with history" : ""}`
          : `${collection.name}.${requested} is not a slug field${needsHistory ? " with history" : ""}`,
      );
    }
    return name;
  }

  private async resolveSlug(
    collection: ResolvedCollection,
    slug: string,
    args: ResolveSlugArgs = {},
  ): Promise<SlugResolution<JsonObject> | null> {
    const field = this.slugField(collection, args.field, false);
    const locale = localeContext(this.options.config, args);
    const adapter = await this.options.database();
    const candidates = await adapter.transaction((tx) =>
      slugCandidates({
        db: scopedDb(adapter, tx),
        collection,
        field,
        slug,
        locale: locale.locale,
        locales: this.options.config.i18n.locales,
      }),
    );

    const { field: _field, ...read } = args;
    for (const candidate of candidates) {
      // Read with the caller's access: a slug of a document this actor may
      // not see resolves to nothing, exactly like a missing one.
      const document = await this.findById(collection, candidate.id, read);
      if (!document) continue;
      return {
        id: candidate.id,
        field,
        locale: candidate.locale,
        current: candidate.current,
        document,
      };
    }
    return null;
  }

  private async previousSlugs(
    collection: ResolvedCollection,
    args: PreviousSlugsArgs,
  ): Promise<PreviousSlug[]> {
    const field = this.slugField(collection, args.field, true);
    const document = await this.findById(collection, args.id, {
      ...args,
      includeTrashed: true,
    });
    if (!document) throw CmsError.notFound(`No ${collection.name} with id "${args.id}"`); // prettier-ignore
    const definition = collection.fields[field];
    const adapter = await this.options.database();
    return adapter.transaction((tx) =>
      previousSlugRows({
        db: scopedDb(adapter, tx),
        collection,
        documentId: args.id,
        field,
        ...(args.locale === undefined
          ? {}
          : { locale: definition?.localized ? args.locale : null }),
      }),
    );
  }

  /**
   * Adds or removes one previous address, under the rules of an update to
   * the slug field: the actor must be allowed to update the document and to
   * write that field.
   */
  private async changePreviousSlug(
    collection: ResolvedCollection,
    args: PreviousSlugWriteArgs,
    change: "add" | "remove",
  ): Promise<PreviousSlug[]> {
    const field = this.slugField(collection, args.field, true);
    const definition = collection.fields[field] as FieldDefinition;
    const locale = localeContext(this.options.config, args);
    const actor = args.actor ?? null;
    const scopeLocale = definition.localized ? locale.locale : "";
    const slug = change === "add" ? slugCleaner(definition)(args.slug) : args.slug; // prettier-ignore
    if (slug === "") {
      throw CmsError.validation(`"${args.slug}" has no letters or digits to make a slug from`); // prettier-ignore
    }

    const adapter = await this.options.database();
    await adapter.transaction(async (tx) => {
      const db = scopedDb(adapter, tx);
      const row = await this.load(adapter, tx, collection, args.id, {
        actor,
        operation: "update",
        locale,
        includeTrashed: false,
      });
      const previous = rowToDocument(row, collection, locale);
      await this.assertAllowed(collection, "update", actor, locale, previous);
      assertFieldWriteAccess(collection, { [field]: null }, actor, locale.locale, previous); // prettier-ignore

      const current = definition.localized
        ? asObject(asObject(row.data)[field])[locale.locale]
        : asObject(row.data)[field];
      if (change === "add") {
        if (current === slug) {
          throw CmsError.conflict(`"${slug}" is this document's slug already, not a previous one.`); // prettier-ignore
        }
        await assertFree({
          db,
          collection,
          documentId: String(row.id),
          field,
          locale: scopeLocale,
          slug,
        });
        await recordSlugMoves(
          db,
          collection,
          String(row.id),
          [
            {
              field,
              locale: scopeLocale,
              from: slug,
              to: String(current ?? ""),
            },
          ],
          new Date(),
        );
      } else {
        await removePreviousSlugRow(db, collection, String(row.id), field, scopeLocale, slug); // prettier-ignore
      }
    });

    return this.previousSlugs(collection, {
      id: args.id,
      field,
      ...(args.actor === undefined ? {} : { actor: args.actor }),
      ...(definition.localized ? { locale: locale.locale } : {}),
    });
  }

  private async find(
    collection: ResolvedCollection,
    args: FindArgs = {},
  ): Promise<FindResult<JsonObject>> {
    const adapter = await this.options.database();
    const locale = localeContext(this.options.config, args);
    const actor = args.actor ?? null;
    const granted = await accessFilter(collection, {
      actor,
      operation: "read",
      locale: locale.locale,
      rbac: this.options.config.rbac,
    });

    const base = this.scope(collection, args.where, granted, args.includeTrashed); // prettier-ignore
    const order = sortOrder(args.orderBy);
    const limit = clampLimit(args.limit);

    return adapter.transaction(async (tx) => {
      const rows = await adapter.query(tx, {
        table: documentsTableName,
        where: args.cursor ? and(base, cursorWhere(args.cursor, order)) : base,
        orderBy: order,
        // One row past the limit answers `hasNextPage` without a second
        // query; a COUNT only happens when the caller asks for the total.
        limit: limit + 1,
        ...(args.offset === undefined ? {} : { offset: args.offset }),
      });

      const hasNextPage = rows.length > limit;
      const page = rows.slice(0, limit);
      const docs = page.map((row) => rowToDocument(row, collection, locale));
      await this.expand(adapter, tx, docs, collection, locale, args, actor);
      // After the expansion, so a related document is filtered by its own
      // collection's rules rather than by the one that pointed at it.
      this.redact(docs, collection, actor, locale);

      let totalDocs: number | null = null;
      if (args.count === true) {
        const counted = await adapter.query(tx, {
          table: documentsTableName,
          where: base,
          count: true,
        });
        totalDocs = Number(counted[0]?.count ?? 0);
      }

      const last = page.at(-1);
      return {
        docs,
        limit,
        totalDocs,
        hasNextPage,
        cursor: last ? encodeCursor(last, order) : null,
      };
    });
  }

  private async findOne(
    collection: ResolvedCollection,
    args: FindOneArgs = {},
  ): Promise<JsonObject | null> {
    const page = await this.find(collection, { ...args, limit: 1 });
    return page.docs[0] ?? null;
  }

  private async findById(
    collection: ResolvedCollection,
    id: string,
    args: ReadArgs = {},
  ): Promise<JsonObject | null> {
    return this.findOne(collection, { ...args, where: eq("id", id) });
  }

  private async count(
    collection: ResolvedCollection,
    args: CountArgs = {},
  ): Promise<number> {
    const adapter = await this.options.database();
    const locale = localeContext(this.options.config, args);
    const granted = await accessFilter(collection, {
      actor: args.actor ?? null,
      operation: "read",
      locale: locale.locale,
      rbac: this.options.config.rbac,
    });
    const where = this.scope(collection, args.where, granted, args.includeTrashed); // prettier-ignore

    return adapter.transaction(async (tx) => {
      const rows = await adapter.query(tx, {
        table: documentsTableName,
        where,
        count: true,
      });
      return Number(rows[0]?.count ?? 0);
    });
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  private async create(
    collection: ResolvedCollection,
    args: CreateArgs<JsonObject>,
  ): Promise<JsonObject | null> {
    const locale = localeContext(this.options.config, args);
    const actor = args.actor ?? null;
    const input = { ...(args.data as JsonObject) };

    return this.runWrite({
      collection,
      intent: "create",
      actor,
      source: args.source ?? "local",
      locale,
      depth: args.depth,
      includeTrashed: args.includeTrashed,
      runId: args.runId,
      idempotencyKey: args.idempotencyKey,
      step: async ({ db, hooks, context }) => {
        await this.assertAllowed(collection, "create", actor, locale);
        // Against what the caller sent, before the hooks touch it: a hook is
        // server code, and refusing its edits on the actor's behalf would
        // make "fill in the slug" an unimplementable feature.
        assertFieldWriteAccess(collection, input, actor, locale.locale);

        const before = await runBeforeHooks(
          hooks.createBefore,
          { data: input },
          context,
          (current, data) => ({ ...current, data }),
        );
        if (before === false) return null;

        const id = args.id ?? createId("doc");
        // After the hooks, like validation: a hook that sets the title has
        // to be able to rely on the slug being made from it.
        const slugs = await prepareSlugs({
          db,
          collection,
          input: before.data,
          stored: null,
          locale: locale.locale,
          documentId: id,
        });
        const { data, touched } = toStoredData(collection, slugs.input, locale);
        // After the hooks, never before: the documented way to fill a
        // required field is a `before` hook, so validating first would make
        // the slug example in section 5 impossible.
        validateFields(
          collection,
          data,
          locale,
          Object.keys(collection.fields),
        );

        const now = new Date();
        const row = await db.insert(documentsTableName, {
          // An explicit id is how an import keeps the references other
          // documents hold (stage 10). A clash is the primary key's error to
          // raise, not something this checks first and then races against.
          id,
          collection: collection.slug,
          data,
          created_at: now,
          updated_at: now,
          updated_by: actor?.id ?? null,
          deleted_at: null,
          purge_after: null,
          scheduled_at: null,
          scheduled_patch: null,
          revision: 1,
        });

        return {
          doc: rowToDocument(row, collection, locale),
          previous: null,
          changed: touched,
          stored: data,
        };
      },
    });
  }

  private async update(
    collection: ResolvedCollection,
    args: UpdateArgs<JsonObject>,
    emit?: (events: EventBuffer, outcome: WriteOutcome) => void,
  ): Promise<JsonObject | null> {
    const locale = localeContext(this.options.config, args);
    const actor = args.actor ?? null;
    const patch = { ...(args.data as JsonObject) };

    return this.runWrite({
      collection,
      intent: "update",
      actor,
      source: args.source ?? "local",
      locale,
      depth: args.depth,
      includeTrashed: args.includeTrashed,
      runId: args.runId,
      idempotencyKey: args.idempotencyKey,
      ...(emit === undefined ? {} : { emit }),
      step: async ({ adapter, tx, db, hooks, context }) => {
        const row = await this.load(adapter, tx, collection, args.id, {
          actor,
          operation: "update",
          locale,
          includeTrashed: args.includeTrashed,
        });
        // Before access control and before the hooks: a stale write is not a
        // write the hooks should see, and running them would charge a `before`
        // hook's side effects to an operation that is about to be refused.
        assertRevision(args.expectedRevision, row);
        const previous = rowToDocument(row, collection, locale);
        // Evaluated a second time, now that the row exists: a rule like
        // `record.authorId === actor.id` cannot be expressed as a filter, and
        // a rule that can was already applied to the lookup above.
        await this.assertAllowed(collection, "update", actor, locale, previous);
        // This is where "a writer cannot publish" happens: `status` is an
        // ordinary field, so the question is who may write it (section 11).
        assertFieldWriteAccess(collection, patch, actor, locale.locale, previous); // prettier-ignore

        const before = await runBeforeHooks(
          hooks.updateBefore,
          { data: patch, previous },
          context,
          (current, data) => ({ ...current, data }),
        );
        if (before === false) return null;

        const slugs = await prepareSlugs({
          db,
          collection,
          input: before.data,
          stored: asObject(row.data),
          locale: locale.locale,
          documentId: String(row.id),
        });
        const { data, touched } = toStoredData(
          collection,
          slugs.input,
          locale,
          asObject(row.data),
        );
        // Only what this write touched: a localized field is required per
        // locale, so demanding every translation would make a partial one
        // impossible (section 9).
        validateFields(collection, data, locale, touched);

        const now = new Date();
        const updated = await this.patch(
          adapter,
          tx,
          row,
          { data, updated_at: now, updated_by: actor?.id ?? null },
          args.expectedRevision,
        );
        const doc = rowToDocument(updated, collection, locale);

        return {
          doc,
          previous,
          changed: changedFields(collection, previous, doc),
          stored: data,
          slugMoves: slugs.moves,
        };
      },
    });
  }

  /**
   * The delete an editor performs.
   *
   * With the trash on it is a soft delete and the row keeps serving every
   * query that asks for `includeTrashed`; with it off, or with
   * `permanent: true`, the row goes. Either way the `delete` hooks run here
   * and only here: the document is leaving the live set, which is the moment
   * a hook was written for. A later purge does not run them again, because a
   * hook that decrements a counter must not decrement it twice for one
   * document.
   */
  private async remove(
    collection: ResolvedCollection,
    args: DeleteArgs,
  ): Promise<JsonObject | null> {
    const trash = this.options.config.trash;
    if (!trash.enabled || args.permanent === true) {
      return this.purge(collection, args);
    }

    const locale = localeContext(this.options.config, args);
    const actor = args.actor ?? null;

    return this.runWrite({
      collection,
      intent: "trash",
      actor,
      source: args.source ?? "local",
      locale,
      depth: args.depth,
      includeTrashed: true,
      runId: args.runId,
      idempotencyKey: args.idempotencyKey,
      step: async ({ adapter, tx, hooks, context }) => {
        // Not `includeTrashed`: deleting what is already deleted is a purge,
        // and asking for one has to be explicit.
        const row = await this.load(adapter, tx, collection, args.id, {
          actor,
          operation: "delete",
          locale,
          includeTrashed: false,
        });
        assertRevision(args.expectedRevision, row);
        const doc = rowToDocument(row, collection, locale);
        await this.assertAllowed(collection, "delete", actor, locale, doc);

        const before = await runBeforeHooks(
          hooks.deleteBefore,
          doc,
          context,
          (_current, data) => data,
        );
        if (before === false) return null;

        const now = new Date();
        // A scheduled change on a trashed document is cancelled rather than
        // carried: restoring a document should not detonate a publish that
        // was due while it sat in the trash.
        const updated = await this.patch(adapter, tx, row, {
          deleted_at: now,
          purge_after: this.purgeAt(now),
          scheduled_at: null,
          scheduled_patch: null,
          updated_at: now,
          updated_by: actor?.id ?? null,
        });

        return {
          doc: rowToDocument(updated, collection, locale),
          previous: before,
          changed: [],
        };
      },
    });
  }

  private async restore(
    collection: ResolvedCollection,
    args: RestoreArgs,
  ): Promise<JsonObject | null> {
    const locale = localeContext(this.options.config, args);
    const actor = args.actor ?? null;

    return this.runWrite({
      collection,
      intent: "restore",
      actor,
      source: args.source ?? "local",
      locale,
      depth: args.depth,
      includeTrashed: true,
      runId: args.runId,
      idempotencyKey: args.idempotencyKey,
      step: async ({ adapter, tx }) => {
        const row = await this.load(adapter, tx, collection, args.id, {
          actor,
          operation: "restore",
          locale,
          includeTrashed: true,
        });
        assertRevision(args.expectedRevision, row);
        if (row.deleted_at === null || row.deleted_at === undefined) {
          throw CmsError.conflict(
            `${collection.name} "${args.id}" is not in the trash`,
          );
        }
        const previous = rowToDocument(row, collection, locale);
        await this.assertAllowed(
          collection,
          "restore",
          actor,
          locale,
          previous,
        );

        const now = new Date();
        const updated = await this.patch(adapter, tx, row, {
          deleted_at: null,
          purge_after: null,
          updated_at: now,
          updated_by: actor?.id ?? null,
        });

        return {
          doc: rowToDocument(updated, collection, locale),
          previous,
          changed: [],
          // There is no `restore` hook family and inventing one would mean a
          // fourth moment to document. A restore is observable as an event,
          // which is what a consumer actually wants from it.
          after: false,
        };
      },
    });
  }

  /**
   * The permanent delete.
   *
   * Also the only operation that cleans up what pointed at the document:
   * media usages survive the trash on purpose — an image used by a document
   * an editor may still restore is not unused — so this is where they stop
   * (section 6).
   */
  private async purge(
    collection: ResolvedCollection,
    args: DeleteArgs,
    options: { retention?: boolean } = {},
  ): Promise<JsonObject | null> {
    const locale = localeContext(this.options.config, args);
    const actor = args.actor ?? null;

    return this.runWrite({
      collection,
      intent: "purge",
      actor,
      source: args.source ?? "local",
      locale,
      depth: args.depth,
      includeTrashed: true,
      step: async ({ adapter, tx, db, hooks, context }) => {
        const row = await this.load(adapter, tx, collection, args.id, {
          actor,
          operation: "purge",
          locale,
          includeTrashed: true,
          // The retention sweep is not a caller: it is the engine carrying out
          // `trash.purgeAfter`, which the configuration already decided and a
          // human already triggered by deleting the document. Asking it for a
          // `purge` permission it has no way to hold would mean retention
          // silently stops working the day `rbac` is added.
          bypassAccess: options.retention === true,
        });
        const doc = rowToDocument(row, collection, locale);
        const trashed = row.deleted_at !== null && row.deleted_at !== undefined;
        if (options.retention !== true) {
          await this.assertAllowed(
            collection,
            trashed ? "purge" : "delete",
            actor,
            locale,
            doc,
          );
        }

        // Already in the trash means the `delete` hooks ran when it went
        // there; running them again on the way out would double every side
        // effect they have.
        const before = trashed
          ? doc
          : await runBeforeHooks(
              hooks.deleteBefore,
              doc,
              context,
              (_current, data) => data,
            );
        if (before === false) return null;

        await db.delete(documentsTableName, eq("id", String(row.id)));

        return {
          doc: before,
          previous: before,
          changed: [],
          after: !trashed,
          // The usage rows go with it, and whatever they pointed at is
          // re-examined: a picture whose last document just ceased to exist
          // has lost its last reference like any other.
          releaseMedia: true,
        };
      },
    });
  }

  /**
   * Records a change to apply later.
   *
   * The patch is checked now — access, field-level write access, validation —
   * and applied later as an ordinary update, so the question "may this person
   * schedule a publication" is answered by the same rules that answer "may
   * this person publish". The alternative, checking only at apply time, would
   * accept a schedule in the panel and fail silently on a Friday night.
   */
  private async schedule(
    collection: ResolvedCollection,
    args: ScheduleArgs<JsonObject>,
  ): Promise<JsonObject | null> {
    const locale = localeContext(this.options.config, args);
    const actor = args.actor ?? null;
    const at = parseWhen(args.at);
    const data = { ...(args.data as JsonObject) };

    if (Object.keys(data).length === 0) {
      throw CmsError.validation("A scheduled change needs at least one field.");
    }

    return this.runWrite({
      collection,
      intent: "schedule",
      actor,
      source: args.source ?? "local",
      locale,
      depth: args.depth,
      includeTrashed: false,
      step: async ({ adapter, tx }) => {
        const row = await this.load(adapter, tx, collection, args.id, {
          actor,
          operation: "update",
          locale,
          includeTrashed: false,
        });
        const previous = rowToDocument(row, collection, locale);
        await this.assertAllowed(collection, "update", actor, locale, previous);
        assertFieldWriteAccess(
          collection,
          data,
          actor,
          locale.locale,
          previous,
        );

        // Validated against the document as it stands today. It can still
        // fail on Friday if something else changed in the meantime, and that
        // failure is recorded in `jobs` rather than swallowed.
        const merged = toStoredData(collection, data, locale, asObject(row.data)); // prettier-ignore
        validateFields(collection, merged.data, locale, merged.touched);

        const now = new Date();
        const updated = await this.patch(adapter, tx, row, {
          scheduled_at: at,
          scheduled_patch: {
            data,
            locale: locale.locale,
            // The authority the change will carry. A scheduled publication
            // outlives the session that scheduled it, and re-deriving the
            // permissions on Friday would make a routine role change silently
            // cancel work an editor believed was done.
            actor: actor === null ? null : { ...actor },
          },
          updated_at: now,
          updated_by: actor?.id ?? null,
        });

        return {
          doc: rowToDocument(updated, collection, locale),
          previous,
          changed: [],
          after: false,
        };
      },
    });
  }

  private async unschedule(
    collection: ResolvedCollection,
    args: UnscheduleArgs,
  ): Promise<JsonObject | null> {
    const locale = localeContext(this.options.config, args);
    const actor = args.actor ?? null;

    return this.runWrite({
      collection,
      intent: "unschedule",
      actor,
      source: args.source ?? "local",
      locale,
      depth: args.depth,
      includeTrashed: false,
      step: async ({ adapter, tx }) => {
        const row = await this.load(adapter, tx, collection, args.id, {
          actor,
          operation: "update",
          locale,
          includeTrashed: false,
        });
        if (row.scheduled_at === null || row.scheduled_at === undefined) {
          throw CmsError.conflict(
            `${collection.name} "${args.id}" has nothing scheduled`,
          );
        }
        const previous = rowToDocument(row, collection, locale);
        await this.assertAllowed(collection, "update", actor, locale, previous);

        const now = new Date();
        const updated = await this.patch(adapter, tx, row, {
          scheduled_at: null,
          scheduled_patch: null,
          updated_at: now,
          updated_by: actor?.id ?? null,
        });

        return {
          doc: rowToDocument(updated, collection, locale),
          previous,
          changed: [],
          after: false,
        };
      },
    });
  }

  // -------------------------------------------------------------------------
  // Globals
  // -------------------------------------------------------------------------

  private globalApi(global: ResolvedCollection): GlobalApi<JsonObject> {
    return {
      get: (args) => this.globalGet(global, args),
      update: async (args) => {
        const id = await this.ensureGlobalRow(global, args);
        return this.update(global, { ...args, id });
      },
      schedule: async (args: GlobalScheduleArgs<JsonObject>) => {
        const id = await this.ensureGlobalRow(global, args);
        return this.schedule(global, { ...args, id });
      },
      unschedule: async (args: OperationArgs = {}) =>
        this.unschedule(global, { ...args, id: globalRowId(global) }),
    };
  }

  /**
   * A global that nobody has saved yet reads as its defaults.
   *
   * No row is written: a read that writes cannot run on a replica, cannot run
   * in a Worker that only has a read binding, and turns an anonymous page view
   * into a database mutation.
   */
  private async globalGet(
    global: ResolvedCollection,
    args: ReadArgs = {},
  ): Promise<JsonObject> {
    const adapter = await this.options.database();
    const locale = localeContext(this.options.config, args);
    const actor = args.actor ?? null;
    const granted = await accessFilter(global, {
      actor,
      operation: "read",
      locale: locale.locale,
      rbac: this.options.config.rbac,
    });

    return adapter.transaction(async (tx) => {
      const rows = await adapter.query(tx, {
        table: documentsTableName,
        where: this.scope(
          global,
          eq("id", globalRowId(global)),
          granted,
          false,
        ),
        limit: 1,
      });
      const row = rows[0] ?? this.emptyGlobalRow(global, locale, null);
      const document = rowToDocument(row, global, locale);
      await this.expand(adapter, tx, [document], global, locale, args, actor);
      this.redact([document], global, actor, locale);
      return document;
    });
  }

  /**
   * Makes sure the singleton has a row, and reports its id.
   *
   * The id is derived from the slug rather than generated, which is what makes
   * this safe to call concurrently: two first saves race to insert the same
   * primary key, one of them loses, and losing means the row it wanted is
   * already there.
   */
  private async ensureGlobalRow(
    global: ResolvedCollection,
    args: { locale?: string; fallbackLocale?: string | false; actor?: Actor | null }, // prettier-ignore
  ): Promise<string> {
    const adapter = await this.options.database();
    const locale = localeContext(this.options.config, args);
    const id = globalRowId(global);

    const exists = await adapter.transaction(async (tx) => {
      const rows = await adapter.query(tx, {
        table: documentsTableName,
        where: eq("id", id),
        limit: 1,
      });
      return rows.length > 0;
    });
    if (exists) return id;

    try {
      await adapter.transaction((tx) =>
        adapter.mutate(tx, {
          kind: "insert",
          table: documentsTableName,
          returning: false,
          values: this.emptyGlobalRow(global, locale, new Date()),
        }),
      );
    } catch (error) {
      const present = await adapter.transaction(async (tx) => {
        const rows = await adapter.query(tx, {
          table: documentsTableName,
          where: eq("id", id),
          limit: 1,
        });
        return rows.length > 0;
      });
      if (!present) throw error;
    }
    return id;
  }

  /**
   * The defaults row: what a global is before anybody saves it.
   *
   * `created` is `null` for the copy `get()` invents and a date for the copy
   * that is actually inserted. A global nobody has saved has no creation time,
   * and inventing one would make "has this ever been configured" unanswerable.
   */
  private emptyGlobalRow(
    global: ResolvedCollection,
    locale: LocaleContext,
    created: Date | null,
  ): Row {
    const { data } = toStoredData(global, {}, locale);
    return {
      id: globalRowId(global),
      collection: global.slug,
      data,
      created_at: created,
      updated_at: created,
      updated_by: null,
      deleted_at: null,
      purge_after: null,
      scheduled_at: null,
      scheduled_patch: null,
      // A global nobody has saved is still at revision 1: `get()` hands it
      // back, so the panel has a precondition to send with the first save.
      revision: 1,
    };
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  /**
   * Applies one due scheduled change, as an ordinary update.
   *
   * Claim first, then write. The claim is a conditional update — the same
   * portable trick the outbox uses — so two overlapping cron invocations
   * cannot both apply the same patch, on any of the three engines and without
   * a lock.
   */
  private async applyScheduled(row: Row): Promise<void> {
    const collection = this.bySlug[String(row.collection)];
    const patch = scheduledPatch(row);
    const at = row.scheduled_at;

    if (!collection || !patch || !(at instanceof Date)) {
      // A row the configuration no longer describes, or a patch written by a
      // version that is gone. Clearing it is the only thing that will not
      // wedge the sweep behind it forever.
      await this.clearSchedule(String(row.id));
      return;
    }

    const adapter = await this.options.database();
    const claimed = await adapter.transaction((tx) =>
      adapter.mutate(tx, {
        kind: "update",
        table: documentsTableName,
        where: and(eq("id", String(row.id)), eq("scheduled_at", at)),
        set: { scheduled_at: null, scheduled_patch: null },
        returning: false,
      }),
    );
    if (claimed.count !== 1) return;

    // A failure from here is recorded by the runner, which still holds the row
    // this claim emptied and can therefore write the patch into the failure.
    // Recording it here as well would file one incident twice.
    await this.update(
      collection,
      {
        id: String(row.id),
        data: patch.data,
        locale: patch.locale,
        actor: patch.actor,
        source: "job",
      },
      (events, outcome) => {
        events.emit("document.schedule.applied", {
          collection: collection.name,
          documentId: String(outcome.doc.id),
          locale: patch.locale,
          scheduledFor: at.toISOString(),
          patch: patch.data,
        });
      },
    );
  }

  /** Purges one expired trash entry, as the system rather than as a person. */
  private async purgeExpired(row: Row): Promise<void> {
    const collection = this.bySlug[String(row.collection)];
    if (!collection) {
      // The collection was removed from the configuration while the document
      // sat in the trash. Nothing can describe it any more, so nothing can
      // restore it either.
      const adapter = await this.options.database();
      await adapter.transaction(async (tx) => {
        const db = scopedDb(adapter, tx);
        await db.delete(mediaUsagesTable, eq("document_id", String(row.id)));
        await db.delete(documentsTableName, eq("id", String(row.id)));
      });
      return;
    }
    await this.purge(
      collection,
      { id: String(row.id), actor: null, source: "job", includeTrashed: true },
      { retention: true },
    );
  }

  private async clearSchedule(id: string): Promise<void> {
    const adapter = await this.options.database();
    await adapter.transaction((tx) =>
      adapter.mutate(tx, {
        kind: "update",
        table: documentsTableName,
        where: eq("id", id),
        set: { scheduled_at: null, scheduled_patch: null },
        returning: false,
      }),
    );
  }

  /**
   * Records a failed job item and tells the world about it.
   *
   * In the `jobs` table rather than only in a log: `job.failed` is in the
   * event catalogue (section 7) because an operator has to be able to be
   * paged for it, and a payload that only exists in stdout cannot be retried.
   */
  private async recordFailure(
    type: string,
    payload: JsonObject,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const adapter = await this.options.database();
    const now = new Date();

    await adapter.transaction(async (tx) => {
      const db = scopedDb(adapter, tx);
      await db.insert("jobs", {
        id: createOrderedId("job"),
        type,
        payload,
        status: "failed",
        run_at: now,
        attempts: 1,
        locked_at: null,
        locked_by: null,
        completed_at: null,
        error: message,
        created_at: now,
      });
      await this.appendEvents(
        tx,
        [
          {
            type: "job.failed",
            data: { job: type, error: message, ...payload },
            previous: null,
          },
        ],
        { actor: null },
      );
    });
    this.scheduleDelivery();
  }

  // -------------------------------------------------------------------------
  // The one write path
  // -------------------------------------------------------------------------

  /**
   * The one place a document is written.
   *
   * Transaction, hooks, events, activity — in that order, every time. The
   * operation-specific part is the `step` callback and nothing else, which is
   * what makes the later versions plugin a single attachment point rather
   * than three (stage 3, section 4).
   */
  private async runWrite(request: WriteRequest): Promise<JsonObject | null> {
    const adapter = await this.options.database();
    const outbox = await this.outboxWorker();
    const hooks = this.pipeline(request.collection.name);
    const events = new EventBuffer();

    const outcome = await adapter.transaction(async (tx) => {
      const db = scopedDb(adapter, tx);
      // Before anything else, and inside the transaction that will record it:
      // a client retrying a dropped request must not run the hooks, the
      // outbox and the activity entry a second time.
      const replayed = await this.replay(db, request);
      if (replayed) return replayed;

      const context: HookContext = {
        actor: request.actor,
        collection: request.collection.name,
        operation: hookFamily[request.intent],
        locale: request.locale.locale,
        tx,
        db,
        cms: this.instance(),
        events,
        source: request.source,
        // One object for the whole operation, so a `before` hook can leave a
        // note for the `after` hook that follows it.
        meta: {},
      };

      const result = await request.step({ adapter, tx, db, hooks, context });
      if (result === null) return null;

      this.emitDocumentEvents(events, request, result);
      // After the document's own events, so a subscriber hears what happened
      // before it hears what that cost. Inside the transaction, because this
      // is the one moment the truth about what a document references changes:
      // a rolled back save must not leave a file looking unused (section 6).
      await this.syncMedia(db, request, result, events);
      await this.syncSlugs(db, request, result);
      request.emit?.(events, result);
      // Flushed immediately after the write rather than at the end of the
      // transaction: when the engine has no real transactions (standalone
      // MongoDB, D1), this is what keeps the event in the same operation
      // sequence as the document it describes (section 12).
      await outbox.append(tx, events.take(), this.outboxMeta(request, result));

      if (result.after !== false) {
        await this.runAfter(hooks, request, result, context);
      }
      await outbox.append(tx, events.take(), this.outboxMeta(request, result));

      await this.writeActivity(db, request, result);
      await this.recordIdempotency(db, request, result);
      await this.expand(
        adapter,
        tx,
        [result.doc],
        request.collection,
        request.locale,
        request,
        request.actor,
      );
      return result;
    });

    if (!outcome) return null;
    if (!("replayed" in outcome)) this.scheduleDelivery();
    // Last, so hooks, the activity log and the events saw the whole document
    // and only the caller is handed the redacted one.
    this.redact([outcome.doc], request.collection, request.actor, request.locale); // prettier-ignore
    return outcome.doc;
  }

  /**
   * The answer a repeated write already has.
   *
   * Only consulted when the caller supplied a key, so an ordinary save pays
   * nothing for it. The stored document is returned verbatim: re-reading the
   * row would describe the world now rather than what this call did, and a
   * retry that reports somebody else's later edit as its own result is worse
   * than no idempotency at all.
   */
  private async replay(
    db: ScopedDb,
    request: WriteRequest,
  ): Promise<(WriteOutcome & { replayed: true }) | null> {
    const key = request.idempotencyKey;
    if (key === undefined) return null;
    const row = await db.findOne(aiMutationsTable, eq("idempotency_key", key));
    if (!row) return null;
    const stored = asObject(row.result);
    return {
      doc: stored,
      previous: null,
      changed: [],
      replayed: true,
    };
  }

  private async recordIdempotency(
    db: ScopedDb,
    request: WriteRequest,
    outcome: WriteOutcome,
  ): Promise<void> {
    const key = request.idempotencyKey;
    if (key === undefined) return;
    await db.insert(aiMutationsTable, {
      id: createId("aim"),
      idempotency_key: key,
      run_id: request.runId ?? "",
      collection: request.collection.name,
      document_id: String(outcome.doc.id),
      result: outcome.doc,
      created_at: new Date(),
    });
  }

  private async runAfter(
    hooks: CollectionHookPipeline,
    request: WriteRequest,
    outcome: WriteOutcome,
    context: HookContext,
  ): Promise<void> {
    const family = hookFamily[request.intent];
    if (family === "create") {
      await runAfterHooks(hooks.createAfter, outcome.doc, context);
      return;
    }
    if (family === "update") {
      await runAfterHooks(
        hooks.updateAfter,
        { doc: outcome.doc, previous: outcome.previous as JsonObject },
        context,
      );
      return;
    }
    await runAfterHooks(hooks.deleteAfter, outcome.doc, context);
  }

  /**
   * The events the engine itself owes, in the order a consumer expects them.
   *
   * `document.field.changed` is one event per field that actually changed,
   * which is what makes "tell me when `status` becomes `published`" a
   * subscription rather than a diff the consumer has to compute (section 7).
   */
  private emitDocumentEvents(
    events: EventBuffer,
    request: WriteRequest,
    outcome: WriteOutcome,
  ): void {
    const payload = (document: JsonObject): JsonObject => ({
      collection: request.collection.name,
      documentId: String(outcome.doc.id),
      locale: request.locale.locale,
      document: clone(document),
    });

    switch (request.intent) {
      case "create": {
        events.emit("document.created", payload(outcome.doc), null);
        return;
      }
      case "trash": {
        events.emit(
          "document.trashed",
          {
            ...payload(outcome.doc),
            // When the file disappears for good, so a subscriber can say
            // "recoverable until" rather than "deleted".
            purgeAfter: outcome.doc.purgeAfter ?? null,
          },
          null,
        );
        return;
      }
      case "restore": {
        events.emit("document.restored", payload(outcome.doc), null);
        return;
      }
      case "purge": {
        events.emit("document.purged", payload(outcome.doc), null);
        return;
      }
      case "schedule": {
        events.emit(
          "document.scheduled",
          {
            ...payload(outcome.doc),
            scheduledAt: outcome.doc.scheduledAt ?? null,
            patch: clone(outcome.doc.scheduledPatch ?? null),
          },
          null,
        );
        return;
      }
      case "unschedule": {
        events.emit(
          "document.schedule.cancelled",
          {
            ...payload(outcome.doc),
            scheduledAt: (outcome.previous as JsonObject | null)?.scheduledAt ?? null, // prettier-ignore
          },
          null,
        );
        return;
      }
      case "update":
        // Below, because it is the only intent that also emits per field.
        break;
    }

    const previous = outcome.previous as JsonObject;
    events.emit("document.updated", payload(outcome.doc), payload(previous));
    for (const field of outcome.changed) {
      events.emit(
        "document.field.changed",
        {
          collection: request.collection.name,
          documentId: String(outcome.doc.id),
          locale: request.locale.locale,
          field,
          value: clone(outcome.doc[field] ?? null),
        },
        { field, value: clone(previous[field] ?? null) },
      );
    }
  }

  /**
   * Keeps `media_usages` in step with what the document now contains.
   *
   * This is the whole of the media lifecycle's accounting. Nothing counts
   * references at read time or at delete time; the count is maintained here,
   * once, and `media-gc` only ever acts on what it says.
   */
  private async syncMedia(
    db: ScopedDb,
    request: WriteRequest,
    outcome: WriteOutcome,
    events: EventBuffer,
  ): Promise<void> {
    const uploads = this.options.config.uploads;
    const releasing = outcome.releaseMedia === true;
    // No stored body means the operation did not touch the content: a trash,
    // a restore, a schedule. Recounting from nothing would read as "this
    // document references no files" and orphan every picture on a page an
    // editor can still bring back (stage 5).
    if (!releasing && outcome.stored === undefined) return;
    if (!releasing && !this.referencesMedia(request.collection)) return;

    const result = await syncMediaUsages({
      db,
      collection: request.collection.name,
      documentId: String(outcome.doc.id),
      references: releasing
        ? null
        : collectMediaReferences(request.collection, outcome.stored ?? {}),
      // Without an `uploads` section there is no storage behind these rows,
      // so they are maintained — the trash and the purge depend on them — but
      // nothing is orphaned and nothing is ever collected.
      lifecycle: uploads !== undefined,
      retention: uploads?.retention,
      now: new Date(),
    });

    const payload = (mediaId: string): JsonObject => ({
      mediaId,
      collection: request.collection.name,
      documentId: String(outcome.doc.id),
    });
    for (const mediaId of result.orphaned) {
      events.emit("media.orphaned", payload(mediaId));
    }
    for (const mediaId of result.reclaimed) {
      events.emit("media.reclaimed", payload(mediaId));
    }
  }

  /**
   * Keeps `slug_history` in step with the write, in its transaction: a
   * rolled back rename must not leave its old address behind as a redirect.
   */
  private async syncSlugs(
    db: ScopedDb,
    request: WriteRequest,
    outcome: WriteOutcome,
  ): Promise<void> {
    if (!this.keepsSlugHistory(request.collection)) return;
    const id = String(outcome.doc.id);
    if (outcome.releaseMedia === true) {
      // A purge: the document is gone, and so is every address it had.
      await releaseSlugs(db, request.collection, id);
      return;
    }
    if (outcome.slugMoves && outcome.slugMoves.length > 0) {
      await recordSlugMoves(db, request.collection, id, outcome.slugMoves, new Date()); // prettier-ignore
    }
  }

  private keepsSlugHistory(collection: ResolvedCollection): boolean {
    return slugFields(collection).some(
      ([, field]) => slugOptions(field).history === true,
    );
  }

  private referencesMedia(collection: ResolvedCollection): boolean {
    const known = this.media.get(collection.name);
    if (known !== undefined) return known;
    const answer = referencesMedia(collection);
    this.media.set(collection.name, answer);
    return answer;
  }

  /**
   * The activity log, written by the engine inside the transaction.
   *
   * Built in rather than a plugin (section 11): an audit trail that can be
   * switched off, or that commits separately from the change it describes, is
   * not an audit trail.
   */
  private async writeActivity(
    db: ScopedDb,
    request: WriteRequest,
    outcome: WriteOutcome,
  ): Promise<void> {
    await db.insert(activityTable, {
      // Ordered rather than random: an audit trail whose rows cannot be put
      // back in order is a list, not a trail, and two writes to the same
      // document routinely land in the same millisecond.
      id: createOrderedId("act"),
      actor_id: request.actor?.id ?? null,
      actor_source: request.actor?.source ?? null,
      action: activityAction(request.intent),
      // The actor is still the human; this is what typed it. An agent write
      // is attributable to the person who asked for it *and* recognisable as
      // an agent write, which are two different needs (section "Audyt").
      source: request.source,
      collection: request.collection.name,
      document_id: String(outcome.doc.id),
      locale: request.locale.locale,
      changes: {
        fields: outcome.changed,
        ...(request.runId === undefined ? {} : { runId: request.runId }),
      },
      ip: null,
      created_at: new Date(),
    });
  }

  // -------------------------------------------------------------------------
  // Shared pieces
  // -------------------------------------------------------------------------

  /** Collection, trash and access filters, combined the only legal way. */
  private scope(
    collection: ResolvedCollection,
    requested: Where | undefined,
    granted: Where | undefined,
    includeTrashed: boolean | undefined,
  ): Where {
    const conditions: Where[] = [eq("collection", collection.slug)];
    if (includeTrashed !== true) conditions.push(eq("deleted_at", null));
    if (requested) conditions.push(requested);
    if (granted) conditions.push(granted);
    return and(...conditions);
  }

  private async load(
    adapter: DatabaseAdapter,
    tx: Tx,
    collection: ResolvedCollection,
    id: string,
    options: {
      actor: Actor | null;
      operation: AccessOperation;
      locale: LocaleContext;
      includeTrashed: boolean | undefined;
      /** Only the retention sweep sets this; see `purge`. */
      bypassAccess?: boolean;
    },
  ): Promise<Row> {
    const granted =
      options.bypassAccess === true
        ? undefined
        : await accessFilter(collection, {
            actor: options.actor,
            operation: options.operation,
            locale: options.locale.locale,
            rbac: this.options.config.rbac,
          });
    const rows = await adapter.query(tx, {
      table: documentsTableName,
      where: this.scope(collection, eq("id", id), granted, options.includeTrashed), // prettier-ignore
      limit: 1,
    });
    const row = rows[0];
    if (!row) {
      // A row the actor may not touch reads as missing, not as forbidden:
      // "403" on a document you cannot see tells you it exists.
      throw CmsError.notFound(`No ${collection.name} with id "${id}"`);
    }
    return row;
  }

  /**
   * Writes system columns on one row and reports the row as it now stands.
   *
   * Also the one place `revision` moves. Every write that reaches here changed
   * the row, so every write bumps it — there is no "minor" update that a
   * concurrent editor would not want to know about, and a token that only
   * sometimes advances is a token nobody can rely on.
   *
   * `expected` turns the write into a compare-and-set. The comparison is in
   * the `WHERE` clause rather than in a read before it: two requests that both
   * read revision 17 must not both find it acceptable, and only the database
   * can decide which of them wins.
   */
  private async patch(
    adapter: DatabaseAdapter,
    tx: Tx,
    row: Row,
    set: Row,
    expected?: number | undefined,
  ): Promise<Row> {
    const current = toRevision(row.revision);
    const next = current + 1;
    const id = String(row.id);

    const result = await adapter.mutate(tx, {
      kind: "update",
      table: documentsTableName,
      where:
        expected === undefined
          ? eq("id", id)
          : and(eq("id", id), eq("revision", expected)),
      set: { ...set, revision: next },
    });

    if (expected !== undefined && result.count === 0) {
      throw revisionConflict(expected, current);
    }
    // An adapter that cannot return the updated row still has to produce one:
    // every caller builds the document it hands back from it.
    return result.rows[0] ?? { ...row, ...set, revision: next };
  }

  private async assertAllowed(
    collection: ResolvedCollection,
    operation: AccessOperation,
    actor: Actor | null,
    locale: LocaleContext,
    record?: JsonObject,
  ): Promise<void> {
    const filter = await accessFilter(collection, {
      actor,
      operation,
      locale: locale.locale,
      rbac: this.options.config.rbac,
      ...(record === undefined ? {} : { record }),
    });
    if (filter && operation === "create") {
      // There is no row to match a filter against yet, and silently allowing
      // the write would turn a restriction into a no-op.
      throw new CmsError(
        `access.create on "${collection.name}" returned a filter; a create has no row to filter. Return true or false.`,
        { status: 500, code: "invalid_access_rule" },
      );
    }
  }

  private requireCollection(name: string): ResolvedCollection {
    const collection = this.byName[name];
    if (!collection) {
      throw CmsError.notFound(`No collection named "${name}"`);
    }
    return collection;
  }

  /** When a document deleted now should be purged, or `null` if never. */
  private purgeAt(now: Date): Date | null {
    const retention = this.options.config.trash.purgeAfter;
    if (retention === false) return null;
    return new Date(now.getTime() + parseDuration(retention));
  }

  private async expand(
    adapter: DatabaseAdapter,
    tx: Tx,
    documents: JsonObject[],
    collection: ResolvedCollection,
    locale: LocaleContext,
    args: { depth?: number; includeTrashed?: boolean },
    actor: Actor | null,
  ): Promise<void> {
    if (!args.depth) return;
    const loader = new RelationLoader({
      adapter,
      tx,
      locale,
      actor,
      rbac: this.options.config.rbac,
      collections: this.byName,
      ...(args.includeTrashed === undefined
        ? {}
        : { includeTrashed: args.includeTrashed }),
    });
    await loader.expand(documents, collection, args.depth);
  }

  /**
   * Drops the fields this actor may not read.
   *
   * Skipped entirely when the collection declares no field rules, which is
   * the overwhelmingly common case and the difference between a check and a
   * cost.
   */
  private redact(
    documents: JsonObject[],
    collection: ResolvedCollection,
    actor: Actor | null,
    locale: LocaleContext,
  ): void {
    if (!hasFieldAccessRules(collection)) return;
    for (const document of documents) {
      applyFieldReadAccess(document, collection, actor, locale.locale);
    }
  }

  private pipeline(collection: string): CollectionHookPipeline {
    const existing = this.pipelines.get(collection);
    if (existing) return existing;
    const built = buildHookPipeline(this.options.config, collection);
    this.pipelines.set(collection, built);
    return built;
  }

  private outboxMeta(
    request: WriteRequest,
    outcome: WriteOutcome,
  ): { actor: Actor | null; collection: string; documentId: string } {
    return {
      actor: request.actor,
      collection: request.collection.name,
      documentId: String(outcome.doc.id),
    };
  }

  private async outboxWorker(): Promise<Outbox> {
    if (this.outbox) return this.outbox;
    const adapter = await this.options.database();
    this.outbox = new Outbox(adapter, this.options.dispatch);
    return this.outbox;
  }

  /**
   * Delivery after the commit, never during it.
   *
   * Chained rather than fired in parallel so events keep their order, and
   * swallowed because a failed delivery is the outbox's problem — it is
   * recorded, retried, and must not turn a successful write into a thrown
   * error (section 5).
   */
  private scheduleDelivery(): void {
    this.delivery = this.delivery
      .then(async () => {
        const outbox = await this.outboxWorker();
        await outbox.drain();
      })
      .catch(() => undefined);
  }

  private instance(): CmsInstance {
    if (!this.cms) {
      throw new CmsError("The engine was used before it was bound.", {
        status: 500,
        code: "engine_unbound",
      });
    }
    return this.cms;
  }
}

/**
 * A singleton's row id, derived from its slug.
 *
 * Deterministic because it has to be: the row is created on first save, and a
 * generated id would let two concurrent saves produce two rows for a document
 * the configuration says there is exactly one of.
 */
export function globalRowId(global: ResolvedCollection): string {
  return `glb_${global.slug}`;
}

/**
 * The sort, with a total order guaranteed.
 *
 * `id` is appended unless the caller already sorted by it: without a unique
 * tiebreaker two rows can compare equal, and a cursor built on an ambiguous
 * order skips or repeats rows.
 */
function sortOrder(requested: OrderBy[] | undefined): OrderBy[] {
  const order =
    requested && requested.length > 0
      ? [...requested]
      : [{ path: "updated_at", direction: "desc" as const }];
  if (!order.some((entry) => entry.path === "id")) {
    order.push({
      path: "id",
      direction: order[order.length - 1]?.direction ?? "desc",
    });
  }
  return order;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CmsError(`limit must be a positive integer, received ${limit}`, {
      status: 400,
      code: "invalid_pagination",
    });
  }
  return Math.min(limit, maxLimit);
}

/** Accepts what JSON carries and what JavaScript carries, rejects the rest. */
function parseWhen(at: Date | string): Date {
  const value = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(value.getTime())) {
    throw CmsError.validation(`"${String(at)}" is not a date`);
  }
  return value;
}

/**
 * The 409 a stale write earns.
 *
 * Both numbers are in the body because the panel has to say something more
 * useful than "conflict": "you were editing revision 17, the document is at
 * 19" is the difference between a dialog an editor can act on and one they
 * can only dismiss.
 */
function revisionConflict(expected: number, actual: number): CmsError {
  return new CmsError(
    `This document has changed since you read it (expected revision ${expected}, found ${actual}). Reload it and apply your change again.`,
    {
      status: 409,
      code: "revision_conflict",
      details: { expectedRevision: expected, revision: actual },
    },
  );
}

function assertRevision(expected: number | undefined, row: Row): void {
  if (expected === undefined) return;
  if (!Number.isInteger(expected) || expected < 1) {
    throw CmsError.validation(
      `expectedRevision has to be a positive integer, received ${String(expected)}.`,
    );
  }
  const current = toRevision(row.revision);
  if (current !== expected) throw revisionConflict(expected, current);
}

function activityAction(intent: WriteIntent): string {
  switch (intent) {
    case "create":
      return "document.created";
    case "update":
      return "document.updated";
    case "trash":
      return "document.trashed";
    case "restore":
      return "document.restored";
    case "purge":
      return "document.purged";
    case "schedule":
      return "document.scheduled";
    case "unschedule":
      return "document.schedule.cancelled";
  }
}

/**
 * An event carries the state at the moment it was emitted.
 *
 * The same document object is later expanded by `depth` before it is handed
 * back to the caller, and an event payload that aliased it would describe a
 * change that never happened.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}
