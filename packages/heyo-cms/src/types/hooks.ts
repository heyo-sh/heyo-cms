import type { Actor, OperationSource } from "./actor";
import type { HookEventEmitter } from "./events";
import type { CmsInstance } from "./instance";
import type { JsonObject } from "./json";
import type { Mutation, MutationResult, Query, Row, Tx, Where } from "./query";

/**
 * The operations a hook can observe.
 *
 * There is no `publish` here. The engine has no document lifecycle: status is
 * an ordinary `select()` field, so publishing is an update and nothing else
 * (sections 3 and 11).
 */
export type HookOperation = "create" | "update" | "delete";

/**
 * Database access that bypasses access control, on purpose and by name.
 *
 * The alternative — an `overrideAccess: true` flag buried in an options object
 * — is how Payload makes a security decision look like a formatting choice.
 * Here `ctx.db` always bypasses and `ctx.cms` always enforces, and the reader
 * can tell which is which without opening the call site.
 */
export interface ScopedDb {
  query(query: Query): Promise<Row[]>;
  mutate(mutation: Mutation): Promise<MutationResult>;
  find(table: string, where?: Where): Promise<Row[]>;
  findOne(table: string, where: Where): Promise<Row | null>;
  insert(table: string, values: Row): Promise<Row>;
  update(table: string, where: Where, set: Row): Promise<number>;
  delete(table: string, where: Where): Promise<number>;
}

/**
 * One context object for every hook, whatever the operation.
 *
 * Payload's hooks each receive a differently shaped argument, which is why
 * its documentation needs a table per hook. One shape means one thing to
 * learn, and the engine can pass the same object down the whole pipeline.
 */
export interface HookContext {
  actor: Actor | null;
  collection: string;
  operation: HookOperation;
  locale: string | null;
  /** The transaction the operation runs in. */
  tx: Tx;
  /** Bypasses access control. */
  db: ScopedDb;
  /** Enforces access control. */
  cms: CmsInstance;
  /** Side effects go here, never inline: the outbox decides when they run. */
  events: HookEventEmitter;
  source: OperationSource;
  /** Passing values between hooks in one operation. */
  meta: Record<string, unknown>;
}

/**
 * What every hook may return — the same four cases for all of them.
 *
 * `undefined` continue unchanged, `{ data }` continue with a replacement,
 * `false` stop silently, `throw CmsError` stop with a status.
 */
export type HookResult<TData> = void | undefined | false | { data: TData };

export type MaybePromise<T> = T | Promise<T>;

export interface CreateHookInput<TDoc> {
  data: TDoc;
}

export interface UpdateHookInput<TDoc> {
  data: Partial<TDoc>;
  previous: TDoc;
}

export interface UpdateHookOutput<TDoc> {
  doc: TDoc;
  previous: TDoc;
}

/**
 * Hooks for one collection.
 *
 * `before` runs in the transaction ahead of the write, `after` runs in the
 * same transaction behind it. There is no third moment: anything that must
 * not be rolled back is an event (section 5).
 */
export interface CollectionDatabaseHooks<TDoc extends JsonObject = JsonObject> {
  create?: {
    before?: (
      input: CreateHookInput<TDoc>,
      context: HookContext,
    ) => MaybePromise<HookResult<TDoc>>;
    after?: (doc: TDoc, context: HookContext) => MaybePromise<void>;
  };
  update?: {
    before?: (
      input: UpdateHookInput<TDoc>,
      context: HookContext,
    ) => MaybePromise<HookResult<Partial<TDoc>>>;
    after?: (
      output: UpdateHookOutput<TDoc>,
      context: HookContext,
    ) => MaybePromise<void>;
  };
  delete?: {
    before?: (
      doc: TDoc,
      context: HookContext,
    ) => MaybePromise<HookResult<TDoc>>;
    after?: (doc: TDoc, context: HookContext) => MaybePromise<void>;
  };
}

/** `databaseHooks`, keyed by collection name. */
export type DatabaseHooks<TCollections extends Record<string, unknown>> = {
  [K in keyof TCollections]?: CollectionDatabaseHooks<JsonObject>;
};

/**
 * The HTTP layer: rate limiting, response decoration, telemetry.
 *
 * A `before` hook that returns a `Response` short-circuits the request, which
 * is what makes rate limiting expressible without a separate middleware
 * concept.
 */
export interface HttpHookContext {
  request: Request;
  /** Path with `basePath` already stripped, as the router sees it. */
  path: string;
  method: string;
  /**
   * The request's headers in a `before` hook, the response's in an `after`
   * one — which is the only pair that is useful: before the route there is no
   * response to decorate, and after it the request's headers are already in
   * `request`.
   */
  headers: Headers;
  /** The response status. Present in an `after` hook only. */
  status?: number;
  /**
   * Who is calling, resolved from the cookie or the `Authorization` header
   * before any hook runs: a rate limiter that cannot tell an editor from a
   * stranger is a rate limiter on the wrong thing.
   */
  actor: Actor | null;
  cms: CmsInstance;
  /** One object per request, shared by the `before` and `after` hooks. */
  meta: Record<string, unknown>;
}

export interface HttpHook {
  matcher: (context: HttpHookContext) => boolean;
  handler: (context: HttpHookContext) => MaybePromise<void | Response>;
  /** Lower runs first. Plugin hooks default to 0, user hooks to 100. */
  priority?: number;
}

export interface HttpHooks {
  before?: HttpHook[];
  after?: HttpHook[];
}
