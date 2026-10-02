import type { Actor } from "./actor";
import type { DatabaseConfig } from "./database";
import type {
  AiModelRef,
  FieldDefinition,
  FieldsConfig,
  InferFieldValue,
} from "./fields";
import type { DatabaseHooks, HttpHooks } from "./hooks";
import type { JsonObject } from "./json";
import type { Where } from "./query";
import type { CmsPlugin } from "./plugin";
import type { StorageConfig } from "./storage";

/** `30d`, `10s`, `7d`. Parsed once, at configuration build time. */
export type Duration = `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`;

/** `25mb`, `512kb`. Same reasoning as `Duration`. */
export type ByteSize = `${number}${"b" | "kb" | "mb" | "gb"}`;

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

export interface AccessContext {
  actor: Actor | null;
  operation: "read" | "create" | "update" | "delete";
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

/**
 * Document-wide chat (section 8).
 *
 * `context` is required and that is deliberate: without it the panel would
 * have to ship the whole document to the model, including fields that are
 * sensitive, technical, or simply expensive in tokens. The same list also
 * defines what the chat may write back.
 */
export interface CollectionChatConfig {
  context: string[];
  instructions?: string;
  model?: AiModelRef;
  /** Defaults to `context`. */
  writable?: string[];
  enabled?: boolean;
}

export interface CollectionAiConfig {
  chat?: CollectionChatConfig | false;
}

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
  ai?: CollectionAiConfig;
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
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  deletedAt: string | null;
  scheduledAt: string | null;
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
        } & SystemDocumentFields
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
}

export interface ApiKeyConfig {
  enabled: boolean;
  /** Coarse scopes a key can be issued with. */
  scopes?: string[];
  expiresIn?: Duration;
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
}

export interface AdminConfig {
  /** Where the panel is served from, under `basePath`. */
  path?: string;
  auth?: EditorAuthConfig;
}

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

export interface LocaleDefinition {
  code: string;
  name: string;
  rtl?: boolean;
}

/**
 * What to return when a field has no value in the requested locale.
 *
 * `false` returns `null` and lets the frontend decide — no hidden
 * substitutions. The modes substitute, and `markAsFallback` makes the
 * substitution visible in the response so a panel can list what is missing
 * (section 9).
 */
export type FallbackConfig =
  | false
  | { mode: "default-locale"; markAsFallback?: boolean }
  | {
      mode: "chain";
      chain: Record<string, string[]>;
      markAsFallback?: boolean;
    };

export interface I18nConfig {
  /** `"dynamic"` keeps locales in the database, so adding one is not a migration. */
  locales: "dynamic" | LocaleDefinition[];
  defaultLocale: string;
  fallback?: FallbackConfig;
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
  /** Strips EXIF, including the GPS coordinates phone cameras embed. */
  stripMetadata?: boolean;
  /** Downscale applied before anything reaches storage. */
  maxDimensions?: { width: number; height: number };
  focalPoint?: boolean;
  crop?: boolean;
  variants?: {
    mode: VariantMode;
    sizes: Record<string, ImageSizeConfig>;
  };
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
 * Global AI settings: credentials, the default model, and chat.
 *
 * There is no task list here. What AI can do lives on the field that can do it
 * (section 8), and the only global switch is the absence of this section.
 */
export interface AiConfig {
  auth: Record<string, AiAuth>;
  defaultModel: AiModelRef;
  chat?: { enabled?: boolean; model?: AiModelRef };
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
  /** Data-level hooks, keyed by collection (section 5). */
  databaseHooks?: DatabaseHooks<TCollections>;
  /** HTTP-level hooks: rate limiting, headers, telemetry. */
  hooks?: HttpHooks;
  plugins?: CmsPlugin<never>[];
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
  ai?: CollectionAiConfig;
  admin?: CollectionAdminOptions;
}

export interface ResolvedCmsConfig {
  basePath: string;
  database: DatabaseConfig;
  admin: Required<Pick<AdminConfig, "path">> & AdminConfig;
  rbac?: RbacConfig;
  i18n: Required<Pick<I18nConfig, "locales" | "defaultLocale">> & I18nConfig;
  uploads?: UploadsConfig;
  ai?: AiConfig;
  webhooks?: WebhooksConfig;
  trash: Required<TrashConfig>;
  collections: Record<string, ResolvedCollection>;
  globals: Record<string, ResolvedCollection>;
  hooks?: HttpHooks;
  databaseHooks?: DatabaseHooks<CollectionsConfig>;
  plugins: CmsPlugin<never>[];
  migrationsDirectory: string;
}
