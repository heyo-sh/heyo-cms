import type { CmsActivity } from "./activity";
import type { CmsAi } from "./ai";
import type { GlobalsApi, LocalApi } from "./api";
import type { CmsAuth } from "./auth";
import type { EditorSchemaDescription } from "./editor";
import type {
  CollectionsConfig,
  GlobalsConfig,
  ResolvedCmsConfig,
} from "./config";
import type { DatabaseAdapter, DatabaseCapabilities } from "./database";
import type { AnyEventType, CmsEventListener } from "./events";
import type { HookOperation } from "./hooks";
import type { CmsJobs } from "./jobs";
import type { CmsLocales } from "./locales";
import type { CmsMedia } from "./media";
import type { RouteMethod } from "./plugin";
import type { SchemaSnapshot } from "./schema";
import type { CmsTrash } from "./trash";
import type { CmsWebhooks } from "./webhooks";

/** One entry of the hook pipeline, in the order it will actually run. */
export interface HookPipelineEntry {
  collection: string;
  operation: HookOperation;
  timing: "before" | "after";
  /** `config` or the id of the plugin that registered it. */
  source: string;
  priority: number;
}

export interface RouteInspection {
  method: RouteMethod;
  /** Including `basePath`, i.e. what a client actually calls. */
  path: string;
  /** `core`, or the id of the plugin that registered it. */
  source: string;
  /** How many `before`/`after` wrappers run around the handler. */
  middleware: number;
}

/**
 * The panel, printed.
 *
 * `panel: null` means `admin.assets` is not configured, so `admin.path`
 * answers with a page that says so rather than with a bundle. Worth printing
 * because the two are indistinguishable from a 200.
 */
export interface AdminInspection {
  /** Including `basePath`. */
  path: string;
  panel: string | null;
}

/**
 * What authentication is actually turned on.
 *
 * Printed rather than implied: "is two-factor enforced here" and "can this
 * deployment issue API keys" are questions an operator should be able to
 * answer without reading the configuration file.
 */
export interface AuthInspection {
  methods: string[];
  twoFactor: boolean;
  apiKeys: boolean;
  /** The SSO issuer, when one is configured. */
  sso: string | null;
  roles: string[];
  customRoles: boolean;
}

/**
 * One plugin, and what it actually contributed.
 *
 * A list of ids answers "is it installed"; this answers "did it do
 * anything", which is the question somebody has when a plugin appears to be
 * installed and inert.
 */
export interface PluginInspection {
  id: string;
  collections: string[];
  tables: string[];
  routes: number;
  hooks: number;
  migrations: string[];
  client: boolean;
  admin: boolean;
}

export interface CollectionInspection {
  name: string;
  slug: string;
  kind: "collection" | "global";
  fields: {
    name: string;
    type: string;
    localized: boolean;
    required: boolean;
  }[];
}

/**
 * What `cms.inspect()` answers.
 *
 * The auto-router and the plugin loader are only acceptable if their result is
 * printable: this is the antidote to "magic" (section 10). Everything the
 * engine decided — schema, hook order, routes — is readable from one call.
 */
/**
 * What happens to a file, printed.
 *
 * `processor: null` with `variants: "on-demand"` is a working configuration,
 * not a broken one — it means the edge resizes — and the only way to tell the
 * two apart from the outside is to say so here.
 */
export interface StorageInspection {
  id: string;
  variants: "on-demand" | "pregenerate" | null;
  processor: string | null;
  /** `null` when files are kept forever. */
  purgeAfter: string | null;
}

export interface CmsInspection {
  basePath: string;
  database: { id: string; capabilities: DatabaseCapabilities };
  storage: StorageInspection | null;
  collections: CollectionInspection[];
  schema: SchemaSnapshot;
  hooks: HookPipelineEntry[];
  /** Every route the handler answers, core and plugin, in match order. */
  routes: RouteInspection[];
  admin: AdminInspection;
  plugins: PluginInspection[];
  auth: AuthInspection;
  /**
   * The AI surface, printed.
   *
   * `actions` is the registry rather than the configuration: a plugin that
   * registered `tone-of-voice` has to be visible to somebody debugging why
   * the button is missing from a field that names it.
   */
  ai: {
    enabled: boolean;
    defaultModel: { provider: string; model: string } | null;
    /** Whether the panel-wide agent is configured and switched on. */
    assistant: boolean;
    actions: string[];
    /** Providers with credentials in the configuration. Never the keys. */
    providers: string[];
    /** Whether keys can also be stored in the database. */
    panelManagedKeys: boolean;
  };
  webhooks: { enabled: boolean; signed: boolean; retries: number };
  /** Rich-text nodes and marks, with the serialisers each one carries. */
  editor: EditorSchemaDescription;
  /** Registered sweeps, in the order `cms.jobs.run()` runs them. */
  jobs: string[];
  /** What a delete does, printed because it is the surprising one. */
  trash: { enabled: boolean; purgeAfter: string | null };
}

/**
 * What the HTTP layer answers with.
 *
 * One function, whatever the runtime: Node, Bun, Workers and Lambda all speak
 * `Request → Response`, so a framework adapter is a wrapper around this and
 * nothing more (section 10).
 */
export type CmsHandler = (
  request: Request,
  options?: CmsHandlerOptions,
) => Promise<Response>;

/** What a framework adapter may hand the handler besides the request. */
export interface CmsHandlerOptions {
  /**
   * The platform's way to keep working after the response: Cloudflare's
   * `ctx.waitUntil`, Vercel's `waitUntil`. With it, the events a write
   * produced are delivered before the runtime freezes — webhooks, listeners,
   * plugins such as `indexNow()` — instead of on the next request or the
   * next cron. Without it, delivery is still started in the background,
   * which is all a long-running server needs.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** The internal router, exposed for tests and inspection. */
export interface CmsRouter {
  routes(): RouteInspection[];
}

/** The object `heyoCms()` returns. */
export interface CmsInstance<
  TCollections extends CollectionsConfig = CollectionsConfig,
  TGlobals extends GlobalsConfig = GlobalsConfig,
> {
  /** Frozen, fully resolved configuration. */
  readonly _config: ResolvedCmsConfig;
  /**
   * The whole HTTP surface: the API, the panel and every plugin route.
   *
   * `basePath` is stripped from the incoming URL and the rest is matched, so
   * one catch-all route in any framework mounts everything, and a route added
   * to the core or to a plugin needs no change in the application
   * (section 10). Built on the first call, not at configuration time: a CLI
   * that only generates a migration never pays for it.
   */
  readonly handler: CmsHandler;
  /** The router behind `handler`. For tests and tooling. */
  readonly _router: CmsRouter;
  /** The schema the configuration implies; the `to` side of every migration. */
  readonly schema: SchemaSnapshot;
  readonly collections: TCollections;
  /**
   * The local API: `cms.api.posts.find()`, typed from the collection.
   *
   * No HTTP and no serialisation, but the same access control, hooks and
   * events as the REST route that wraps it (section 10).
   */
  readonly api: LocalApi<TCollections>;
  /**
   * The singletons: `cms.globals.settings.get()`.
   *
   * Separate from `cms.api` because the operations differ — a global has no
   * `find` and no `create` — not because the machinery does. Underneath it is
   * the same `documents` table, the same hooks, the same events (stage 5).
   */
  readonly globals: GlobalsApi<TGlobals>;
  /**
   * Editor authentication and RBAC: sessions, invitations, API keys, roles.
   *
   * The same object the HTTP routes will call in stage 7, available without
   * HTTP so a seed script can create the first administrator.
   */
  readonly auth: CmsAuth;
  /**
   * Files: upload, library, variants and the lifecycle.
   *
   * Present whether or not `uploads` is configured, because the alternative
   * is an optional property every caller has to narrow; without a storage
   * adapter every method answers with one error that names the missing
   * section (section 3: media is not a plugin).
   */
  readonly media: CmsMedia;
  /**
   * Field actions and the panel-wide assistant.
   *
   * Present whether or not `ai` is configured, for the same reason `media`
   * is: without the section every method answers with one error naming what
   * is missing, rather than an optional property every caller must narrow.
   */
  readonly ai: CmsAi;
  /** Subscriptions, deliveries, retries and replay (section 7). */
  readonly webhooks: CmsWebhooks;
  /** Deleted documents, across collections: list, restore, purge. */
  readonly trash: CmsTrash;
  /** The sweeps: scheduled changes and the expired trash. */
  readonly jobs: CmsJobs;
  /**
   * Which languages exist: `i18n.locales`, with the name of each one.
   *
   * An instance method rather than a lookup the caller writes itself, so a
   * panel, a seed script and a `curl` agree on what the list is (section 9).
   */
  readonly locales: CmsLocales;
  /** The audit trail the engine writes. Read-only, by design. */
  readonly activity: CmsActivity;
  inspect(): CmsInspection;
  /** Resolves the adapter, building it on first use. */
  database(): Promise<DatabaseAdapter>;
  /** Subscribes to a committed event. Returns an unsubscribe function. */
  on(type: AnyEventType, listener: CmsEventListener): () => void;
  /**
   * Delivers pending outbox events now, and waits for them.
   *
   * A commit already schedules delivery in the background. This is how a
   * test, a CLI or a runtime that is about to freeze makes sure nothing is
   * left in the table.
   */
  drainEvents(limit?: number): Promise<number>;
  close(): Promise<void>;
}
