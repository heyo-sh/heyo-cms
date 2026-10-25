import { isValidScope } from "./access/permissions";
import {
  defaultAdminPath,
  defaultBasePath,
  defaultMigrationsDirectory,
} from "./defaults";
import { createAi } from "./ai/index";
import { getAiAction, registeredAiActions } from "./ai/registry";
import { describeEditorSchema } from "./editor/index";
import { createAuth } from "./auth/service";
import { CmsConfigError } from "./errors";
import { trimTrailingSlashes } from "./strings";
import { parseByteSize, parseDuration } from "./duration";
import { createActivity } from "./engine/activity";
import { CmsEngine } from "./engine/engine";
import { hookPipelineEntries } from "./engine/hooks";
import { localeRecords } from "./i18n/index";
import { createCmsHttp, type CmsHttp } from "./http/handler";
import { reservedMediaSubRoutes } from "./http/routes/media";
import { mediaGcJob } from "./media/gc";
import { createMedia } from "./media/service";
import { buildSchemaSnapshot } from "./schema/snapshot";
import { systemTableNames } from "./schema/system";
import { createWebhooks, webhookRetryJob } from "./webhooks/index";
import type { WebhookRuntime } from "./webhooks/service";
import type { Actor } from "./types/actor";
import type { CmsAi } from "./types/ai";
import type { GlobalsApi, LocalApi } from "./types/api";
import type { CmsAuth } from "./types/auth";
import type {
  CollectionDefinition,
  CollectionDefinitionInput,
  CollectionsConfig,
  GlobalDefinition,
  GlobalsConfig,
  HeyoCmsConfig,
  I18nConfig,
  ResolvedCmsConfig,
  ResolvedCollection,
  ResolvedPluginHooks,
} from "./types/config";
import type { DatabaseAdapter } from "./types/database";
import type { AnyEventType, CmsEvent, CmsEventListener } from "./types/events";
import type { FieldDefinition, FieldsConfig } from "./types/fields";
import type {
  AuthInspection,
  CmsInspection,
  CmsInstance,
  CollectionInspection,
  PluginInspection,
  StorageInspection,
} from "./types/instance";
import type { CmsMedia } from "./types/media";
import type { CmsPlugin } from "./types/plugin";

export {
  defaultAdminPath,
  defaultBasePath,
  defaultMigrationsDirectory,
} from "./defaults";

/**
 * Path segments the router owns, so a collection cannot take one.
 *
 * A collection is mounted at its slug under `basePath`, next to the endpoints
 * the CMS serves for itself. Without this check a collection called `users`
 * would collide with `GET /users`, and the router would say so — but only when
 * something first built it, which on a serverless deployment is the first
 * request a user makes. Here it is a start-up error with the fix in it.
 */
const reservedRouteSegments = new Set([
  "activity",
  "admin",
  "ai",
  "auth",
  "globals",
  "jobs",
  "locales",
  "media",
  "openapi.json",
  "panel",
  "roles",
  "trash",
  "users",
  "webhooks",
]);

const nameFormat = /^[a-z][a-z0-9_]*$/;
/**
 * Field names may be camelCase; collection names may not.
 *
 * A collection name becomes a slug, and a slug is a URL. A field name becomes
 * a key in the document body and a quoted segment of an index name, so case
 * survives it intact — and `seoTitle` is what a TypeScript developer will
 * write whatever this expression says. The one character still forbidden is
 * the dot, because `where: { "a.b": ... }` addresses a path and a dot in a
 * name would make that ambiguous.
 */
const fieldNameFormat = /^[a-z][a-zA-Z0-9_]*$/;
const slugFormat = /^[a-z][a-z0-9-]*$/;
/** BCP 47 as far as anybody actually writes it: `en`, `pt-BR`, `de-AT-1996`. */
const localeCodeFormat = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Declares a collection.
 *
 * Returns the definition unchanged apart from a tag: the work happens in
 * `heyoCms()`, which is the only place that can see collections, globals and
 * plugins at once and therefore the only place that can validate them against
 * each other.
 */
export function defineCollection<TFields extends FieldsConfig>(
  definition: CollectionDefinitionInput<TFields>,
): CollectionDefinition<TFields> {
  return { ...definition, kind: "collection" };
}

/** Declares a singleton. Same machinery, one row. */
export function defineGlobal<TFields extends FieldsConfig>(
  definition: Omit<CollectionDefinitionInput<TFields>, "access"> & {
    access?: GlobalDefinition<TFields>["access"];
  },
): GlobalDefinition<TFields> {
  return { ...definition, kind: "global" };
}

/**
 * Builds the CMS.
 *
 * Everything that can be decided without a database is decided here: names,
 * defaults, the schema the configuration implies, the order hooks will run
 * in. A misconfiguration should fail while the module is loading, with the
 * path to the offending key — not on the first request that happens to touch
 * it.
 */
export function heyoCms<
  const TCollections extends CollectionsConfig,
  const TGlobals extends GlobalsConfig = Record<string, never>,
>(
  config: HeyoCmsConfig<TCollections, TGlobals>,
): CmsInstance<TCollections, TGlobals> {
  const resolved = resolveConfig(config);
  const schema = buildSchemaSnapshot({
    collections: resolved.collections,
    globals: resolved.globals,
    pluginTables: resolved.plugins.flatMap(
      (plugin) => plugin.schema?.tables ?? [],
    ),
  });

  const listeners = new Map<string, Set<CmsEventListener>>();
  // A plugin's listeners are subscribed before anything can commit, so the
  // first event after start-up reaches them like every later one.
  for (const plugin of resolved.plugins) {
    for (const [type, listener] of Object.entries(plugin.events ?? {})) {
      if (!listener) continue;
      const existing = listeners.get(type) ?? new Set<CmsEventListener>();
      existing.add(listener);
      listeners.set(type, existing);
    }
  }
  let adapter: DatabaseAdapter | undefined;
  let pending: Promise<DatabaseAdapter> | undefined;

  /**
   * Where a committed event ends up.
   *
   * A listener that throws fails the delivery, which the outbox then retries
   * with backoff — the same treatment a webhook gets, because "it ran" has to
   * mean the same thing for both (section 7).
   */
  const dispatch = async (event: CmsEvent): Promise<void> => {
    const subscribed = [
      ...(listeners.get(event.type) ?? []),
      ...(listeners.get("*") ?? []),
    ];
    for (const listener of subscribed) await listener(event);
    // Subscribers last and separately: a webhook that is down must not fail
    // the outbox row, because that would replay the event to every listener
    // above on the next pass. `dispatch` records its own failures and never
    // throws (section 7).
    await webhooks.dispatch(event);
  };

  const engine = new CmsEngine({
    config: resolved,
    database: () => instance.database(),
    dispatch,
  });

  /**
   * Auth shares the engine's outbox rather than owning one.
   *
   * An invitation and a document change are the same kind of fact to a
   * webhook subscriber, so they are written by the same mechanism, inside the
   * transaction that caused them (section 5).
   */
  const auth: CmsAuth = createAuth({
    config: resolved,
    database: () => instance.database(),
    emit: (tx, events, meta) => engine.appendEvents(tx, events, meta),
    deliver: () => engine.deliverSoon(),
  });

  /** Media shares the outbox for the same reason auth does. */
  const media: CmsMedia = createMedia({
    config: resolved,
    database: () => instance.database(),
    emit: (tx, events, meta) => engine.appendEvents(tx, events, meta),
    deliver: () => engine.deliverSoon(),
  });

  /**
   * The language list and the audit trail.
   *
   * Both exist as instance methods for the same reason `cms.api` does: the
   * routes in the HTTP layer call these, so a panel, a seed script and a
   * `curl` cannot disagree about what listing the languages means. The list
   * is computed once because it is configuration: `i18n.locales` cannot
   * change while the process runs.
   */
  const locales = localeRecords(resolved);
  const activity = createActivity({ database: () => instance.database() });

  /**
   * Delivery to subscribers, sharing the engine's outbox.
   *
   * Built before the engine's dispatcher runs rather than lazily: a
   * subscription that exists has to receive the first event after start-up,
   * not the second.
   */
  const webhooks: WebhookRuntime = createWebhooks({
    config: resolved,
    database: () => instance.database(),
    emit: (tx, events, meta) => engine.appendEvents(tx, events, meta),
    deliver: () => engine.deliverSoon(),
  });

  /**
   * `cms.ai`.
   *
   * Needs the instance, not the engine: an action reads the document through
   * `cms.api`, so access control, field read rules and locale resolution
   * apply to what reaches a model exactly as they do to what reaches a
   * browser (section 8).
   */
  const ai: CmsAi = createAi({
    config: resolved,
    database: () => instance.database(),
    cms: () => instance as CmsInstance,
    emit: (tx, events, meta) => engine.appendEvents(tx, events, meta),
    deliver: () => engine.deliverSoon(),
  });

  const jobs = engine.buildJobs();
  if (resolved.webhooks?.enabled) {
    jobs.register(webhookRetryJob(webhooks));
  }
  if (resolved.uploads) {
    // Registered only when there is storage to collect from, so
    // `cms.inspect().jobs` lists what will actually run rather than what the
    // package happens to contain.
    jobs.register(
      mediaGcJob({
        config: resolved,
        database: () => instance.database(),
        storage: () => media.storage(),
        emit: (tx, events, meta) => engine.appendEvents(tx, events, meta),
        deliver: () => engine.deliverSoon(),
      }),
    );
  }

  /**
   * The HTTP layer, built on first use.
   *
   * Not at configuration time: a CLI that generates a migration, a seed
   * script and a test of `cms.api` never serve a request, and making all of
   * them assemble a router would be a cost with no beneficiary. Memoised, so
   * the second request matches against the same instance as the first.
   */
  let http: CmsHttp | undefined;
  const httpLayer = (): CmsHttp => {
    http ??= createCmsHttp(instance as CmsInstance);
    return http;
  };

  const instance: CmsInstance<TCollections, TGlobals> = {
    _config: Object.freeze(resolved),
    schema,
    collections: config.collections,
    handler: (request, options) => httpLayer().handler(request, options),
    _router: { routes: () => httpLayer().routes() },
    api: engine.buildApi() as unknown as LocalApi<TCollections>,
    globals: engine.buildGlobals() as unknown as GlobalsApi<TGlobals>,
    auth,
    media,
    ai,
    webhooks,
    trash: engine.buildTrash(),
    jobs,
    locales: { list: () => locales },
    activity,

    inspect(): CmsInspection {
      return {
        basePath: resolved.basePath,
        database: {
          id: adapter?.id ?? "unresolved",
          capabilities: adapter?.capabilities ?? {
            transactions: false,
            sqlMigrations: false,
            jsonQuery: false,
          },
        },
        storage: inspectStorage(resolved),
        collections: inspectCollections(resolved),
        schema,
        // Produced by the builder the engine runs, so the printed order is
        // the executed one rather than a second opinion about it.
        hooks: hookPipelineEntries(resolved),
        // From the router itself, in match order: the antidote to "magic" is
        // that the generated surface is printable (section 10). Asking for it
        // builds the router, which is the point — an answer assembled from
        // the configuration a second time could differ from the one serving
        // requests.
        routes: httpLayer().routes(),
        admin: {
          path: `${resolved.basePath}${resolved.admin.path}`,
          panel: resolved.admin.assets?.id ?? null,
        },
        plugins: inspectPlugins(resolved),
        auth: inspectAuth(resolved),
        ai: {
          enabled: resolved.ai !== undefined,
          defaultModel: resolved.ai?.defaultModel ?? null,
          assistant:
            resolved.ai !== undefined &&
            resolved.ai.assistant?.enabled !== false,
          actions: registeredAiActions(),
          providers: Object.keys(resolved.ai?.auth ?? {}).sort(),
          panelManagedKeys: resolved.ai?.storage?.secret !== undefined,
        },
        webhooks: {
          enabled: resolved.webhooks?.enabled === true,
          signed: resolved.webhooks?.signing?.secret !== undefined,
          retries: resolved.webhooks?.delivery?.retries ?? 5,
        },
        editor: describeEditorSchema(),
        jobs: instance.jobs.list(),
        trash: {
          enabled: resolved.trash.enabled,
          purgeAfter:
            resolved.trash.purgeAfter === false
              ? null
              : resolved.trash.purgeAfter,
        },
      };
    },

    async database(): Promise<DatabaseAdapter> {
      if (adapter) return adapter;
      // Two concurrent requests must not each build a connection pool.
      pending ??= Promise.resolve(
        typeof resolved.database === "function"
          ? resolved.database()
          : resolved.database,
      ).then((built) => {
        built.useSchema(schema);
        adapter = built;
        return built;
      });
      return pending;
    },

    on(type: AnyEventType, listener: CmsEventListener): () => void {
      const existing = listeners.get(type) ?? new Set<CmsEventListener>();
      existing.add(listener);
      listeners.set(type, existing);
      return () => {
        existing.delete(listener);
      };
    },

    drainEvents(limit?: number): Promise<number> {
      return engine.drainEvents(limit);
    },

    async close(): Promise<void> {
      // Deliveries in flight hold the adapter; closing underneath them would
      // turn a successful write into a lost event.
      await engine.settle();
      await adapter?.close?.();
      adapter = undefined;
      pending = undefined;
      listeners.clear();
    },
  };

  engine.bind(instance as CmsInstance);
  return instance;
}

// ---------------------------------------------------------------------------
// Resolution and validation
// ---------------------------------------------------------------------------

function resolveConfig(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): ResolvedCmsConfig {
  const basePath = normaliseBasePath(config.basePath ?? defaultBasePath);
  const reserved = new Set(systemTableNames());
  const plugins = config.plugins ?? [];
  validatePlugins(plugins);

  // Plugins contribute before anything is resolved: a collection a plugin
  // brings is a collection in every sense — it gets routes, an entry in
  // `cms.api`, a place in the schema and a migration — and a field a plugin
  // adds has to be there when the collection's zod schema is built.
  const definitions = mergePluginCollections(config.collections, plugins);
  const pluginHooks = applyCollectionPatches({
    plugins,
    collections: definitions,
    globals: (config.globals ?? {}) as Record<string, GlobalDefinition>,
    basePath,
  });

  const collections: Record<string, ResolvedCollection> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    collections[name] = resolveCollection(
      name,
      definition,
      "collection",
      reserved,
    );
  }
  const globals: Record<string, ResolvedCollection> = {};
  for (const [name, definition] of Object.entries(config.globals ?? {})) {
    globals[name] = resolveCollection(name, definition, "global", reserved);
  }

  assertUniqueSlugs({ ...collections, ...globals });
  validateSlugFields({ ...collections, ...globals });
  validateRelations({ ...collections, ...globals });
  assertNoLegacyChat(config);
  validateHookTargets(config, collections, globals);
  validateFieldAi({ ...collections, ...globals });
  validateI18n(config);
  validateRbac(config);
  validateAuth(config);
  validateUploads(config, basePath);
  validateAi(config);
  validateWebhooks(config);

  const trashPurge = config.trash?.purgeAfter ?? "30d";
  if (typeof trashPurge === "string") parseDuration(trashPurge, "trash.purgeAfter"); // prettier-ignore

  return {
    basePath,
    database: config.database,
    admin: {
      ...config.admin,
      path: normaliseAdminPath(config.admin?.path ?? defaultAdminPath),
    },
    ...(config.rbac === undefined ? {} : { rbac: config.rbac }),
    i18n: resolveI18n(config.i18n),
    ...(config.uploads === undefined
      ? {}
      : {
          uploads:
            config.uploads.publicPath === undefined
              ? config.uploads
              : {
                  ...config.uploads,
                  publicPath: trimTrailingSlashes(config.uploads.publicPath.trim()), // prettier-ignore
                },
        }),
    ...(config.ai === undefined ? {} : { ai: config.ai }),
    ...(config.webhooks === undefined ? {} : { webhooks: config.webhooks }),
    trash: {
      enabled: config.trash?.enabled ?? true,
      purgeAfter: trashPurge,
    },
    collections,
    globals,
    ...(config.hooks === undefined ? {} : { hooks: config.hooks }),
    ...(config.databaseHooks === undefined
      ? {}
      : { databaseHooks: config.databaseHooks }),
    plugins,
    pluginHooks,
    ...(config.telemetry === undefined ? {} : { telemetry: config.telemetry }),
    migrationsDirectory:
      config.migrations?.directory ?? defaultMigrationsDirectory,
  };
}

function resolveCollection(
  name: string,
  definition: CollectionDefinition | GlobalDefinition,
  kind: "collection" | "global",
  reserved: Set<string>,
): ResolvedCollection {
  if (!nameFormat.test(name)) {
    throw new CmsConfigError(
      `collections.${name}`,
      "a collection name must be lowercase letters, digits and underscores, starting with a letter",
    );
  }
  const slug = definition.slug ?? name.replaceAll("_", "-");
  if (!slugFormat.test(slug)) {
    throw new CmsConfigError(
      `collections.${name}.slug`,
      `"${slug}" is not a URL-safe slug`,
    );
  }
  if (reserved.has(name) || reserved.has(slug)) {
    throw new CmsConfigError(
      `collections.${name}`,
      `"${name}" is a reserved system name; pick another`,
    );
  }
  if (reservedRouteSegments.has(slug)) {
    throw new CmsConfigError(
      `collections.${name}`,
      `"${slug}" is a URL the CMS serves itself; give the collection another slug`,
    );
  }

  const fields: Record<string, FieldDefinition> = {};
  for (const [fieldName, field] of Object.entries(definition.fields)) {
    if (!fieldNameFormat.test(fieldName)) {
      throw new CmsConfigError(
        `collections.${name}.fields.${fieldName}`,
        "a field name must be letters, digits and underscores, starting with a lowercase letter",
      );
    }
    if (field.required && field.admin?.hidden === true) {
      throw new CmsConfigError(
        `collections.${name}.fields.${fieldName}.admin.hidden`,
        "a hidden field cannot be required; remove required or show the field",
      );
    }
    fields[fieldName] = field;
  }

  if (Object.keys(fields).length === 0) {
    throw new CmsConfigError(
      `collections.${name}.fields`,
      "a collection needs at least one field",
    );
  }

  return {
    name,
    slug,
    label: definition.label ?? titleCase(name),
    kind,
    fields,
    access: (definition.access ?? {}) as ResolvedCollection["access"],
    ...(definition.admin === undefined ? {} : { admin: definition.admin }),
  };
}

function assertUniqueSlugs(
  collections: Record<string, ResolvedCollection>,
): void {
  const seen = new Map<string, string>();
  for (const collection of Object.values(collections)) {
    const owner = seen.get(collection.slug);
    if (owner) {
      throw new CmsConfigError(
        `collections.${collection.name}.slug`,
        `"${collection.slug}" is already used by "${owner}"; slugs are URLs and index names`,
      );
    }
    seen.set(collection.slug, collection.name);
  }
}

/**
 * A relation has to point somewhere.
 *
 * Catching this at build time rather than at `depth: 1` means a renamed
 * collection breaks the start-up of the application that renamed it, instead
 * of the page nobody visits until Friday.
 */
function validateRelations(
  collections: Record<string, ResolvedCollection>,
): void {
  const targets = new Set([...Object.keys(collections), ...systemTableNames()]);
  for (const collection of Object.values(collections)) {
    for (const [fieldName, field] of Object.entries(collection.fields)) {
      if (!field.relationTo) continue;
      if (!targets.has(field.relationTo)) {
        throw new CmsConfigError(
          `collections.${collection.name}.fields.${fieldName}`,
          `relation points at "${field.relationTo}", which is not a collection`,
        );
      }
    }
  }
}

/**
 * The document chat is gone, and silence is the wrong way to say so.
 *
 * `collection.ai.chat` and `ai.chat` configured a per-collection whitelist for
 * a chat that only ever proposed changes. The panel-wide assistant replaces it
 * and derives its reach from the live configuration and the signed-in actor
 * instead, so the old keys have no meaning — but a deployment that still has
 * them has an opinion about what AI may read, and ignoring that opinion while
 * shipping an agent that writes would be the worst possible upgrade.
 *
 * Checked against the untyped object rather than the type, because the
 * configuration is routinely written in JavaScript or assembled at runtime and
 * the type system is not there to catch it.
 */
function assertNoLegacyChat(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const ai = config.ai as { chat?: unknown } | undefined;
  if (ai && ai.chat !== undefined) {
    throw new CmsConfigError(
      "ai.chat",
      "document chat was replaced by the panel-wide assistant. Use ai.assistant, which takes a model, instructions and limits; what the agent may read and write now comes from the configuration and the actor at runtime",
    );
  }

  const everything = {
    ...(config.collections as Record<string, { ai?: unknown }>),
    ...((config.globals ?? {}) as Record<string, { ai?: unknown }>),
  };
  for (const [name, definition] of Object.entries(everything)) {
    if (definition?.ai === undefined) continue;
    throw new CmsConfigError(
      `collections.${name}.ai`,
      "per-collection ai.chat was removed with document chat. Delete the key; the assistant reads the collection through the same access control as everything else",
    );
  }
}

/** A hook on a collection that does not exist is a typo, and typos are silent. */
function validateHookTargets(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
  collections: Record<string, ResolvedCollection>,
  globals: Record<string, ResolvedCollection>,
): void {
  for (const name of Object.keys(config.databaseHooks ?? {})) {
    if (!(name in collections) && !(name in globals)) {
      throw new CmsConfigError(
        `databaseHooks.${name}`,
        "no collection or global with this name",
      );
    }
  }
}

/**
 * Collections a plugin brings, merged with the ones the application declared.
 *
 * A collision throws rather than resolving in anybody's favour. "The plugin
 * wins" would let an upgrade silently replace a collection full of content;
 * "the application wins" would leave the plugin's hooks and routes pointing
 * at fields that are not there. Neither is recoverable from a log line.
 */
function mergePluginCollections(
  declared: CollectionsConfig,
  plugins: CmsPlugin<unknown>[],
): Record<string, CollectionDefinition> {
  const merged: Record<string, CollectionDefinition> = { ...declared };
  const owners = new Map<string, string>();

  for (const plugin of plugins) {
    for (const [name, definition] of Object.entries(
      plugin.schema?.collections ?? {},
    )) {
      if (name in declared) {
        throw new CmsConfigError(
          `plugins.${plugin.id}.schema.collections.${name}`,
          `the configuration already declares a collection called "${name}"`,
        );
      }
      const owner = owners.get(name);
      if (owner) {
        throw new CmsConfigError(
          `plugins.${plugin.id}.schema.collections.${name}`,
          `"${owner}" already declares a collection called "${name}"`,
        );
      }
      owners.set(name, plugin.id);
      merged[name] = definition;
    }
  }
  return merged;
}

interface PatchOptions {
  plugins: CmsPlugin<unknown>[];
  collections: Record<string, CollectionDefinition>;
  globals: Record<string, GlobalDefinition>;
  basePath: string;
}

/**
 * `extendCollections()`: fields and hooks a plugin adds to somebody else's
 * collection.
 *
 * Fields are merged into the definition before it is resolved, so a plugin's
 * field is indistinguishable from a declared one by the time anything reads
 * it — same validation, same column, same place in the generated migration.
 * Hooks are collected rather than applied, because the order they run in is
 * a property of the whole configuration and is decided in one place
 * (section 5).
 */
function applyCollectionPatches(options: PatchOptions): ResolvedPluginHooks[] {
  const hooks: ResolvedPluginHooks[] = [];
  const fieldOwners = new Map<string, string>();

  for (const plugin of options.plugins) {
    if (!plugin.extendCollections) continue;
    const patches = plugin.extendCollections({
      collections: options.collections,
      basePath: options.basePath,
    });

    for (const patch of patches) {
      const target =
        options.collections[patch.collection] ??
        options.globals[patch.collection];
      if (!target) {
        throw new CmsConfigError(
          `plugins.${plugin.id}.extendCollections`,
          `patches "${patch.collection}", which is not a collection or a global`,
        );
      }

      for (const [name, field] of Object.entries(patch.fields ?? {})) {
        const owner = fieldOwners.get(`${patch.collection}.${name}`);
        if (name in target.fields) {
          throw new CmsConfigError(
            `plugins.${plugin.id}.extendCollections`,
            owner
              ? `"${owner}" already added "${name}" to ${patch.collection}`
              : `${patch.collection} already has a field called "${name}"`,
          );
        }
        fieldOwners.set(`${patch.collection}.${name}`, plugin.id);
        // The definition object is the application's; patching it in place
        // would mutate a module somebody else imported.
        target.fields = { ...target.fields, [name]: field };
      }

      if (patch.hooks) {
        hooks.push({
          plugin: plugin.id,
          collection: patch.collection,
          hooks: patch.hooks,
          priority: 0,
        });
      }
    }
  }

  return hooks;
}

/**
 * An AI action has to make sense for the field it is on.
 *
 * The field type already rejects an unknown action key (`fields/registry`).
 * This is the other half: a registered action declares which types it
 * applies to and whether it needs a localized field, and a `translate` on a
 * field that stores one value for every language is a mistake nobody will
 * notice until an editor overwrites the original.
 */
function validateFieldAi(
  collections: Record<string, ResolvedCollection>,
): void {
  for (const collection of Object.values(collections)) {
    for (const [fieldName, field] of Object.entries(collection.fields)) {
      if (field.aiGenerate !== undefined) {
        validateFieldAiOptions(
          collection,
          fieldName,
          field.aiGenerate,
          `collections.${collection.name}.fields.${fieldName}.aiGenerate`,
        );
      }
      for (const [action, options] of Object.entries(field.ai ?? {})) {
        if (options !== true) {
          validateFieldAiOptions(
            collection,
            fieldName,
            options,
            `collections.${collection.name}.fields.${fieldName}.ai.${action}`,
          );
        }
        const definition = getAiAction(action);
        const where = `collections.${collection.name}.fields.${fieldName}.ai.${action}`;
        if (!definition) {
          // An unregistered key is a custom action, and a custom action is
          // only a custom action if it brings an instruction.
          if (options === true || options.prompt === undefined) {
            throw new CmsConfigError(
              where,
              "is not a registered AI action; register it with defineAiAction() or give it a prompt",
            );
          }
          continue;
        }
        if (
          !definition.appliesTo.includes("*") &&
          !definition.appliesTo.includes(field.type)
        ) {
          throw new CmsConfigError(
            where,
            `does not apply to a ${field.type} field; it applies to ${definition.appliesTo.join(", ")}`,
          );
        }
        if (definition.requiresLocalized && !field.localized) {
          throw new CmsConfigError(
            where,
            "needs a localized field; this one stores a single value for every language",
          );
        }
      }
    }
  }
}

function validateFieldAiOptions(
  collection: ResolvedCollection,
  fieldName: string,
  options: {
    context?: string[];
    maxLength?: number;
    model?: { provider: string; model: string };
  },
  where: string,
): void {
  if (options.context !== undefined && !Array.isArray(options.context)) {
    throw new CmsConfigError(
      `${where}.context`,
      "must be an array of field names",
    );
  }
  const seen = new Set<string>();
  for (const name of options.context ?? []) {
    if (
      typeof name !== "string" ||
      !collection.fields[name] ||
      name === fieldName ||
      seen.has(name)
    ) {
      throw new CmsConfigError(
        `${where}.context`,
        `"${name}" must name a different, existing field of ${collection.name} (only once)`,
      );
    }
    seen.add(name);
  }
  if (
    options.maxLength !== undefined &&
    (!Number.isInteger(options.maxLength) || options.maxLength < 1)
  ) {
    throw new CmsConfigError(
      `${where}.maxLength`,
      "must be a positive integer",
    );
  }
  if (options.model && (!options.model.provider || !options.model.model)) {
    throw new CmsConfigError(`${where}.model`, "needs a provider and a model");
  }
}

function validatePlugins(plugins: CmsPlugin<unknown>[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) {
      throw new CmsConfigError(
        `plugins.${plugin.id}`,
        "two plugins share this id",
      );
    }
    seen.add(plugin.id);
  }

  // Route collisions are detected the way Better Auth does it: at start-up,
  // naming both sides, rather than letting the last registration win.
  const routes = new Map<string, string>();
  for (const plugin of plugins) {
    for (const route of plugin.routes ?? []) {
      const key = `${route.method} ${route.root === true ? "(root) " : ""}${route.path}`;
      const owner = routes.get(key);
      if (owner) {
        throw new CmsConfigError(
          `plugins.${plugin.id}.routes`,
          `"${key}" is already registered by "${owner}"`,
        );
      }
      routes.set(key, plugin.id);
    }
  }
}

/**
 * `i18n`, filled in.
 *
 * No section at all means one language called `en`, because a site that never
 * thinks about translation should not have to say so. A section that names
 * locales without naming a default takes the first one: the order somebody
 * typed is a statement about which language the content is written in.
 */
function resolveI18n(i18n: I18nConfig | undefined): Required<I18nConfig> {
  const locales = i18n?.locales;
  const defaultLocale = i18n?.defaultLocale ?? locales?.[0] ?? "en";
  return { defaultLocale, locales: locales ?? [defaultLocale] };
}

function validateI18n(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const i18n = config.i18n;
  if (!i18n) return;

  const codes = i18n.locales;
  if (codes !== undefined) {
    if (codes.length === 0) {
      throw new CmsConfigError(
        "i18n.locales",
        "at least one locale; leave the section out for a single-language site",
      );
    }
    for (const code of codes) {
      if (!localeCodeFormat.test(code)) {
        throw new CmsConfigError(
          "i18n.locales",
          `"${code}" is not a locale code; use a BCP 47 tag such as "en" or "pt-BR"`,
        );
      }
    }
    if (new Set(codes).size !== codes.length) {
      throw new CmsConfigError("i18n.locales", "duplicate locale codes");
    }
  }

  // The default locale is what every read falls back to, so one that is not
  // offered would make every untranslated field resolve to nothing — a typo
  // that shows up as empty pages rather than as an error.
  const defaultLocale = i18n.defaultLocale;
  if (defaultLocale !== undefined && codes && !codes.includes(defaultLocale)) {
    throw new CmsConfigError(
      "i18n.defaultLocale",
      `"${defaultLocale}" is not in i18n.locales (${codes.map((code) => `"${code}"`).join(", ")})`,
    );
  }
}

function validateRbac(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const rbac = config.rbac;
  if (!rbac) return;

  for (const [role, permissions] of Object.entries(rbac.roles)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(role)) {
      throw new CmsConfigError(
        `rbac.roles.${role}`,
        "a role name must be lowercase letters, digits, dashes and underscores, starting with a letter",
      );
    }
    for (const permission of permissions) {
      if (permission === "*") continue;
      if (!/^[a-z0-9_*-]+:[a-z0-9_*-]+$/.test(permission)) {
        throw new CmsConfigError(
          `rbac.roles.${role}`,
          `"${permission}" is not a permission; use "collection:action" or "*"`,
        );
      }
    }
  }
  if (rbac.defaultRole && !(rbac.defaultRole in rbac.roles)) {
    throw new CmsConfigError(
      "rbac.defaultRole",
      `"${rbac.defaultRole}" is not one of the configured roles`,
    );
  }
}

/**
 * The authentication section, checked while the module loads.
 *
 * Credentials are deliberately not required here — a template that lists
 * `github` has to start on a laptop where the OAuth app does not exist yet,
 * and the sign-in attempt is a better place to say so (section 10). What is
 * checked is everything that can only be a mistake.
 */
function validateAuth(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const auth = config.admin?.auth;
  if (!auth) return;

  const seen = new Set<string>();
  for (const method of auth.methods) {
    if (seen.has(method)) {
      throw new CmsConfigError("admin.auth.methods", `"${method}" is listed twice`); // prettier-ignore
    }
    seen.add(method);
  }
  for (const scope of auth.apiKeys?.scopes ?? []) {
    if (!isValidScope(scope)) {
      throw new CmsConfigError(
        "admin.auth.apiKeys.scopes",
        `"${scope}" is not a scope; use "read", "write", "delete", "*" or "collection:action"`,
      );
    }
  }
  // Roles arriving from an identity provider that the configuration never
  // declared would silently grant nothing, which looks exactly like a broken
  // mapping and is impossible to debug from the panel.
  if (auth.sso?.mapRoles && !config.rbac) {
    throw new CmsConfigError(
      "admin.auth.sso.mapRoles",
      "maps claims onto roles, but no roles are configured; add rbac.roles",
    );
  }
}

function validateUploads(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
  basePath: string,
): void {
  const uploads = config.uploads;
  if (!uploads) return;

  if (uploads.publicPath !== undefined) {
    validatePublicPath(uploads.publicPath, basePath);
  }

  if (uploads.limits?.maxFileSize) {
    parseByteSize(uploads.limits.maxFileSize, "uploads.limits.maxFileSize");
  }
  const purgeAfter = uploads.retention?.purgeAfter;
  if (typeof purgeAfter === "string") {
    parseDuration(purgeAfter, "uploads.retention.purgeAfter");
  }

  const images = uploads.images;
  const quality = images?.quality;
  if (quality !== undefined && (quality < 1 || quality > 100)) {
    throw new CmsConfigError("uploads.images.quality", "must be between 1 and 100"); // prettier-ignore
  }

  for (const [name, size] of Object.entries(images?.variants?.sizes ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new CmsConfigError(
        `uploads.images.variants.sizes.${name}`,
        "a size name ends up in a URL; use lowercase letters, digits and dashes",
      );
    }
    if (reservedMediaSubRoutes.includes(name)) {
      // A size name is a URL segment: `/media/:id/thumb` serves the size and
      // `/media/:id/usages` serves the references. The static route wins, so
      // a size called `usages` would be unreachable rather than broken —
      // which is worse, because nothing would ever say so.
      throw new CmsConfigError(
        `uploads.images.variants.sizes.${name}`,
        `"${name}" is a media endpoint; pick another size name`,
      );
    }
    if (size.width === undefined && size.height === undefined) {
      throw new CmsConfigError(
        `uploads.images.variants.sizes.${name}`,
        "needs a width, a height, or both",
      );
    }
    if (
      size.fit === "cover" &&
      (size.width === undefined || size.height === undefined)
    ) {
      // prettier-ignore
      // `cover` means "fill this box and crop the rest", and a box with one
      // side missing is not a box.
      throw new CmsConfigError(
        `uploads.images.variants.sizes.${name}`,
        'fit: "cover" needs both a width and a height',
      );
    }
  }

  // A transformation nothing can perform is a promise the configuration
  // cannot keep, and the first upload is a bad moment to find out.
  // `on-demand` without a processor is deliberately allowed: that is the
  // arrangement where an image CDN does the resizing (section 6).
  if (images && !images.processor) {
    const needs =
      images.convert !== undefined
        ? "convert"
        : images.maxDimensions !== undefined
          ? "maxDimensions"
          : images.variants?.mode === "pregenerate"
            ? 'variants.mode: "pregenerate"'
            : null;
    if (needs) {
      throw new CmsConfigError(
        "uploads.images.processor",
        `${needs} has to render pixels, and nothing here can. Add a processor from "@heyo-sh/heyo-cms/uploads" (sharpImages() on Node, cloudflareImages() on Workers), or drop the option.`,
      );
    }
  }
}

/**
 * A `slug` field's `from` has to name a sibling that holds text: the mistake
 * is otherwise silent — a slug that never fills in — and found by the first
 * editor who wonders why.
 */
function validateSlugFields(
  collections: Record<string, ResolvedCollection>,
): void {
  for (const collection of Object.values(collections)) {
    for (const [name, field] of Object.entries(collection.fields)) {
      if (field.type !== "slug") continue;
      const from = field.options.from;
      if (from === undefined) continue;
      const source = collection.fields[String(from)];
      const at = `collections.${collection.name}.fields.${name}.from`;
      if (!source || from === name) {
        throw new CmsConfigError(
          at,
          `"${String(from)}" is not another field of ${collection.name}`,
        );
      }
      if (
        !["text", "textarea", "email", "url", "select"].includes(source.type)
      ) {
        throw new CmsConfigError(
          at,
          `"${String(from)}" is a ${source.type} field; a slug is made from text`,
        );
      }
    }
  }
}

/**
 * `uploads.publicPath`: a plain absolute path the API does not already own.
 *
 * Inside `basePath` it would shadow the API's own `/media/:id/:size` route —
 * or be shadowed by it, depending on which was matched first — and a URL
 * that means two things is a bug report nobody can reproduce.
 */
function validatePublicPath(value: string, basePath: string): void {
  const path = trimTrailingSlashes(value.trim());
  const at = "uploads.publicPath";
  if (path.length === 0 && value.trim().startsWith("/")) {
    throw new CmsConfigError(at, 'cannot be "/"; use a path such as "/media"');
  }
  if (!path.startsWith("/")) throw new CmsConfigError(at, 'must start with "/"'); // prettier-ignore
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(path)) {
    throw new CmsConfigError(
      at,
      "may only contain letters, digits, dots, dashes, underscores and tildes between slashes",
    );
  }
  const within = (inner: string, outer: string) =>
    inner === outer || inner.startsWith(`${outer}/`);
  if (within(path, basePath) || within(basePath, path)) {
    throw new CmsConfigError(
      at,
      `"${path}" overlaps basePath "${basePath}"; files are served from <basePath>/media already — pick a path outside it, such as "/media"`,
    );
  }
}

function validateAi(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const ai = config.ai;
  if (!ai) return;

  const configured = new Set(Object.keys(ai.auth ?? {}));
  // Keys may also live in the database, encrypted, and be typed into the
  // panel (section 8). A deployment that chose that has no credentials here
  // at build time, and demanding a placeholder would be theatre.
  const panelManaged = ai.storage?.secret !== undefined;

  if (configured.size === 0 && !panelManaged && ai.complete === undefined) {
    throw new CmsConfigError(
      "ai.auth",
      "AI is configured without credentials. Add ai.auth, set ai.storage.secret to manage keys in the panel, or remove the section to disable AI",
    );
  }
  // A model whose provider has no credentials would fail on the first click
  // in the panel, which is the worst possible moment to learn about it.
  if (
    !panelManaged &&
    ai.complete === undefined &&
    !configured.has(ai.defaultModel.provider)
  ) {
    throw new CmsConfigError(
      "ai.defaultModel.provider",
      `"${ai.defaultModel.provider}" has no entry in ai.auth`,
    );
  }
  const assistant = ai.assistant;
  const assistantProvider = assistant?.model?.provider;
  if (
    assistantProvider &&
    !panelManaged &&
    ai.complete === undefined &&
    !configured.has(assistantProvider)
  ) {
    throw new CmsConfigError(
      "ai.assistant.model.provider",
      `"${assistantProvider}" has no entry in ai.auth`,
    );
  }
  for (const [key, min] of [
    ["maxTurns", 1],
    ["maxToolCalls", 1],
    ["timeoutMs", 1_000],
  ] as const) {
    const value = assistant?.[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < min) {
      throw new CmsConfigError(
        `ai.assistant.${key}`,
        `must be an integer of at least ${min}; it is a budget the server enforces, not a hint to the model`,
      );
    }
  }
  if (ai.storage && ai.storage.secret.length < 16) {
    throw new CmsConfigError(
      "ai.storage.secret",
      "must be at least 16 characters; it encrypts the provider keys in the database",
    );
  }
}

function validateWebhooks(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const webhooks = config.webhooks;
  if (!webhooks?.enabled) return;

  if (!webhooks.signing?.secret) {
    // An unsigned webhook is one a consumer cannot verify, which makes every
    // receiver a public write endpoint.
    throw new CmsConfigError(
      "webhooks.signing.secret",
      "webhooks must be signed; set a secret",
    );
  }
  if (webhooks.delivery?.timeout) {
    parseDuration(webhooks.delivery.timeout, "webhooks.delivery.timeout");
  }
}

/**
 * Where the panel lives, relative to `basePath`.
 *
 * Checked here rather than when the router is built, for the same reason the
 * collection slugs are: a configuration mistake should fail while the module
 * is loading, not on somebody's first request.
 */
function normaliseAdminPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    throw new CmsConfigError("admin.path", 'must start with "/"');
  }
  if (/[?#]/.test(trimmed) || trimmed.includes("//")) {
    throw new CmsConfigError(
      "admin.path",
      "cannot contain a query, a fragment or an empty segment",
    );
  }
  const normalised = trimTrailingSlashes(trimmed);
  if (normalised.length === 0) {
    // The panel at the mount root is legal: `/admin/*` becomes `/*`, which is
    // matched last, so every API route still wins.
    return "";
  }
  return normalised;
}

/**
 * The mount point is stripped from incoming requests, so it has to be a plain
 * absolute path. Same rule as every other Heyo package.
 */
function normaliseBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    throw new CmsConfigError("basePath", 'must start with "/"');
  }
  if (/[?#]/.test(trimmed)) {
    throw new CmsConfigError("basePath", "cannot contain a query or fragment");
  }
  if (trimmed.includes("//")) {
    throw new CmsConfigError("basePath", "cannot contain empty segments");
  }
  const normalised = trimTrailingSlashes(trimmed);
  if (normalised.length === 0) {
    throw new CmsConfigError("basePath", 'cannot be "/"');
  }
  return normalised;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

function inspectCollections(config: ResolvedCmsConfig): CollectionInspection[] {
  return [
    ...Object.values(config.collections),
    ...Object.values(config.globals),
  ].map((collection) => ({
    name: collection.name,
    slug: collection.slug,
    kind: collection.kind,
    fields: Object.entries(collection.fields).map(([name, field]) => ({
      name,
      type: field.type,
      localized: field.localized,
      required: field.required,
    })),
  }));
}

/**
 * What happens to a file, printed.
 *
 * The adapter is not built here: resolving it would open a connection, or
 * read an environment variable that only exists inside a request, every time
 * somebody asked what this CMS does.
 */
function inspectStorage(config: ResolvedCmsConfig): StorageInspection | null {
  const uploads = config.uploads;
  if (!uploads) return null;
  const retention = uploads.retention?.purgeAfter ?? "30d";
  return {
    id:
      typeof uploads.storage === "function" ? "unresolved" : uploads.storage.id,
    variants: uploads.images?.variants?.mode ?? null,
    processor: uploads.images?.processor?.id ?? null,
    purgeAfter: retention === false ? null : retention,
  };
}

/**
 * What each plugin actually contributed.
 *
 * Counted from the resolved configuration rather than from the plugin
 * object, so a plugin whose `extendCollections` returned nothing shows zero
 * hooks — which is the state somebody is trying to diagnose when they print
 * this.
 */
function inspectPlugins(config: ResolvedCmsConfig): PluginInspection[] {
  return config.plugins.map((plugin) => ({
    id: plugin.id,
    collections: Object.keys(plugin.schema?.collections ?? {}).sort(),
    tables: (plugin.schema?.tables ?? []).map((table) => table.name).sort(),
    routes: plugin.routes?.length ?? 0,
    hooks:
      (plugin.hooks?.length ?? 0) +
      config.pluginHooks.filter((entry) => entry.plugin === plugin.id).length,
    migrations: (plugin.migrations ?? []).map((migration) => migration.id),
    client: plugin.client !== undefined,
    admin: plugin.admin !== undefined,
  }));
}

function inspectAuth(config: ResolvedCmsConfig): AuthInspection {
  const auth = config.admin.auth;
  return {
    methods: auth?.methods ?? [],
    twoFactor: auth?.twoFactor === true,
    apiKeys: auth?.apiKeys?.enabled === true,
    sso: auth?.sso?.issuer ?? null,
    roles: Object.keys(config.rbac?.roles ?? {}).sort(),
    customRoles: config.rbac?.customRoles === true,
  };
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

/** Convenience for tests and tooling that need an actor without a session. */
export function systemActor(id = "system"): Actor {
  return { id, source: "session", roles: ["admin"], permissions: ["*"] };
}
