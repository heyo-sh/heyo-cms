import type { Actor, OperationSource } from "./actor";
import type {
  CollectionsConfig,
  GlobalsConfig,
  InferDocument,
  SystemDocumentFields,
} from "./config";
import type { OrderBy, Where } from "./query";

/**
 * Which language a call speaks.
 *
 * A field with no value in `locale` is answered from `i18n.defaultLocale`.
 * `fallbackLocale` changes that for one call: `false` turns substitution off
 * and a code forces one specific source. The panel needs both — an editor
 * filling in translations wants to see the gaps, a preview wants the page to
 * render (section 9).
 */
export interface LocaleArgs {
  locale?: string;
  fallbackLocale?: string | false;
}

export interface OperationArgs extends LocaleArgs {
  /** Who is calling. `null` is an anonymous caller, not a privileged one. */
  actor?: Actor | null;
  /** Where the call came from; carried into hooks, events and activity. */
  source?: OperationSource;
  /**
   * The AI run that caused this write, recorded in the activity entry.
   *
   * Only ever set by the assistant. The actor stays the human who asked for
   * the change — this is what links their change to the conversation it came
   * from, not a second kind of author.
   */
  runId?: string;
}

/**
 * What a write may promise about the state it is changing.
 *
 * Both are opt-in, and both exist for the same reason: a write that was
 * decided somewhere other than the moment it is applied — a form the editor
 * left open, an agent that read the document two tool calls ago, a client
 * retrying over a dropped connection — needs to say what it believed, so the
 * engine can refuse rather than guess.
 */
export interface WriteConcurrencyArgs {
  /**
   * The `revision` the caller read. The write is refused with `409` if the
   * stored revision has moved on.
   */
  expectedRevision?: number;
  /**
   * Makes the write replayable exactly once.
   *
   * Recorded inside the same transaction as the document, so a second call
   * with the same key answers with the first result instead of running the
   * hooks, the events and the outbox again.
   */
  idempotencyKey?: string;
}

export interface ReadArgs extends OperationArgs {
  /** How many relation levels to resolve. Each level is one batched query. */
  depth?: number;
  /** Includes soft-deleted documents, which are hidden by default. */
  includeTrashed?: boolean;
}

export interface FindArgs extends ReadArgs {
  where?: Where;
  /** Defaults to `updated_at desc`; `id` is always appended as a tiebreaker. */
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
  /** Keyset pagination. Mutually exclusive with `offset` in practice. */
  cursor?: string;
  /** Runs a second COUNT query and fills `totalDocs`. Off by default. */
  count?: boolean;
}

export interface FindOneArgs extends ReadArgs {
  where?: Where;
  orderBy?: OrderBy[];
}

export interface CountArgs extends OperationArgs {
  where?: Where;
  includeTrashed?: boolean;
}

/**
 * One page of documents.
 *
 * `hasNextPage` comes from reading one row past the limit rather than from a
 * count, so paging never costs a second query unless `count` asked for one.
 */
export interface FindResult<TDoc> {
  docs: TDoc[];
  limit: number;
  /** `null` unless the call set `count: true`. */
  totalDocs: number | null;
  hasNextPage: boolean;
  /** Opaque. Pass it back as `cursor` to get the next page. */
  cursor: string | null;
}

/**
 * What a caller may write.
 *
 * System fields are stamped by the engine, and every field is optional
 * because a `before` hook is allowed to fill a required one — which is the
 * whole point of the slug example in section 5. Validation runs after the
 * hooks, so a missing required field is still an error, just a later one.
 */
export type DocumentInput<TDoc> = Partial<
  Omit<TDoc, keyof SystemDocumentFields>
>;

export interface CreateArgs<TDoc> extends ReadArgs, WriteConcurrencyArgs {
  data: DocumentInput<TDoc>;
  /**
   * The id to write, instead of a generated one.
   *
   * For imports and seeds, where a document's id is a reference other
   * documents already hold (`heyo-cms import`, stage 10). The database rejects
   * a duplicate, so this cannot overwrite anything by accident: a clash is an
   * error, never a silent merge.
   */
  id?: string;
}

export interface UpdateArgs<TDoc> extends ReadArgs, WriteConcurrencyArgs {
  id: string;
  data: DocumentInput<TDoc>;
}

export interface DeleteArgs extends ReadArgs, WriteConcurrencyArgs {
  id: string;
  /**
   * Skips the trash and removes the row.
   *
   * Ignored when `trash.enabled` is false, because the delete is permanent
   * either way. Governed by the `purge` permission rather than `delete`:
   * "remove it" and "remove it so nobody can get it back" are different
   * decisions and an interface that confuses them will eventually be used to
   * make the second one by accident.
   */
  permanent?: boolean;
}

export interface RestoreArgs extends ReadArgs, WriteConcurrencyArgs {
  id: string;
}

/**
 * A change to apply later.
 *
 * `data` is an ordinary patch — the engine attaches no meaning to any field in
 * it. Scheduling `status: "published"` is the obvious use and the only reason
 * the feature exists, but scheduling a price change or a banner is the same
 * mechanism and the same code (section 3).
 */
export interface ScheduleArgs<TDoc> extends ReadArgs {
  id: string;
  /** When the patch should be applied. A past time applies on the next sweep. */
  at: Date | string;
  data: DocumentInput<TDoc>;
}

export interface UnscheduleArgs extends ReadArgs {
  id: string;
}

/**
 * The local API for one collection.
 *
 * Identical in behaviour to the REST route that wraps it in stage 7: the same
 * access control, the same hooks, the same events. Two code paths would mean
 * two sets of bugs (section 10).
 *
 * A write returns `null` when a `before` hook returned `false` — the
 * documented way to stop an operation without an error.
 */
export interface ResolveSlugArgs extends Omit<ReadArgs, "includeTrashed"> {
  /** The slug field to look in. The collection's first `slug` field by default. */
  field?: string;
}

/**
 * Where a slug leads.
 *
 * `current: false` means the slug is a previous address of the document —
 * the caller answers with a redirect to the document's slug now. `locale`
 * is the language the slug matched in, which is not necessarily the one
 * asked for: a link shared with the wrong language prefix still arrives.
 */
export interface SlugResolution<TDoc> {
  id: string;
  field: string;
  /** Null for a field that is not localized. */
  locale: string | null;
  current: boolean;
  /** Read in the requested locale, with the caller's access. */
  document: TDoc;
}

/** One previous address of a document. */
export interface PreviousSlug {
  slug: string;
  field: string;
  /** Null for a field that is not localized. */
  locale: string | null;
  createdAt: string | null;
}

export interface PreviousSlugsArgs extends OperationArgs {
  id: string;
  /** The collection's first `slug` field with `history` by default. */
  field?: string;
}

export interface PreviousSlugWriteArgs extends OperationArgs {
  id: string;
  slug: string;
  field?: string;
}

export interface CollectionApi<TDoc> {
  find(args?: FindArgs): Promise<FindResult<TDoc>>;
  findOne(args?: FindOneArgs): Promise<TDoc | null>;
  findById(id: string, args?: ReadArgs): Promise<TDoc | null>;
  count(args?: CountArgs): Promise<number>;
  create(args: CreateArgs<TDoc>): Promise<TDoc | null>;
  update(args: UpdateArgs<TDoc>): Promise<TDoc | null>;
  /** Moves the document to the trash, or removes it when there is no trash. */
  delete(args: DeleteArgs): Promise<TDoc | null>;
  /** Brings a trashed document back. Refuses a document that is not trashed. */
  restore(args: RestoreArgs): Promise<TDoc | null>;
  /** Removes the row for good, trashed or not. */
  purge(args: DeleteArgs): Promise<TDoc | null>;
  schedule(args: ScheduleArgs<TDoc>): Promise<TDoc | null>;
  unschedule(args: UnscheduleArgs): Promise<TDoc | null>;
  /**
   * The document a slug belongs to, now or before: the lookup behind a page
   * route and the 301 from an old URL. Null when nothing readable has it.
   * Needs a `slug` field; previous addresses need `history: true`.
   */
  resolveSlug(
    slug: string,
    args?: ResolveSlugArgs,
  ): Promise<SlugResolution<TDoc> | null>;
  /** A document's previous addresses, newest first; `locale` narrows to one language. */
  previousSlugs(args: PreviousSlugsArgs): Promise<PreviousSlug[]>;
  /**
   * Makes a slug lead here as a previous address: how two pages are merged
   * — add the old page's slug, then trash the old page. Refused when the
   * slug is another document's address or already leads elsewhere.
   */
  addPreviousSlug(args: PreviousSlugWriteArgs): Promise<PreviousSlug[]>;
  /** Stops a previous address from leading here, which frees it for reuse. */
  removePreviousSlug(args: PreviousSlugWriteArgs): Promise<PreviousSlug[]>;
}

/** `cms.api`: one entry per declared collection, typed from its fields. */
export type LocalApi<TCollections extends CollectionsConfig> = {
  [K in keyof TCollections]: CollectionApi<InferDocument<TCollections[K]>>;
};

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

export interface GlobalUpdateArgs<TDoc> extends ReadArgs, WriteConcurrencyArgs {
  data: DocumentInput<TDoc>;
}

export interface GlobalScheduleArgs<TDoc> extends ReadArgs {
  at: Date | string;
  data: DocumentInput<TDoc>;
}

/**
 * A singleton, on the same machinery as a collection.
 *
 * `get()` never returns `null`: a global that has never been saved reads as
 * its declared defaults, with `createdAt` and `updatedAt` still `null`. The
 * alternative — a 404 on a global the configuration says exists — would make
 * every template start with a null check for a document the developer
 * declared themselves.
 *
 * There is no `create` and no `delete`: a singleton the panel could delete is
 * a collection with one row.
 */
export interface GlobalApi<TDoc> {
  get(args?: ReadArgs): Promise<TDoc>;
  update(args: GlobalUpdateArgs<TDoc>): Promise<TDoc | null>;
  schedule(args: GlobalScheduleArgs<TDoc>): Promise<TDoc | null>;
  unschedule(args?: OperationArgs): Promise<TDoc | null>;
}

/** `cms.globals`: one entry per declared global, typed from its fields. */
export type GlobalsApi<TGlobals extends GlobalsConfig> = {
  [K in keyof TGlobals]: GlobalApi<InferDocument<TGlobals[K]>>;
};
