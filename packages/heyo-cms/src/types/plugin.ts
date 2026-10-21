import type { Actor } from "./actor";
import type { CollectionDefinition } from "./config";
import type { DatabaseAdapter } from "./database";
import type { FieldsConfig } from "./fields";
import type {
  CollectionDatabaseHooks,
  HookContext,
  HookOperation,
  HookResult,
  MaybePromise,
  ScopedDb,
} from "./hooks";
import type { CmsInstance } from "./instance";
import type { ComponentType, JsonObject } from "./json";
import type { MigrationStep, TableSnapshot } from "./schema";

/**
 * What a route handler receives.
 *
 * Deliberately not a third-party router's context. The router inside the core
 * is the core's own (section 10): a plugin contract typed against a specific
 * router version is a lock-in the plan's "zero framework coupling" promise
 * cannot afford, and a route that only ever needs `Request` and the matched
 * parameters has no business importing one.
 *
 * The pair `db`/`cms` is the same distinction hooks make, by name rather than
 * by a flag: `db` bypasses access control, `cms` enforces it.
 */
export interface RouteContext {
  request: Request;
  /** Path parameters, e.g. `{ id: "doc_1" }` for `/posts/:id`. */
  params: Record<string, string>;
  query: URLSearchParams;
  actor: Actor | null;
  /** Access control enforced; the object hooks receive as `ctx.cms`. */
  cms: CmsInstance;
  /**
   * Access-control-bypassing database handle, outside any transaction.
   *
   * Every call opens its own short transaction, because a route is not an
   * operation: there is nothing for a second statement to be atomic with.
   * A route that needs atomicity calls `cms.api`, or opens one itself through
   * `database()`.
   */
  db: ScopedDb;
  /**
   * The adapter, built on first use.
   *
   * A function rather than a resolved value: a route that serves a bundled
   * asset or the OpenAPI document must not open a connection pool, and a D1
   * binding only exists inside a request in the first place.
   */
  database(): Promise<DatabaseAdapter>;
  /** The parsed JSON body. Throws a 400 `CmsError` when it is not JSON. */
  body(): Promise<unknown>;
  /** Shared with the HTTP hooks that run around this request. */
  meta: Record<string, unknown>;
  json(body: unknown, status?: number): Response;
  text(body: string, status?: number): Response;
}

export type RouteMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * An OpenAPI fragment carried by a route into the generated document.
 *
 * Attached to the route rather than written in a separate file, which is what
 * makes an undocumented endpoint impossible: the generator reads the router,
 * so a route that forgot its fragment shows up as one in the document.
 */
export interface OpenApiRouteSpec {
  summary?: string;
  description?: string;
  tags?: string[];
  /** Query and path parameters, as OpenAPI parameter objects. */
  parameters?: JsonObject[];
  requestBody?: JsonObject;
  responses?: JsonObject;
  /** `false` marks a route that needs no credentials, e.g. a sign-in. */
  security?: boolean;
}

export interface RouteDefinition {
  method: RouteMethod;
  /** Relative to `basePath`, e.g. `/analytics/pageviews`. */
  path: string;
  handler: (context: RouteContext) => Response | Promise<Response>;
  middleware?: ((
    context: RouteContext,
    next: () => Promise<Response>,
  ) => Promise<Response>)[];
  openapi?: OpenApiRouteSpec;
}

/** Tables and collections a plugin brings with it. */
export interface PluginSchema {
  collections?: Record<string, CollectionDefinition>;
  tables?: TableSnapshot[];
}

/**
 * A plugin migration.
 *
 * Steps, not SQL: a plugin that shipped Postgres DDL would be unusable on
 * MongoDB, and the whole point of the neutral step list is that the adapter
 * decides how a change is expressed.
 */
export interface PluginMigration {
  id: string;
  steps: MigrationStep[];
}

/** Changes a plugin makes to collections the user declared. */
export interface CollectionPatch {
  collection: string;
  fields?: FieldsConfig;
  hooks?: CollectionDatabaseHooks;
}

export interface PluginContext {
  collections: Record<string, CollectionDefinition>;
  basePath: string;
}

/**
 * A hook a plugin installs on a collection it does not own.
 *
 * Ordering is explicit rather than registration-dependent: plugin hooks run
 * in `priority` order and the configuration's own hooks always run last, so a
 * user can always override what a plugin decided (section 5).
 */
export interface HookRegistration {
  collection: string;
  operation: HookOperation;
  timing: "before" | "after";
  /** Lower runs first. Plugin hooks default to 0, user hooks always run last. */
  priority?: number;
  handler: (
    input: JsonObject,
    context: HookContext,
  ) => MaybePromise<HookResult<JsonObject>>;
}

/** Extra methods a plugin adds to the typed client. */
export type ClientExtension<Ext> = (base: {
  baseUrl: string;
  request: (
    path: string,
    init?: RequestInit & { query?: Record<string, string> },
  ) => Promise<unknown>;
}) => Ext;

/**
 * Panel surfaces a plugin can extend. Rendered by `@heyo-sh/heyo-cms-admin`.
 *
 * `views` and `fields` are components, and a component cannot cross HTTP —
 * the panel is one static bundle, compiled before this plugin existed. They
 * are useful to a deployment that builds its own panel bundle. For the
 * shipped one, `scripts` is the mechanism: the panel loads each URL at boot
 * and the script registers its controls against `window.heyoCmsPanel`.
 */
export interface AdminExtension {
  navItems?: { label: string; path: string; icon?: string }[];
  views?: Record<string, ComponentType<Record<string, unknown>>>;
  fields?: Record<string, ComponentType<Record<string, unknown>>>;
  /**
   * Scripts the panel loads before it renders.
   *
   * Relative URLs are resolved against `basePath`, so the usual arrangement
   * is a plugin route serving its own bundle: `/analytics/panel.js`.
   */
  scripts?: string[];
}

/**
 * A plugin.
 *
 * `Ext` is what the plugin adds to the typed client, and it is only ever in a
 * return position — which is what lets a configuration hold
 * `CmsPlugin<unknown>[]` while `heyoCmsClient({ plugins: [...] })` still
 * recovers the concrete extension types from the tuple it is handed.
 */
export interface CmsPlugin<Ext = Record<string, never>> {
  id: string;
  schema?: PluginSchema;
  migrations?: PluginMigration[];
  extendCollections?: (context: PluginContext) => CollectionPatch[];
  hooks?: HookRegistration[];
  /** Registered under `basePath` automatically, exactly like core routes. */
  routes?: RouteDefinition[];
  client?: ClientExtension<Ext>;
  admin?: AdminExtension;
}
