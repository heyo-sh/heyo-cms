import type {
  CollectionsConfig,
  GlobalsConfig,
  InferDocument,
} from "../types/config";
import type { CmsInstance } from "../types/instance";
import type { ActivityListArgs, ActivityPage } from "../types/activity";
import type { ApiKeyRecord, CmsUser, IssuedApiKey, RoleRecord, SignInResult } from "../types/auth"; // prettier-ignore
import type { FindResult, PreviousSlug, SlugResolution } from "../types/api";
import type { JsonObject } from "../types/json";
import type { LocaleRecord } from "../types/locales";
import type {
  MediaDocument,
  MediaListResult,
  MediaUsage,
} from "../types/media";
import type { CmsPlugin } from "../types/plugin";
import type { OrderBy, Where } from "../types/query";
import type { TrashPage } from "../types/trash";
import type { JobFailure, JobRunReport } from "../types/jobs";

/**
 * The typed client's argument types.
 *
 * Shaped after the local API on purpose: `client.posts.find({ where: eq(...) })`
 * and `cms.api.posts.find({ where: eq(...) })` take the same object, because
 * the second is what the first ends up calling (section 10). The filter
 * helpers from `@heyo-sh/heyo-cms/query` therefore work on both sides of the
 * network, and there is one query language in the product rather than one per
 * transport.
 */

export interface ClientLocaleArgs {
  locale?: string;
  fallbackLocale?: string | false;
}

export interface ClientReadArgs extends ClientLocaleArgs {
  depth?: number;
  includeTrashed?: boolean;
  /** Per-call headers, e.g. a one-off `authorization`. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ClientFindArgs extends ClientReadArgs {
  where?: Where;
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
  cursor?: string;
  count?: boolean;
}

export type ClientInput<TDoc> = Partial<
  Omit<
    TDoc,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "updatedBy"
    | "deletedAt"
    | "purgeAfter"
    | "scheduledAt"
    | "scheduledPatch"
    | "_fallback"
  >
>;

export interface ClientCreateArgs<TDoc> extends ClientReadArgs {
  data: ClientInput<TDoc>;
}

export interface ClientUpdateArgs<TDoc> extends ClientReadArgs {
  id: string;
  data: ClientInput<TDoc>;
}

export interface ClientDeleteArgs extends ClientReadArgs {
  id: string;
  /** Skips the trash. Governed by the `purge` permission. */
  permanent?: boolean;
}

export interface ClientScheduleArgs<TDoc> extends ClientReadArgs {
  id: string;
  at: Date | string;
  data: ClientInput<TDoc>;
}

/**
 * One collection, over HTTP.
 *
 * A write answers `null` when a `before` hook stopped it — the 204 the route
 * sends — so the client's return types match the local API's exactly and code
 * can move between them without a change.
 */
export interface ClientCollection<TDoc> {
  find(args?: ClientFindArgs): Promise<FindResult<TDoc>>;
  findById(id: string, args?: ClientReadArgs): Promise<TDoc | null>;
  create(args: ClientCreateArgs<TDoc>): Promise<TDoc | null>;
  update(args: ClientUpdateArgs<TDoc>): Promise<TDoc | null>;
  delete(args: ClientDeleteArgs): Promise<TDoc | null>;
  restore(args: { id: string } & ClientReadArgs): Promise<TDoc | null>;
  schedule(args: ClientScheduleArgs<TDoc>): Promise<TDoc | null>;
  unschedule(args: { id: string } & ClientReadArgs): Promise<TDoc | null>;
  /** `GET /<collection>/resolve-slug`; null when no readable document has it. */
  resolveSlug(
    slug: string,
    args?: { field?: string } & Omit<ClientReadArgs, "includeTrashed">,
  ): Promise<SlugResolution<TDoc> | null>;
  previousSlugs(
    args: { id: string; field?: string } & ClientLocaleArgs & ClientCallArgs,
  ): Promise<PreviousSlug[]>;
  addPreviousSlug(
    args: { id: string; slug: string; field?: string } & ClientLocaleArgs & ClientCallArgs, // prettier-ignore
  ): Promise<PreviousSlug[]>;
  removePreviousSlug(
    args: { id: string; slug: string; field?: string } & ClientLocaleArgs & ClientCallArgs, // prettier-ignore
  ): Promise<PreviousSlug[]>;
}

/** Per-call transport options. */
export interface ClientCallArgs {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ClientGlobal<TDoc> {
  get(args?: ClientReadArgs): Promise<TDoc>;
  update(args: { data: ClientInput<TDoc> } & ClientReadArgs): Promise<TDoc | null>; // prettier-ignore
  schedule(
    args: { at: Date | string; data: ClientInput<TDoc> } & ClientReadArgs,
  ): Promise<TDoc | null>;
  unschedule(args?: ClientReadArgs): Promise<TDoc | null>;
}

export interface ClientUploadArgs {
  file: Blob | Uint8Array | ArrayBuffer;
  filename?: string;
  contentType?: string;
  alt?: string;
  locale?: string;
  metadata?: JsonObject;
  signal?: AbortSignal;
}

export interface ClientMedia {
  upload(args: ClientUploadArgs | File): Promise<MediaDocument>;
  list(args?: {
    status?: MediaDocument["status"];
    mimeType?: string;
    search?: string;
    limit?: number;
    cursor?: string;
  }): Promise<MediaListResult>;
  get(id: string): Promise<MediaDocument | null>;
  update(args: {
    id: string;
    filename?: string;
    alt?: string | Record<string, string>;
    locale?: string;
    focalPoint?: { x: number; y: number } | null;
    crop?: { x: number; y: number; width: number; height: number } | null;
    metadata?: JsonObject;
  }): Promise<MediaDocument>;
  delete(args: { id: string; force?: boolean }): Promise<MediaDocument>;
  keep(args: { id: string }): Promise<MediaDocument>;
  usages(id: string): Promise<MediaUsage[]>;
  /**
   * The URL of a size, built rather than fetched.
   *
   * A string, not a request: this is what goes into an `<img src>`, and a
   * client that had to await the bytes to produce a URL would make rendering
   * a list of thumbnails a waterfall.
   */
  url(id: string, variant?: string): string;
}

export interface ClientAuth {
  signIn(args: { email: string; password: string }): Promise<SignInResult>;
  /**
   * Creates the first account on a CMS that has none, and signs it in.
   *
   * Answers 409 once any account exists; `GET /panel` reports whether it is
   * still open as `auth.setupRequired`.
   */
  claimFirstAccount(args: {
    email: string;
    password: string;
    name?: string;
  }): Promise<SignInResult>;
  signOut(): Promise<void>;
  session(): Promise<{ actor: unknown | null; user: CmsUser | null }>;
  magicLink(args: { email: string }): Promise<{ status: string }>;
  verifyMagicLink(args: { token: string }): Promise<SignInResult>;
  forgotPassword(args: { email: string }): Promise<{ status: string }>;
  resetPassword(args: { token: string; password: string }): Promise<{ user: CmsUser }>; // prettier-ignore
  acceptInvite(args: {
    token: string;
    password?: string;
    name?: string;
  }): Promise<SignInResult>;
  verifyTwoFactor(args: { challenge: string; code: string }): Promise<SignInResult>; // prettier-ignore
  beginTwoFactor(): Promise<{ secret: string; uri: string }>;
  enableTwoFactor(args: { code: string }): Promise<{ user: CmsUser }>;
  disableTwoFactor(): Promise<{ user: CmsUser }>;
  apiKeys: {
    list(): Promise<ApiKeyRecord[]>;
    create(args: { name: string; scopes?: string[] }): Promise<IssuedApiKey>;
    revoke(id: string): Promise<void>;
  };
  /** The URL to send a browser to for an OAuth or SSO sign-in. */
  oauthUrl(provider: string, redirectTo?: string): string;
}

export interface ClientUsers {
  list(args?: {
    status?: CmsUser["status"];
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ users: CmsUser[]; totalUsers: number }>;
  get(id: string): Promise<CmsUser | null>;
  update(
    id: string,
    args: {
      name?: string | null;
      roles?: string[];
      status?: CmsUser["status"];
      locale?: string | null;
    },
  ): Promise<CmsUser>;
  invite(args: {
    email: string;
    name?: string;
    roles?: string[];
  }): Promise<{ token: string; expiresAt: string; user: CmsUser }>;
  remove(id: string): Promise<void>;
}

export interface ClientRoles {
  list(): Promise<RoleRecord[]>;
  create(args: {
    name: string;
    permissions: string[];
    label?: string;
  }): Promise<RoleRecord>;
  update(
    name: string,
    args: { permissions?: string[]; label?: string | null },
  ): Promise<RoleRecord>;
  remove(name: string): Promise<void>;
}

export interface ClientTrash {
  list(args?: {
    collection?: string;
    limit?: number;
    cursor?: string;
    locale?: string;
  }): Promise<TrashPage>;
  restore(args: { collection: string; id: string }): Promise<JsonObject>;
  purge(args: { collection: string; id: string }): Promise<JsonObject>;
}

/**
 * The configured languages.
 *
 * Read-only, because `i18n.locales` is code: a client that could add one
 * would be editing a file it cannot see.
 */
export interface ClientLocales {
  list(): Promise<{ locales: LocaleRecord[]; defaultLocale: string }>;
}

export interface ClientJobs {
  run(args?: { limit?: number; only?: string[] }): Promise<JobRunReport>;
  failures(args?: { type?: string; limit?: number }): Promise<JobFailure[]>;
}

/** The escape hatch, and what a plugin's client extension is built on. */
export interface ClientRequest {
  (
    path: string,
    init?: RequestInit & { query?: Record<string, unknown> },
  ): Promise<unknown>;
}

export interface ClientCore {
  baseUrl: string;
  request: ClientRequest;
  media: ClientMedia;
  auth: ClientAuth;
  users: ClientUsers;
  roles: ClientRoles;
  trash: ClientTrash;
  locales: ClientLocales;
  activity: {
    list(args?: ActivityListArgs): Promise<ActivityPage>;
  };
  jobs: ClientJobs;
  openapi(): Promise<JsonObject>;
}

/** Collections become top-level properties, as in `client.posts.find()`. */
export type ClientCollections<TCollections extends CollectionsConfig> = {
  [K in keyof TCollections]: ClientCollection<InferDocument<TCollections[K]>>;
};

export type ClientGlobals<TGlobals extends GlobalsConfig> = {
  [K in keyof TGlobals]: ClientGlobal<InferDocument<TGlobals[K]>>;
};

/**
 * The client for one configuration.
 *
 * `globals` is a property rather than being flattened next to the collections
 * because a global and a collection can share a name in different registries
 * and a flat namespace would make that a silent overwrite.
 */
export type CmsClient<TCms> =
  TCms extends CmsInstance<infer TCollections, infer TGlobals>
    ? ClientCore &
        ClientCollections<TCollections> & { globals: ClientGlobals<TGlobals> }
    : never;

/** Turns a plugin tuple into the intersection of what their clients add. */
export type PluginExtensions<TPlugins extends readonly CmsPlugin<unknown>[]> =
  UnionToIntersection<
    {
      [K in keyof TPlugins]: TPlugins[K] extends CmsPlugin<infer Ext>
        ? Ext
        : never;
    }[number]
  >;

type UnionToIntersection<TUnion> = (
  TUnion extends unknown ? (value: TUnion) => void : never
) extends (value: infer TIntersection) => void
  ? TIntersection
  : never;
