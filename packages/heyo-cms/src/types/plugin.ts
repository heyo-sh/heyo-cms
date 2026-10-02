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
import type { ComponentType, JsonObject } from "./json";
import type { MigrationStep, TableSnapshot } from "./schema";

/**
 * What a route handler receives.
 *
 * Deliberately not Hono's context. The router inside the core is Hono
 * (section 10), but a plugin contract typed against a specific router version
 * is a lock-in the plan's "zero framework coupling" promise cannot afford.
 * The adapter in `src/http` maps this onto whatever the router provides.
 */
export interface RouteContext {
  request: Request;
  /** Path parameters, e.g. `{ id: "doc_1" }` for `/posts/:id`. */
  params: Record<string, string>;
  query: URLSearchParams;
  actor: Actor | null;
  /** Access-control-bypassing database handle, outside any transaction. */
  db: ScopedDb;
  database: DatabaseAdapter;
  json(body: unknown, status?: number): Response;
  text(body: string, status?: number): Response;
}

export type RouteMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** An OpenAPI fragment carried by a route into the generated document. */
export interface OpenApiRouteSpec {
  summary?: string;
  description?: string;
  tags?: string[];
  requestBody?: JsonObject;
  responses?: JsonObject;
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

/** Panel surfaces a plugin can extend. Rendered by `@heyo-sh/heyo-cms-admin`. */
export interface AdminExtension {
  navItems?: { label: string; path: string; icon?: string }[];
  views?: Record<string, ComponentType<Record<string, unknown>>>;
  fields?: Record<string, ComponentType<Record<string, unknown>>>;
}

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
