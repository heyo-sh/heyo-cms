import type { Actor } from "./actor";
import type { AiCompletionFn } from "./ai";
import type { DatabaseConfig } from "./database";
import type {
  AiModelRef,
  FieldDefinition,
  FieldsConfig,
  InferFieldValue,
} from "./fields";
import type {
  CollectionDatabaseHooks,
  DatabaseHooks,
  HttpHooks,
} from "./hooks";
import type { JsonObject } from "./json";
import type { Where } from "./query";
import type { ImageProcessor } from "./media";
import type { CmsPlugin } from "./plugin";
import type { StorageConfig } from "./storage";
import type { TelemetryConfig } from "./telemetry";

/** `30d`, `10s`, `7d`. Parsed once, at configuration build time. */
export type Duration = `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`;

/** `25mb`, `512kb`. Same reasoning as `Duration`. */
export type ByteSize = `${number}${"b" | "kb" | "mb" | "gb"}`;

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

/**
 * What a rule is asked about.
 *
 * `restore` and `purge` are not separate rules — `access` is CRUD only in v1
 * (section 3) — but they are separate *questions*, and both are put to the
 * `delete` rule, which is the rule that governs a document leaving. A rule
 * that cares can branch on `operation`; one that does not keeps working
 * unchanged.
 */
export type AccessOperation =
  "read" | "create" | "update" | "delete" | "restore" | "purge";

export interface AccessContext {
  actor: Actor | null;
  operation: AccessOperation;
  locale: string | null;
  /** The stored row, for rules that depend on it (`record.authorId`). */
  record?: JsonObject;
}

/**
 * `true`, `false`, or a filter.
 *
 * Returning a `Where` is the important case: the filter is added to the query
 * (`and(requestWhere, accessWhere)`) rather than applied to the results, so a
 * row the actor may not read is never fetched, never counted and never paged
 * over (stage 4).
 */
export type AccessResult = boolean | Where;

export type AccessRule = (
  context: AccessContext,
) => AccessResult | Promise<AccessResult>;

/**
 * Collection access in v1: CRUD and nothing else.
 *
 * Publishing is not an action — it is a write to the `status` field, governed
 * by field-level access (section 11). Plugins may register extra actions at
 * the permission level without widening this type.
 *
 * A missing rule is not "allowed". When `rbac` is configured, the engine
 * requires the `collection:action` permission instead; a rule that is present
 * is the final word and RBAC is not consulted for it.
 */
export interface CollectionAccess {
  read?: AccessRule;
  create?: AccessRule;
  update?: AccessRule;
  delete?: AccessRule;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface CollectionAdminOptions {
  /** Field used as the row title in lists. Defaults to `title`, then `name`. */
  useAsTitle?: string;
  defaultColumns?: string[];
  group?: string;
  description?: string;
}

export interface CollectionDefinitionInput<TFields extends FieldsConfig> {
  fields: TFields;
  label?: string;
  /** URL and storage name. Defaults to the key in `collections`. */
  slug?: string;
  access?: CollectionAccess;
  admin?: CollectionAdminOptions;
}

export interface CollectionDefinition<
  TFields extends FieldsConfig = FieldsConfig,
> extends CollectionDefinitionInput<TFields> {
  readonly kind: "collection";
}

export interface GlobalDefinition<
  TFields extends FieldsConfig = FieldsConfig,
> extends Omit<CollectionDefinitionInput<TFields>, "access"> {
  readonly kind: "global";
  access?: Omit<CollectionAccess, "create" | "delete">;
}

export type CollectionsConfig = Record<string, CollectionDefinition>;
export type GlobalsConfig = Record<string, GlobalDefinition>;

/** System columns every document carries, whatever its collection. */
export interface SystemDocumentFields {
  id: string;
  /**
   * How many times this document has been written. Starts at `1`.
   *
   * The precondition token for a concurrent edit: pass it back as
   * `expectedRevision` and the write is refused with `409` if anybody — another
   * editor, a scheduled change, the AI assistant — got there first. Without it
   * the last writer wins silently, which is only acceptable while there is one
   * writer.
   */
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  /** Set while the document is in the trash; `null` while it is live. */
  deletedAt: string | null;
  /** When the purge job will remove a trashed document. `null` means never. */
  purgeAfter: string | null;
  scheduledAt: string | null;
  /**
   * The field values a scheduled change will write, or `null`.
   *
   * The patch itself, not the actor that scheduled it: a panel has to show
   * "this will become published on Friday", and nothing outside the engine
   * has any business reading whose authority the change will carry.
   */
  scheduledPatch: Record<string, unknown> | null;
  /**
   * Which fields were answered from `i18n.defaultLocale`, and nothing else.
   *
   * Present whenever a read had to substitute, and absent when it did not.
   * Typed here rather than left undeclared because a panel listing missing
   * translations has to read it, and a frontend showing an "untranslated"
   * badge has to see it exists (section 9).
   */
  _fallback?: Record<string, string>;
}

/**
 * The same columns on a global.
 *
 * The timestamps are nullable because a global that nobody has saved yet is
 * still readable — it reads as its defaults — and claiming it was created at
 * some particular moment would be an invention (section 5, `GlobalApi.get`).
 */
export interface GlobalDocumentFields extends Omit<
  SystemDocumentFields,
  "createdAt" | "updatedAt"
> {
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * The document type a collection produces.
 *
 * Localized fields disappear from this type: a read always resolves one
 * locale before the value reaches a hook, the API or a template, so consumers
 * never branch on whether a field happens to be translated (section 9).
 */
export type InferDocument<TCollection> =
  TCollection extends CollectionDefinition<infer TFields>
    ? {
        [K in keyof TFields]: InferFieldValue<TFields[K]>;
      } & SystemDocumentFields
    : TCollection extends GlobalDefinition<infer TGlobalFields>
      ? {
          [K in keyof TGlobalFields]: InferFieldValue<TGlobalFields[K]>;
        } & GlobalDocumentFields
      : never;

/** Every document type in a configuration, keyed by collection name. */
export type InferDocuments<TCollections extends CollectionsConfig> = {
  [K in keyof TCollections]: InferDocument<TCollections[K]>;
};

// ---------------------------------------------------------------------------
// Editor authentication and RBAC
// ---------------------------------------------------------------------------

export type AuthMethod =
  "password" | "magic-link" | "github" | "google" | "microsoft";

export interface OidcConfig {
  readonly kind: "oidc";
  issuer: string;
  clientId?: string;
  clientSecret?: string;
  /** Maps provider claims onto CMS roles. */
  mapRoles?: (claims: Record<string, unknown>) => string[];
  /** Defaults to `openid email profile`. */
  scope?: string;
  /**
   * Creates an account on first successful sign-in.
   *
   * On by default, because just-in-time provisioning is the reason a company
   * buys SSO: access is decided in the identity provider, and asking an
   * administrator to pre-create every user defeats it. Set `false` to require
   * an invitation first.
   */
  provision?: boolean;
}

/** Client credentials for one OAuth provider. */
export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  /** Overrides the provider's default scope. */
  scope?: string;
}

export interface ApiKeyConfig {
  enabled: boolean;
  /** Coarse scopes a key can be issued with. */
  scopes?: string[];
  expiresIn?: Duration;
}

export interface PasswordPolicy {
  /** Length only. Composition rules push people towards `Passw0rd!`. */
  minLength?: number;
}

/**
 * A single-use link the application has to put in front of a person.
 *
 * The CMS mints tokens and never sends email (section 10), which works for
 * `cms.auth.magicLink.request()` — the caller is server code and can hand the
 * token to its own mailer. Over HTTP the caller is an anonymous browser, so
 * returning the token there would let a stranger request a magic link for an
 * administrator and read it out of the response. This function is the way the
 * token reaches a mailbox instead: without it the magic-link and
 * password-reset routes are not registered at all, and `cms.inspect().routes`
 * says so.
 */
export interface TokenDelivery {
  type: "magic-link" | "password-reset";
  token: string;
  expiresAt: string;
  email: string;
  userId: string;
  /**
   * The panel URL that consumes the token, absolute, derived from the
   * request that asked for it. The whole message is usually this one link.
   */
  url: string;
}

export interface EditorAuthConfig {
  readonly kind: "cms-users";
  methods: AuthMethod[];
  sso?: OidcConfig;
  twoFactor?: boolean;
  /**
   * API keys are an authentication method, not a feature: a key produces an
   * `Actor` exactly like a session does (section 11).
   */
  apiKeys?: ApiKeyConfig;
  session?: { expiresIn?: Duration };
  invites?: { expiresIn?: Duration };
  /**
   * Client credentials per provider.
   *
   * Optional, and resolved at sign-in rather than at build time: a template
   * that lists `github` must still start on a laptop where the secret is not
   * set yet. Missing credentials fail the sign-in attempt, naming the
   * provider and the environment variables that would satisfy it.
   */
  providers?: Record<string, OAuthCredentials>;
  password?: PasswordPolicy;
  magicLink?: { expiresIn?: Duration };
  passwordReset?: { expiresIn?: Duration };
  /**
   * Who claims the deployment when nobody has yet.
   *
   * A CMS with no accounts has a chicken-and-egg problem: the panel is behind
   * authentication, and the only way to create an account through the panel is
   * to be signed in. `heyo-cms create-admin` solves it from a shell; this
   * solves it from the sign-in screen, which is where somebody who just
   * deployed is already standing.
   *
   * The route exists only while `cms_users` is empty — it is not a route that
   * has to be remembered and closed, because the first account closes it, and
   * the check happens inside the same transaction as the insert so two
   * browsers racing produce one administrator and one 409.
   *
   * `false` turns it off for a deployment that would rather provision its
   * first editor from a pipeline.
   */
  firstUser?: FirstUserConfig;
  /**
   * Delivers a single-use link to its owner.
   *
   * Required for the magic-link and password-reset HTTP routes to exist, for
   * the reason spelled out on `TokenDelivery`. The local API does not need it.
   */
  deliverToken?: (message: TokenDelivery) => void | Promise<void>;
}

/**
 * The first account, claimed from the sign-in screen.
 *
 * `true` is the default and means "an account with the `admin` role". The
 * object form is for a deployment whose `rbac.roles` calls that role something
 * else — the roles named here must exist once `rbac` is configured, for the
 * same reason every other role assignment must.
 */
export type FirstUserConfig = boolean | { roles?: string[] };

/** One file of the panel bundle, as the handler serves it. */
export interface AdminAsset {
  body: Uint8Array | string | ReadableStream;
  contentType: string;
  /** `immutable` for a hashed filename, `no-cache` for the shell. */
  cacheControl?: string;
  /** Serves `If-None-Match` without touching the bundle again. */
  etag?: string;
}

/**
 * Where the panel's files come from.
 *
 * An interface rather than a path because the bundle has to be readable from
 * a Worker, where there is no filesystem: `@heyo-sh/heyo-cms-admin` ships one
 * of these in stage 8 with the files inlined, and a self-hosted deployment can
 * implement it over a directory or a CDN. Without it the handler serves a
 * plain page under `admin.path` saying what is missing, rather than a 404 that
 * looks like a broken mount.
 */
/**
 * Where the panel is mounted, handed to the bundle before it serves anything.
 *
 * A bundle is static and a mount point is not: the same files are served at
 * `/api/heyo-cms/admin` in one project and at `/cms` in the next, and the
 * single-page application has to know which, because every request it makes
 * is to `basePath` and every link it writes is under `panelPath`. Guessing
 * that from the browser's URL fails on the first deep link, so the handler
 * tells the bundle once, while the router is being built.
 */
export interface AdminMountContext {
  /** Where the API answers. Absolute, `basePath` included. */
  basePath: string;
  /** Where the panel answers. Absolute, `basePath` + `admin.path`. */
  panelPath: string;
  title: string;
}

export interface AdminAssets {
  /** Printed by `cms.inspect().admin.panel`. */
  readonly id: string;
  /**
   * Called once, before the first request, with the mount point.
   *
   * Optional: a bundle that hard-codes its paths, or serves a directory of
   * files that contain none, does not need it.
   */
  configure?(context: AdminMountContext): void;
  /** `""` is the shell; `"assets/app.js"` is a file. `null` is not found. */
  asset(path: string): Promise<AdminAsset | null>;
}

export interface AdminConfig {
  /** Where the panel is served from, under `basePath`. */
  path?: string;
  auth?: EditorAuthConfig;
  /** Shown in the panel, and used as the issuer in an authenticator app. */
  title?: string;
  /** The panel bundle. Supplied by `@heyo-sh/heyo-cms-admin` in stage 8. */
  assets?: AdminAssets;
}

/**
 * Roles and what they may do.
 *
 * Declaring this section switches the default for every collection without an
 * `access` rule from "open" to "needs `collection:action`", which is the only
 * safe reading once roles exist at all.
 */
export interface RbacConfig {
  /** `{ editor: ["posts:*", "media:*"] }`. `*` is allowed on both sides. */
  roles: Record<string, string[]>;
  /** Roles created in the panel and stored in `cms_roles`. */
  customRoles?: boolean;
  /** Role given to a user with no explicit assignment. */
  defaultRole?: string;
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

/**
 * The languages the content is written in.
 *
 * ```ts
 * i18n: { defaultLocale: "en", locales: ["en", "fr"] }
 * ```
 *
 * Codes, not objects: the English name of a language and whether it is
 * written right to left follow from the code, so there is nothing else to
 * type and nothing else to keep in sync. Leaving the section out is the same
 * as `{ defaultLocale: "en", locales: ["en"] }` — one language, which is what
 * a site that never thinks about translation wants.
 *
 * A field with no value in the requested language falls back to
 * `defaultLocale` and says so through `_fallback`; a single call can override
 * that with `fallbackLocale` (section 9).
 */
export interface I18nConfig {
  /** BCP 47 codes: `["en", "pt-BR"]`. Defaults to `[defaultLocale]`. */
  locales?: string[];
  /** Must be one of `locales`. Defaults to the first one, or `"en"`. */
  defaultLocale?: string;
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export interface UploadLimits {
  maxFileSize?: ByteSize;
  maxImageDimensions?: { width: number; height: number };
  /** MIME whitelist; `image/*` style wildcards allowed. */
  accept?: string[];
}

export interface ImageSizeConfig {
  width?: number;
  height?: number;
  fit?: "cover" | "contain" | "inside" | "outside";
}

/**
 * When image variants are produced.
 *
 * `on-demand` keeps one original in storage and renders a variant on first
 * request, so a size added next year applies to the whole archive.
 * `pregenerate` writes every size at upload time, which is the only option on
 * plain Node with local disk (section 6).
 */
export type VariantMode = "on-demand" | "pregenerate";

export interface ImagesConfig {
  convert?: { to: "webp" | "avif"; keep?: string[] };
  quality?: number;
  /**
   * Strips EXIF, including the GPS coordinates phone cameras embed.
   *
   * Performed by the engine itself for JPEG, PNG and WebP, so it works on
   * every runtime whether or not a `processor` is configured: publishing
   * somebody's home address along with their photograph is a privacy
   * obligation, not an optimisation (section 6).
   */
  stripMetadata?: boolean;
  /** Downscale applied before anything reaches storage. Needs a `processor`. */
  maxDimensions?: { width: number; height: number };
  focalPoint?: boolean;
  crop?: boolean;
  variants?: {
    mode: VariantMode;
    sizes: Record<string, ImageSizeConfig>;
  };
  /**
   * What actually resizes and converts pixels.
   *
   * Required for `convert`, `maxDimensions` and `variants.mode:
   * "pregenerate"`, because each of those is a promise to produce bytes that
   * do not exist yet. Optional for `on-demand` variants, where leaving it out
   * is a real deployment rather than an oversight: the original is served and
   * its URL carries the size for an image CDN to render at the edge.
   */
  processor?: ImageProcessor;
}

/**
 * The media lifecycle from section 6.
 *
 * Losing the last reference marks a file `orphaned`; it keeps serving for
 * `purgeAfter`, and using it again reclaims it. `purgeAfter: false` disables
 * deletion entirely.
 */
export interface RetentionConfig {
  orphanAfterUnreferenced?: boolean;
  purgeAfter?: Duration | false;
  reclaimOnReference?: boolean;
}

export interface UploadsConfig {
  storage: StorageConfig;
  limits?: UploadLimits;
  images?: ImagesConfig;
  retention?: RetentionConfig;
  /**
   * Where the site serves its own files, outside the API: `"/media"`.
   *
   * With it, `cms.handler` answers `GET /media/<id>/<name>` and
   * `/media/<id>/<size>/<name>` — mount the handler on that path as well as
   * on `basePath` — and every URL the CMS produces for a file points there:
   * `MediaDocument.url`, `cms.media.url()`, `srcset`s and rich text. The name
   * at the end is the uploaded file name as a slug, for people and image
   * search; the route ignores it. Responses are cacheable for a year, because
   * the bytes behind an id never change.
   *
   * Without it, files are served from `<basePath>/media/<id>/<size>` — which
   * works, but sits under the API path a `robots.txt` usually closes.
   */
  publicPath?: string;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export type AiAuth =
  | { type: "api-key"; token: string }
  | {
      type: "aws";
      region: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    }
  | { type: "oauth"; getAccessToken: () => Promise<string> };

/**
 * The panel-wide assistant.
 *
 * Nothing here lists collections, fields or permissions, and that absence is
 * the design. A whitelist in configuration is a second access-control system
 * that drifts from the real one: the agent discovers the schema at runtime
 * through `describe_cms` and every read and write it performs is checked
 * against the live configuration and the signed-in actor. What is left to
 * configure is the model, one standing instruction, and the limits.
 */
export interface AiAssistantConfig {
  /** `false` removes the routes. Absent is the same as absent `ai`. */
  enabled?: boolean;
  /** Defaults to `ai.defaultModel`. */
  model?: AiModelRef;
  /**
   * Prepended to the system prompt.
   *
   * House style, language, editorial rules. It cannot widen what the agent
   * may do: policy is enforced by the tools, not by the prompt, because a
   * prompt is a request and a tool is a gate.
   */
  instructions?: string;
  /** Agent turns, not user messages. Defaults to 8. */
  maxTurns?: number;
  /** Tool calls across the whole run. Defaults to 16. */
  maxToolCalls?: number;
  /** Milliseconds before the run is aborted. Defaults to 90_000. */
  timeoutMs?: number;
}

/**
 * Global AI settings: credentials, the default model, and the assistant.
 *
 * There is no task list here. What AI can do on a field lives on the field
 * that can do it (section 8); what it can do across the panel is the
 * assistant, and the only global switch for either is the absence of this
 * section.
 */
export interface AiConfig {
  /**
   * Credentials per provider, from the environment.
   *
   * Optional, because `storage.secret` is the other way to get them: a
   * deployment that lets an administrator paste a key into the panel has no
   * key at build time, and demanding a placeholder would be theatre.
   */
  auth?: Record<string, AiAuth>;
  defaultModel: AiModelRef;
  /** The panel-wide agent. Absent switches it off entirely. */
  assistant?: AiAssistantConfig;
  /**
   * Lets provider keys be managed in the panel.
   *
   * The secret encrypts them (AES-GCM) before they are stored, so a copy of
   * the database is not a copy of the keys. Rotating it invalidates every
   * stored key, which is what rotating a key-encryption key means; the panel
   * says so when a key stops decrypting. A key stored here wins over
   * `auth`, because it is the more recent decision by whoever could see both.
   */
  storage?: { secret: string };
  /**
   * Replaces pi as the thing that talks to a model.
   *
   * The same escape hatch `uploads.images.processor` is: a proxy in front of
   * a corporate gateway, a self-hosted model, or a test that must not make a
   * network call. Without it, `@mariozechner/pi-ai` is loaded on first use.
   */
  complete?: AiCompletionFn;
}

// ---------------------------------------------------------------------------
// Webhooks, trash
// ---------------------------------------------------------------------------

export interface WebhooksConfig {
  enabled: boolean;
  signing?: { algorithm: "hmac-sha256"; secret: string };
  delivery?: {
    retries?: number;
    backoff?: "exponential" | "linear";
    timeout?: Duration;
    dlq?: boolean;
  };
  managedInAdmin?: boolean;
}

export interface TrashConfig {
  enabled: boolean;
  purgeAfter?: Duration | false;
}

// ---------------------------------------------------------------------------
// The configuration itself
// ---------------------------------------------------------------------------

export interface HeyoCmsConfig<
  TCollections extends CollectionsConfig = CollectionsConfig,
  TGlobals extends GlobalsConfig = GlobalsConfig,
> {
  database: DatabaseConfig;
  /** Where the handler is mounted. Defaults to `/api/heyo-cms`. */
  basePath?: string;
  admin?: AdminConfig;
  rbac?: RbacConfig;
  i18n?: I18nConfig;
  uploads?: UploadsConfig;
  ai?: AiConfig;
  webhooks?: WebhooksConfig;
  trash?: TrashConfig;
  collections: TCollections;
  globals?: TGlobals;
  /**
   * Data-level hooks, keyed by collection or global (section 5).
   *
   * Globals are in the key set because they are written through the same path
   * and run the same `update` hooks; a singleton nobody can hook is a
   * singleton that cannot validate itself.
   */
  databaseHooks?: DatabaseHooks<TCollections & TGlobals>;
  /** HTTP-level hooks: rate limiting, headers, telemetry. */
  hooks?: HttpHooks;
  plugins?: CmsPlugin<unknown>[];
  /**
   * Adoption telemetry, which only the CLI sends and only a developer's
   * machine runs (`/telemetry`). `{ enabled: false }` turns it off.
   */
  telemetry?: TelemetryConfig;
  /** Where generated migrations live. Defaults to `./migrations`. */
  migrations?: { directory?: string };
}

/** The configuration after defaults are filled in and names are resolved. */
export interface ResolvedCollection {
  name: string;
  slug: string;
  label: string;
  kind: "collection" | "global";
  fields: Record<string, FieldDefinition>;
  access: CollectionAccess;
  admin?: CollectionAdminOptions;
}

/**
 * A hook a plugin installed through `extendCollections()`.
 *
 * Flattened at configuration time rather than looked up per write, and
 * carried with the id of the plugin that brought it so `cms.inspect()` can
 * print who is in the pipeline and in what order (section 5).
 */
export interface ResolvedPluginHooks {
  plugin: string;
  collection: string;
  hooks: CollectionDatabaseHooks;
  priority: number;
}

export interface ResolvedCmsConfig {
  basePath: string;
  database: DatabaseConfig;
  admin: Required<Pick<AdminConfig, "path">> & AdminConfig;
  rbac?: RbacConfig;
  i18n: Required<I18nConfig>;
  uploads?: UploadsConfig;
  ai?: AiConfig;
  webhooks?: WebhooksConfig;
  trash: Required<TrashConfig>;
  collections: Record<string, ResolvedCollection>;
  globals: Record<string, ResolvedCollection>;
  hooks?: HttpHooks;
  databaseHooks?: DatabaseHooks<CollectionsConfig>;
  plugins: CmsPlugin<unknown>[];
  /** Collection hooks contributed by plugins, in the order they will run. */
  pluginHooks: ResolvedPluginHooks[];
  telemetry?: TelemetryConfig;
  migrationsDirectory: string;
}
