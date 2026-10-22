import type { Actor } from "./actor";
import type { Duration } from "./config";
import type { JsonObject } from "./json";

/**
 * The editor-facing side of authentication.
 *
 * The CMS authenticates editors and nothing else: there is no identity for
 * the users of the application being built (section 0). Everything here is
 * therefore about a small, known set of people — which is why invitations
 * exist and open sign-up does not.
 */

export type CmsUserStatus = "active" | "invited" | "disabled";

export interface CmsUser {
  id: string;
  email: string;
  name: string | null;
  status: CmsUserStatus;
  roles: string[];
  avatarUrl: string | null;
  locale: string | null;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CmsSession {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
}

/** Who is asking, as far as the transport could tell. */
export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * A completed sign-in.
 *
 * `token` is the only moment the session secret exists in plaintext; the
 * database holds its hash. The caller — a route in stage 7, a CLI, a test —
 * decides whether it becomes a cookie or a bearer token.
 */
export interface SignedIn {
  status: "signed-in";
  token: string;
  expiresAt: string;
  session: CmsSession;
  user: CmsUser;
  actor: Actor;
}

/**
 * A password that was correct, on an account that wants a second factor.
 *
 * Returning a session here and "upgrading" it later is the common shortcut
 * and the common vulnerability: the challenge is a separate, short-lived
 * secret that is worth nothing without the code.
 */
export interface TwoFactorRequired {
  status: "two-factor-required";
  challenge: string;
  expiresAt: string;
  userId: string;
}

export type SignInResult = SignedIn | TwoFactorRequired;

/**
 * A single-use secret handed back to the caller.
 *
 * The CMS never sends email. It mints the token and returns it; delivering it
 * is the application's job, which is also why the matching event carries the
 * user and not the secret — a webhook subscriber must not be able to sign in
 * as somebody else.
 */
export interface IssuedToken {
  token: string;
  expiresAt: string;
  userId: string;
  email: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** The visible head of the key, so a panel can tell two keys apart. */
  prefix: string;
  userId: string | null;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface IssuedApiKey extends ApiKeyRecord {
  /** Shown once and never recoverable. */
  key: string;
}

export interface RoleRecord {
  name: string;
  label: string | null;
  permissions: string[];
  /** `config` roles are code; `database` roles are managed in the panel. */
  source: "config" | "database";
}

export interface InviteResult extends IssuedToken {
  user: CmsUser;
}

export interface TwoFactorSetup {
  secret: string;
  /** `otpauth://` — what the QR code in the panel encodes. */
  uri: string;
}

export interface OAuthStart {
  url: string;
  state: string;
}

export interface UserListArgs {
  limit?: number;
  offset?: number;
  status?: CmsUserStatus;
  search?: string;
}

export interface CreateUserArgs {
  email: string;
  password?: string;
  name?: string;
  roles?: string[];
  status?: CmsUserStatus;
  locale?: string;
}

export interface UpdateUserArgs {
  name?: string | null;
  roles?: string[];
  status?: CmsUserStatus;
  locale?: string | null;
  avatarUrl?: string | null;
}

export interface AuthUsersApi {
  list(args?: UserListArgs): Promise<CmsUser[]>;
  get(id: string): Promise<CmsUser | null>;
  byEmail(email: string): Promise<CmsUser | null>;
  count(): Promise<number>;
  create(args: CreateUserArgs & { actor?: Actor | null }): Promise<CmsUser>;
  update(
    id: string,
    args: UpdateUserArgs & { actor?: Actor | null },
  ): Promise<CmsUser>;
  remove(id: string, args?: { actor?: Actor | null }): Promise<void>;
  setPassword(id: string, password: string): Promise<void>;
  /** Creates the account in `invited` state and mints a single-use token. */
  invite(args: {
    email: string;
    roles?: string[];
    name?: string;
    actor?: Actor | null;
  }): Promise<InviteResult>;
  acceptInvite(
    args: { token: string; password?: string; name?: string } & RequestMeta,
  ): Promise<SignedIn>;
}

/**
 * The first account, before there is anybody to authorise it.
 *
 * The only unauthenticated write in the whole API, and it is safe for one
 * reason: it is refused the moment a single account exists. `required()` is
 * what the sign-in screen asks before it decides whether to draw a sign-in
 * form or a "claim this deployment" form.
 */
export interface AuthSetupApi {
  /** `true` while `cms_users` is empty and `admin.auth.firstUser` allows it. */
  required(): Promise<boolean>;
  /**
   * Creates the first account and signs it in.
   *
   * Throws a 409 if an account already exists, including when it was created
   * by another request a millisecond earlier: the count is taken inside the
   * transaction that does the insert.
   */
  claim(
    args: { email: string; password: string; name?: string } & RequestMeta,
  ): Promise<SignedIn>;
}

export interface AuthSessionsApi {
  verify(token: string): Promise<SignedIn | null>;
  list(userId: string): Promise<CmsSession[]>;
  revoke(token: string): Promise<boolean>;
  revokeById(id: string): Promise<boolean>;
  revokeAll(userId: string): Promise<number>;
  /** Deletes expired rows. Called by the session job in stage 9. */
  cleanup(): Promise<number>;
}

export interface AuthPasswordApi {
  signIn(args: { email: string; password: string } & RequestMeta): Promise<SignInResult>; // prettier-ignore
  /** `null` for an unknown address: the response must not confirm accounts. */
  requestReset(args: { email: string }): Promise<IssuedToken | null>;
  reset(args: { token: string; password: string }): Promise<CmsUser>;
}

export interface AuthMagicLinkApi {
  request(args: { email: string }): Promise<IssuedToken | null>;
  verify(args: { token: string } & RequestMeta): Promise<SignInResult>;
}

export interface AuthOAuthApi {
  /** The provider URL plus the state that has to come back with the code. */
  authorize(args: {
    provider: string;
    redirectUri: string;
    redirectTo?: string;
  }): Promise<OAuthStart>;
  callback(
    args: {
      provider: string;
      code: string;
      state: string;
      redirectUri: string;
    } & RequestMeta,
  ): Promise<SignInResult & { redirectTo: string | null }>;
}

export interface AuthTwoFactorApi {
  /** Mints a secret and returns the URI; the factor is not enabled yet. */
  begin(userId: string): Promise<TwoFactorSetup>;
  enable(args: { userId: string; code: string }): Promise<CmsUser>;
  disable(userId: string): Promise<CmsUser>;
  /** Exchanges a challenge plus a code for a session. */
  complete(args: { challenge: string; code: string } & RequestMeta): Promise<SignedIn>; // prettier-ignore
}

export interface AuthApiKeysApi {
  create(args: {
    name: string;
    userId?: string | null;
    scopes?: string[];
    expiresIn?: Duration;
    actor?: Actor | null;
  }): Promise<IssuedApiKey>;
  list(args?: { userId?: string }): Promise<ApiKeyRecord[]>;
  revoke(id: string, args?: { actor?: Actor | null }): Promise<boolean>;
  /** Resolves a key to an actor and stamps `last_used_at`. */
  verify(key: string): Promise<Actor | null>;
}

export interface AuthRolesApi {
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
  remove(name: string): Promise<boolean>;
  /** Flattened permissions for a set of role names, config and database. */
  permissionsFor(roles: string[]): Promise<string[]>;
}

/**
 * `cms.auth`.
 *
 * Everything an editor-facing route in stage 7 will call, available today
 * without HTTP: the local API and the REST API have to share one
 * implementation for the same reason `cms.api` and the document routes do.
 */
export interface CmsAuth {
  /** Session cookie or `Authorization` header, whichever is present. */
  actorFromRequest(request: Request): Promise<Actor | null>;
  /** Session token or API key, by prefix. */
  actorFromToken(token: string): Promise<Actor | null>;
  /** The actor a user would have right now, with roles expanded. */
  actorForUser(user: CmsUser): Promise<Actor>;
  users: AuthUsersApi;
  /** The first account, claimed from the sign-in screen. */
  setup: AuthSetupApi;
  sessions: AuthSessionsApi;
  password: AuthPasswordApi;
  magicLink: AuthMagicLinkApi;
  oauth: AuthOAuthApi;
  twoFactor: AuthTwoFactorApi;
  apiKeys: AuthApiKeysApi;
  roles: AuthRolesApi;
}

/** Claims an OIDC provider returned, before `mapRoles` sees them. */
export type OidcClaims = JsonObject;
