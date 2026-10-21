import {
  expandRoles,
  intersectPermissions,
  scopePermissions,
  wildcard,
} from "../access/permissions";
import { parseDuration } from "../duration";
import { CmsError } from "../errors";
import { createId } from "../ids";
import { and, eq, like, lt, or, orderBy } from "../query";
import type { Actor } from "../types/actor";
import type {
  ApiKeyRecord,
  CmsAuth,
  CmsSession,
  CmsUser,
  CmsUserStatus,
  IssuedApiKey,
  IssuedToken,
  InviteResult,
  RoleRecord,
  RequestMeta,
  SignInResult,
  SignedIn,
  TwoFactorSetup,
} from "../types/auth";
import type {
  EditorAuthConfig,
  OAuthCredentials,
  ResolvedCmsConfig,
} from "../types/config";
import type { DatabaseAdapter } from "../types/database";
import type { JsonObject, JsonValue } from "../types/json";
import type { Row, Tx, Where } from "../types/query";
import type { BufferedEvent, OutboxEntryMeta } from "../engine/outbox";
import { asObject, toIso } from "../engine/documents";
import { hashPassword, hashToken, randomToken, verifyPassword } from "./crypto";
import {
  buildAuthorizeUrl,
  builtinProviders,
  decodeIdToken,
  discoverOidc,
  exchangeCode,
  oidcProfile,
  pkcePair,
  type FetchLike,
  type OAuthEndpoints,
  type OAuthProfile,
  type OAuthProvider,
} from "./oauth";
import { generateTotpSecret, totpUri, verifyTotp } from "./totp";

const usersTable = "cms_users";
const sessionsTable = "cms_sessions";
const tokensTable = "cms_tokens";
const accountsTable = "cms_accounts";
const apiKeysTable = "cms_api_keys";
const rolesTable = "cms_roles";

/** The cookie the panel uses. Named here so stage 7 cannot invent a second. */
export const sessionCookieName = "heyo_cms_session";

/**
 * API keys announce themselves.
 *
 * One `Authorization: Bearer` header carries either a session token or a
 * machine key, and the prefix is what tells them apart without a database
 * round trip against both tables.
 */
export const apiKeyPrefix = "hck_";

const defaultTtl = {
  session: "7d",
  invite: "7d",
  magicLink: "15m",
  passwordReset: "1h",
  /** Long enough to open an authenticator, short enough to be worthless. */
  twoFactor: "10m",
  oauth: "10m",
} as const;

const minPasswordLength = 8;
/** Wrong codes allowed on one challenge before it is destroyed. */
const maxTwoFactorAttempts = 5;
const emailFormat = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;
const roleNameFormat = /^[a-z][a-z0-9_-]*$/;
/** Custom roles change rarely and are read on every sign-in. */
const roleCacheTtl = 10_000;

export interface AuthServiceOptions {
  config: ResolvedCmsConfig;
  database: () => Promise<DatabaseAdapter>;
  /** Appends events to the outbox inside the caller's transaction. */
  emit: (
    tx: Tx,
    events: BufferedEvent[],
    meta: OutboxEntryMeta,
  ) => Promise<void>;
  /** Schedules delivery once the transaction has committed. */
  deliver: () => void;
  /** Injectable for tests and for runtimes with a bound fetch. */
  fetch?: FetchLike;
}

/**
 * Editor authentication and RBAC.
 *
 * One implementation, used by the local API today and by the REST routes in
 * stage 7 — the same reason `cms.api` exists. Everything is a method on this
 * object rather than a route handler, so a CLI, a seed script and a panel all
 * get identical behaviour, including the parts that are easy to get wrong:
 * single-use tokens, hashed secrets, and a second factor that cannot be
 * skipped by calling a different function.
 */
export function createAuth(options: AuthServiceOptions): CmsAuth {
  const { config } = options;
  const fetchImpl: FetchLike = options.fetch ?? ((...args) => fetch(...args));

  /**
   * A hash to check a password against when the account does not exist.
   *
   * Without it, "unknown email" returns in a millisecond and "wrong password"
   * returns in fifty, which is a user enumeration oracle that needs no special
   * tools to read. Derived on first use, not at construction: `heyoCms()` runs
   * on every cold start, and 100k PBKDF2 rounds is a strange price to pay for
   * a configuration that never signs anybody in.
   */
  let decoy: Promise<string> | undefined;
  const decoyHash = (): Promise<string> =>
    (decoy ??= hashPassword(randomToken(16)));

  let roleCache: { at: number; map: Record<string, string[]> } | undefined;

  /**
   * Whether this deployment is known to have an account.
   *
   * One-way: it starts as "not known" and the first sighting of an account
   * settles it forever, which is what keeps the sign-in screen from counting
   * users on every load. It is a cache of the *closed* answer only — the
   * decision that actually creates the first account does not read it.
   */
  let claimed = false;

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  const auth = (): EditorAuthConfig | undefined => config.admin.auth;

  const ttl = (
    kind: keyof typeof defaultTtl,
    configured: string | undefined,
  ): number => parseDuration(configured ?? defaultTtl[kind]);

  const requireMethod = (method: string): EditorAuthConfig => {
    const configured = auth();
    if (!configured || !(configured.methods as string[]).includes(method)) {
      throw new CmsError(
        `The "${method}" sign-in method is not enabled; add it to admin.auth.methods`,
        { status: 400, code: "method_not_enabled" },
      );
    }
    return configured;
  };

  // -------------------------------------------------------------------------
  // Database plumbing
  // -------------------------------------------------------------------------

  async function run<T>(
    fn: (tx: Tx, adapter: DatabaseAdapter) => Promise<T>,
  ): Promise<T> {
    const adapter = await options.database();
    return adapter.transaction((tx) => fn(tx, adapter));
  }

  async function findOne(
    tx: Tx,
    adapter: DatabaseAdapter,
    table: string,
    where: Where,
  ): Promise<Row | null> {
    const rows = await adapter.query(tx, { table, where, limit: 1 });
    return rows[0] ?? null;
  }

  async function insert(
    tx: Tx,
    adapter: DatabaseAdapter,
    table: string,
    values: Row,
  ): Promise<Row> {
    const result = await adapter.mutate(tx, { kind: "insert", table, values });
    const row = result.rows[0];
    if (!row) {
      throw new CmsError(`Insert into ${table} returned no row.`, {
        status: 500,
        code: "insert_without_row",
      });
    }
    return row;
  }

  async function update(
    tx: Tx,
    adapter: DatabaseAdapter,
    table: string,
    where: Where,
    set: Row,
  ): Promise<number> {
    const result = await adapter.mutate(tx, {
      kind: "update",
      table,
      where,
      set,
      returning: false,
    });
    return result.count;
  }

  async function remove(
    tx: Tx,
    adapter: DatabaseAdapter,
    table: string,
    where: Where,
  ): Promise<number> {
    const result = await adapter.mutate(tx, { kind: "delete", table, where });
    return result.count;
  }

  async function emit(
    tx: Tx,
    type: string,
    data: JsonObject,
    actor: Actor | null = null,
  ): Promise<void> {
    const event: BufferedEvent = { type, data, previous: null };
    const meta: OutboxEntryMeta = { actor };
    await options.emit(tx, [event], meta);
  }

  // -------------------------------------------------------------------------
  // Roles and actors
  // -------------------------------------------------------------------------

  /**
   * Configured roles plus the ones created in the panel.
   *
   * Configuration wins on a name collision: a role defined in code is
   * reviewable and deployable, and letting a database row silently redefine
   * it would make an audit of the repository meaningless.
   */
  async function roleMap(): Promise<Record<string, string[]>> {
    const configured = config.rbac?.roles ?? {};
    if (config.rbac?.customRoles !== true) return configured;

    const now = Date.now();
    if (roleCache && now - roleCache.at < roleCacheTtl) return roleCache.map;

    const rows = await run((tx, adapter) =>
      adapter.query(tx, { table: rolesTable }),
    );
    const map: Record<string, string[]> = {};
    for (const row of rows) map[String(row.name)] = toStringArray(row.permissions); // prettier-ignore
    const merged = { ...map, ...configured };

    roleCache = { at: now, map: merged };
    return merged;
  }

  async function actorForUser(user: CmsUser): Promise<Actor> {
    const roles =
      user.roles.length > 0
        ? user.roles
        : config.rbac?.defaultRole
          ? [config.rbac.defaultRole]
          : [];
    return {
      id: user.id,
      source: "session",
      roles,
      permissions: expandRoles(roles, await roleMap()),
    };
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  type TokenType =
    "invite" | "magic-link" | "password-reset" | "two-factor" | "oauth";

  async function issueToken(
    tx: Tx,
    adapter: DatabaseAdapter,
    args: {
      type: TokenType;
      ttlMs: number;
      userId?: string | null;
      email?: string | null;
      data?: JsonObject | null;
      /**
       * Supplied when the secret has to travel somewhere else too, as the
       * OAuth `state` does: one value goes to the provider and its hash goes
       * into the row.
       */
      token?: string;
    },
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = args.token ?? randomToken();
    const expiresAt = new Date(Date.now() + args.ttlMs);

    await insert(tx, adapter, tokensTable, {
      id: createId("tok"),
      type: args.type,
      user_id: args.userId ?? null,
      email: args.email ?? null,
      token_hash: await hashToken(token),
      data: args.data ?? null,
      expires_at: expiresAt,
      consumed_at: null,
      created_at: new Date(),
    });
    return { token, expiresAt };
  }

  /** Finds a live token, without spending it. */
  async function readToken(
    tx: Tx,
    adapter: DatabaseAdapter,
    type: TokenType,
    token: string,
  ): Promise<Row> {
    const row = await findOne(
      tx,
      adapter,
      tokensTable,
      and(eq("token_hash", await hashToken(token)), eq("type", type)),
    );
    if (!row || expired(row.expires_at)) {
      throw CmsError.unauthorized("This link is invalid or has expired");
    }
    // "Already used" is told apart from "unknown" deliberately: the token is a
    // secret its holder already proved they have, so there is nothing left to
    // leak, and "you clicked twice" is the difference between a support ticket
    // and a shrug.
    if (row.consumed_at !== null) {
      throw CmsError.unauthorized("This link has already been used");
    }
    return row;
  }

  /**
   * Spends a token.
   *
   * A conditional update rather than a read followed by a write: two requests
   * arriving with the same invitation link must not both succeed, and on an
   * engine without real transactions a read-then-write would let them.
   */
  async function spendToken(
    tx: Tx,
    adapter: DatabaseAdapter,
    row: Row,
  ): Promise<void> {
    const claimed = await update(
      tx,
      adapter,
      tokensTable,
      and(eq("id", String(row.id)), eq("consumed_at", null)),
      { consumed_at: new Date() },
    );
    if (claimed !== 1) {
      throw CmsError.unauthorized("This link has already been used");
    }
  }

  async function consumeToken(
    tx: Tx,
    adapter: DatabaseAdapter,
    type: TokenType,
    token: string,
  ): Promise<Row> {
    const row = await readToken(tx, adapter, type, token);
    await spendToken(tx, adapter, row);
    return row;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async function startSession(
    tx: Tx,
    adapter: DatabaseAdapter,
    user: CmsUser,
    meta: RequestMeta,
  ): Promise<SignedIn> {
    const token = randomToken();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + ttl("session", auth()?.session?.expiresIn),
    );

    const row = await insert(tx, adapter, sessionsTable, {
      id: createId("ses"),
      user_id: user.id,
      token_hash: await hashToken(token),
      ip: meta.ip ?? null,
      user_agent: meta.userAgent ?? null,
      expires_at: expiresAt,
      created_at: now,
    });
    await update(tx, adapter, usersTable, eq("id", user.id), {
      last_login_at: now,
    });

    return {
      status: "signed-in",
      token,
      expiresAt: expiresAt.toISOString(),
      session: sessionFromRow(row),
      user: { ...user, lastLoginAt: now.toISOString() },
      actor: await actorForUser(user),
    };
  }

  /**
   * The step between a correct first factor and a session.
   *
   * Every entry point — password, magic link, OAuth — funnels through here,
   * so enabling a second factor cannot be bypassed by signing in a different
   * way.
   */
  async function completeFirstFactor(
    tx: Tx,
    adapter: DatabaseAdapter,
    user: CmsUser,
    meta: RequestMeta,
  ): Promise<SignInResult> {
    if (!user.twoFactorEnabled) return startSession(tx, adapter, user, meta);

    const issued = await issueToken(tx, adapter, {
      type: "two-factor",
      ttlMs: ttl("twoFactor", undefined),
      userId: user.id,
      email: user.email,
    });
    return {
      status: "two-factor-required",
      challenge: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      userId: user.id,
    };
  }

  async function userById(
    tx: Tx,
    adapter: DatabaseAdapter,
    id: string,
  ): Promise<CmsUser | null> {
    const row = await findOne(tx, adapter, usersTable, eq("id", id));
    return row ? userFromRow(row) : null;
  }

  async function userByEmail(
    tx: Tx,
    adapter: DatabaseAdapter,
    email: string,
  ): Promise<{ user: CmsUser; row: Row } | null> {
    const row = await findOne(
      tx,
      adapter,
      usersTable,
      eq("email", normaliseEmail(email)),
    );
    return row ? { user: userFromRow(row), row } : null;
  }

  function assertSignInAllowed(user: CmsUser): void {
    if (user.status === "disabled") {
      throw CmsError.forbidden("This account has been disabled");
    }
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  interface ResolvedProvider {
    id: string;
    endpoints: OAuthEndpoints;
    scope: string;
    pkce: boolean;
    clientId: string;
    clientSecret: string;
    provision: boolean;
    mapRoles?: (claims: Record<string, unknown>) => string[];
    profile: OAuthProvider["profile"];
  }

  async function resolveProvider(id: string): Promise<ResolvedProvider> {
    const configured = auth();

    if (id === "oidc") {
      const sso = configured?.sso;
      if (!sso) {
        throw new CmsError("SSO is not configured; set admin.auth.sso", {
          status: 400,
          code: "method_not_enabled",
        });
      }
      const endpoints = await discoverOidc(sso.issuer, fetchImpl);
      const credentials = clientCredentials("oidc", {
        ...(sso.clientId === undefined ? {} : { clientId: sso.clientId }),
        ...(sso.clientSecret === undefined
          ? {}
          : { clientSecret: sso.clientSecret }),
      });
      return {
        id: "oidc",
        endpoints,
        scope: sso.scope ?? "openid email profile",
        pkce: true,
        ...credentials,
        provision: sso.provision !== false,
        ...(sso.mapRoles ? { mapRoles: sso.mapRoles } : {}),
        profile: async (tokens) =>
          tokens.idToken
            ? oidcProfile(decodeIdToken(tokens.idToken))
            : oidcProfile(await userinfo(endpoints, tokens.accessToken)),
      };
    }

    requireMethod(id);
    const provider = builtinProviders[id];
    if (!provider) {
      throw new CmsError(`Unknown OAuth provider "${id}"`, {
        status: 400,
        code: "unknown_provider",
      });
    }
    const credentials = clientCredentials(id);
    return {
      id,
      endpoints: provider.endpoints,
      scope: configured?.providers?.[id]?.scope ?? provider.scope,
      pkce: provider.pkce,
      ...credentials,
      // A GitHub account is not an invitation. Only SSO provisions, because
      // only SSO carries an organisation's own decision about who belongs.
      provision: false,
      profile: provider.profile,
    };
  }

  async function userinfo(
    endpoints: OAuthEndpoints,
    accessToken: string,
  ): Promise<JsonObject> {
    if (!endpoints.userinfo) return {};
    const response = await fetchImpl(endpoints.userinfo, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, // prettier-ignore
    });
    if (!response.ok) return {};
    return (await response.json()) as JsonObject;
  }

  /**
   * Client credentials, from the configuration or from the environment.
   *
   * The environment fallback exists because a generated template lists
   * `github` in `methods` long before anybody registers an OAuth app, and a
   * configuration that refused to load without the secret would make the
   * template unusable. The failure is deferred to the sign-in attempt, where
   * it can name both the provider and the variables that would fix it.
   */
  function clientCredentials(
    id: string,
    override: Partial<OAuthCredentials> = {},
  ): { clientId: string; clientSecret: string } {
    const configured = auth()?.providers?.[id];
    const upper = id.toUpperCase();
    const clientId =
      override.clientId ??
      configured?.clientId ??
      readEnv(`HEYO_CMS_${upper}_CLIENT_ID`) ??
      readEnv(`${upper}_CLIENT_ID`);
    const clientSecret =
      override.clientSecret ??
      configured?.clientSecret ??
      readEnv(`HEYO_CMS_${upper}_CLIENT_SECRET`) ??
      readEnv(`${upper}_CLIENT_SECRET`);

    if (!clientId || !clientSecret) {
      throw new CmsError(
        `No credentials for "${id}": set admin.auth.providers.${id} or ${upper}_CLIENT_ID and ${upper}_CLIENT_SECRET`,
        { status: 500, code: "provider_not_configured" },
      );
    }
    return { clientId, clientSecret };
  }

  /**
   * Finds, links, or refuses to invent the user behind an external identity.
   *
   * The order matters: a linked account first, then a matching email address
   * — which is how an invited editor claims their account by clicking "sign
   * in with Google" — and only then provisioning, which only SSO may do.
   */
  async function resolveOAuthUser(
    tx: Tx,
    adapter: DatabaseAdapter,
    provider: ResolvedProvider,
    profile: OAuthProfile,
  ): Promise<CmsUser> {
    const linked = await findOne(
      tx,
      adapter,
      accountsTable,
      and(eq("provider", provider.id), eq("provider_account_id", profile.id)),
    );
    if (linked) {
      const user = await userById(tx, adapter, String(linked.user_id));
      if (!user) {
        throw CmsError.unauthorized("The linked account no longer exists");
      }
      return applyMappedRoles(tx, adapter, provider, profile, user);
    }

    const email = profile.email ? normaliseEmail(profile.email) : null;
    if (!email) {
      throw new CmsError(
        `${provider.id} did not return a verified email address, so the account cannot be matched`,
        { status: 400, code: "oauth_without_email" },
      );
    }

    const existing = await userByEmail(tx, adapter, email);
    let user = existing?.user ?? null;

    if (!user) {
      if (!provider.provision) {
        throw CmsError.forbidden(
          `No CMS account for ${email}. An administrator has to invite this address first.`,
        );
      }
      user = await createUser(tx, adapter, {
        email,
        ...(profile.name ? { name: profile.name } : {}),
        roles: provider.mapRoles
          ? provider.mapRoles(profile.claims)
          : config.rbac?.defaultRole
            ? [config.rbac.defaultRole]
            : [],
        status: "active",
      });
      // A provisioned account is a person joining, and the event is how an
      // installation notices somebody appeared without being invited here.
      await emit(tx, "user.joined", {
        userId: user.id,
        email,
        provider: provider.id,
        provisioned: true,
      });
    } else if (user.status === "invited") {
      // Signing in through the provider is as good a proof of ownership as
      // clicking the invitation link, and demanding both helps nobody.
      await update(tx, adapter, usersTable, eq("id", user.id), {
        status: "active",
        updated_at: new Date(),
      });
      user = { ...user, status: "active" };
      await emit(tx, "user.joined", { userId: user.id, email: user.email });
    }

    await insert(tx, adapter, accountsTable, {
      id: createId("acc"),
      user_id: user.id,
      provider: provider.id,
      provider_account_id: profile.id,
      email,
      created_at: new Date(),
      updated_at: new Date(),
    });

    return applyMappedRoles(tx, adapter, provider, profile, user);
  }

  /**
   * SSO decides roles on every sign-in, not just the first.
   *
   * Removing somebody from a group in the identity provider has to take their
   * access away here too, which it does not if roles are copied once at
   * provisioning time.
   */
  async function applyMappedRoles(
    tx: Tx,
    adapter: DatabaseAdapter,
    provider: ResolvedProvider,
    profile: OAuthProfile,
    user: CmsUser,
  ): Promise<CmsUser> {
    if (!provider.mapRoles) return user;
    const mapped = provider.mapRoles(profile.claims);
    if (sameRoles(mapped, user.roles)) return user;

    await update(tx, adapter, usersTable, eq("id", user.id), {
      roles: mapped,
      updated_at: new Date(),
    });
    await emit(tx, "role.changed", {
      userId: user.id,
      roles: mapped,
      previous: user.roles,
      source: provider.id,
    });
    return { ...user, roles: mapped };
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async function createUser(
    tx: Tx,
    adapter: DatabaseAdapter,
    args: {
      email: string;
      password?: string;
      name?: string;
      roles?: string[];
      status?: CmsUserStatus;
      locale?: string;
    },
  ): Promise<CmsUser> {
    const email = normaliseEmail(args.email);
    const taken = await findOne(tx, adapter, usersTable, eq("email", email));
    if (taken) {
      throw CmsError.conflict(`A user with the email ${email} already exists`);
    }
    if (args.password !== undefined) assertPassword(args.password);

    const now = new Date();
    const row = await insert(tx, adapter, usersTable, {
      id: createId("usr"),
      email,
      name: args.name ?? null,
      password_hash:
        args.password === undefined ? null : await hashPassword(args.password),
      two_factor_secret: null,
      two_factor_enabled: false,
      status: args.status ?? "active",
      roles: args.roles ?? [],
      avatar_url: null,
      locale: args.locale ?? null,
      last_login_at: null,
      created_at: now,
      updated_at: now,
    });
    return userFromRow(row);
  }

  function assertPassword(password: string): void {
    const minimum = auth()?.password?.minLength ?? minPasswordLength;
    if (password.length < minimum) {
      throw CmsError.validation(
        `The password must be at least ${minimum} characters`,
      );
    }
  }

  /**
   * The roles the first account is created with, or `null` when it may not be
   * created at all.
   *
   * Password-only by construction: claiming the deployment means choosing a
   * credential, and the only credential this screen can set is a password.
   */
  function firstUserRoles(): string[] | null {
    const configured = auth();
    if (!configured || !configured.methods.includes("password")) return null;

    const firstUser = configured.firstUser ?? true;
    if (firstUser === false) return null;
    if (firstUser !== true && firstUser.roles) return firstUser.roles;

    // `admin` is what `create-admin` writes and what every example's
    // `rbac.roles` calls the role holding `*`. When a deployment named it
    // something else, the role that actually holds `*` is the honest guess,
    // and `admin.auth.firstUser.roles` is how to say it outright.
    const roles = config.rbac?.roles;
    if (!roles || "admin" in roles) return ["admin"];
    const sovereign = Object.entries(roles).find(([, permissions]) =>
      permissions.includes(wildcard),
    );
    return sovereign ? [sovereign[0]] : ["admin"];
  }

  async function assertRolesExist(roles: string[]): Promise<void> {
    // Only when roles are configured at all: a project without `rbac` uses
    // role names as free-form labels, and rejecting them would be inventing a
    // restriction it never asked for.
    if (roles.length === 0 || !config.rbac) return;
    const known = await roleMap();
    const unknown = roles.filter((role) => !(role in known));
    if (unknown.length > 0) {
      throw CmsError.validation(
        `Unknown role ${unknown.map((role) => `"${role}"`).join(", ")}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // The public surface
  // -------------------------------------------------------------------------

  const api: CmsAuth = {
    async actorFromRequest(request: Request): Promise<Actor | null> {
      const header = request.headers.get("authorization");
      const bearer = header?.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : null;
      const token = bearer ?? readCookie(request, sessionCookieName);
      return token ? api.actorFromToken(token) : null;
    },

    async actorFromToken(token: string): Promise<Actor | null> {
      if (token.startsWith(apiKeyPrefix)) return api.apiKeys.verify(token);
      const session = await api.sessions.verify(token);
      return session?.actor ?? null;
    },

    actorForUser,

    // ---- users ----------------------------------------------------------
    users: {
      async list(args = {}): Promise<CmsUser[]> {
        const conditions: Where[] = [];
        if (args.status) conditions.push(eq("status", args.status));
        if (args.search) {
          const pattern = `%${args.search}%`;
          conditions.push(
            or(like("email", pattern, true), like("name", pattern, true)),
          );
        }
        const rows = await run((tx, adapter) =>
          adapter.query(tx, {
            table: usersTable,
            ...(conditions.length > 0 ? { where: and(...conditions) } : {}),
            orderBy: [orderBy("created_at", "asc"), orderBy("id", "asc")],
            limit: args.limit ?? 50,
            ...(args.offset === undefined ? {} : { offset: args.offset }),
          }),
        );
        return rows.map(userFromRow);
      },

      async get(id: string): Promise<CmsUser | null> {
        return run((tx, adapter) => userById(tx, adapter, id));
      },

      async byEmail(email: string): Promise<CmsUser | null> {
        return run(async (tx, adapter) => {
          const found = await userByEmail(tx, adapter, email);
          return found?.user ?? null;
        });
      },

      async count(): Promise<number> {
        const rows = await run((tx, adapter) =>
          adapter.query(tx, { table: usersTable, count: true }),
        );
        return Number(rows[0]?.count ?? 0);
      },

      async create(args): Promise<CmsUser> {
        await assertRolesExist(args.roles ?? []);
        return run((tx, adapter) => createUser(tx, adapter, args));
      },

      async update(id, args): Promise<CmsUser> {
        if (args.roles) await assertRolesExist(args.roles);

        const user = await run(async (tx, adapter) => {
          const current = await userById(tx, adapter, id);
          if (!current) throw CmsError.notFound(`No user with id "${id}"`);

          const set: Row = { updated_at: new Date() };
          if (args.name !== undefined) set.name = args.name;
          if (args.status !== undefined) set.status = args.status;
          if (args.locale !== undefined) set.locale = args.locale;
          if (args.avatarUrl !== undefined) set.avatar_url = args.avatarUrl;
          if (args.roles !== undefined) set.roles = args.roles;
          await update(tx, adapter, usersTable, eq("id", id), set);

          if (args.roles && !sameRoles(args.roles, current.roles)) {
            await emit(
              tx,
              "role.changed",
              { userId: id, roles: args.roles, previous: current.roles },
              args.actor ?? null,
            );
          }
          // A disabled account keeps nothing live: the session is what access
          // is actually made of, and leaving it alone would make "disabled"
          // take effect only at the next sign-in.
          if (args.status === "disabled") {
            await remove(tx, adapter, sessionsTable, eq("user_id", id));
          }
          return (await userById(tx, adapter, id)) as CmsUser;
        });

        options.deliver();
        return user;
      },

      async remove(id, args = {}): Promise<void> {
        await run(async (tx, adapter) => {
          const user = await userById(tx, adapter, id);
          if (!user) throw CmsError.notFound(`No user with id "${id}"`);

          // Explicit rather than relying on `ON DELETE CASCADE`: MongoDB has
          // no foreign keys, and an engine-specific cleanup would leave live
          // sessions behind on exactly one of the three databases.
          for (const table of [
            sessionsTable,
            tokensTable,
            accountsTable,
            apiKeysTable,
          ]) {
            await remove(tx, adapter, table, eq("user_id", id));
          }
          await remove(tx, adapter, usersTable, eq("id", id));
          await emit(
            tx,
            "user.removed",
            { userId: id, email: user.email },
            args.actor ?? null,
          );
        });
        options.deliver();
      },

      async setPassword(id: string, password: string): Promise<void> {
        assertPassword(password);
        await run(async (tx, adapter) => {
          const hash = await hashPassword(password);
          const changed = await update(tx, adapter, usersTable, eq("id", id), {
            password_hash: hash,
            updated_at: new Date(),
          });
          if (changed === 0) {
            throw CmsError.notFound(`No user with id "${id}"`);
          }
          // Changing a password ends every other session, which is what the
          // person changing it after a scare expects it to do.
          await remove(tx, adapter, sessionsTable, eq("user_id", id));
        });
      },

      async invite(args): Promise<InviteResult> {
        await assertRolesExist(args.roles ?? []);
        const result = await run(async (tx, adapter) => {
          const email = normaliseEmail(args.email);
          const existing = await userByEmail(tx, adapter, email);
          if (existing && existing.user.status === "active") {
            throw CmsError.conflict(`${email} is already an active user`);
          }

          const user =
            existing?.user ??
            (await createUser(tx, adapter, {
              email,
              ...(args.name ? { name: args.name } : {}),
              roles:
                args.roles ??
                (config.rbac?.defaultRole ? [config.rbac.defaultRole] : []),
              status: "invited",
            }));

          const issued = await issueToken(tx, adapter, {
            type: "invite",
            ttlMs: ttl("invite", auth()?.invites?.expiresIn),
            userId: user.id,
            email,
          });
          // The event carries who was invited, never the token: a webhook
          // subscriber that could read the secret could become the invitee.
          await emit(
            tx,
            "user.invited",
            { userId: user.id, email, roles: user.roles },
            args.actor ?? null,
          );

          return {
            user,
            token: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
            userId: user.id,
            email,
          } satisfies InviteResult;
        });

        options.deliver();
        return result;
      },

      async acceptInvite(args): Promise<SignedIn> {
        const result = await run(async (tx, adapter) => {
          const token = await consumeToken(tx, adapter, "invite", args.token);
          const user = await userById(tx, adapter, String(token.user_id));
          if (!user) throw CmsError.unauthorized("This invitation is no longer valid"); // prettier-ignore

          const set: Row = { status: "active", updated_at: new Date() };
          if (args.password !== undefined) {
            assertPassword(args.password);
            set.password_hash = await hashPassword(args.password);
          }
          if (args.name !== undefined) set.name = args.name;
          await update(tx, adapter, usersTable, eq("id", user.id), set);

          const activated: CmsUser = {
            ...user,
            status: "active",
            ...(args.name === undefined ? {} : { name: args.name }),
          };
          await emit(tx, "user.joined", { userId: user.id, email: user.email });
          // Straight to a session rather than through `completeFirstFactor`:
          // enabling a second factor requires a session, so an account that is
          // accepting its invitation cannot have one yet.
          return startSession(tx, adapter, activated, args);
        });

        options.deliver();
        return result;
      },
    },

    // ---- the first account ----------------------------------------------
    setup: {
      async required(): Promise<boolean> {
        if (firstUserRoles() === null) return false;
        // Asked on every load of the sign-in screen, and the interesting
        // answer can only be given once: a deployment that has an account
        // cannot stop having had one in a way this needs to notice. So the
        // `false` is remembered and the count stops happening. (Deleting
        // every account in a running process leaves the door shut until a
        // restart, which is the safe side of that mistake.)
        if (claimed) return false;
        const count = await api.users.count();
        if (count > 0) claimed = true;
        return count === 0;
      },

      async claim(args): Promise<SignedIn> {
        const roles = firstUserRoles();
        if (roles === null) {
          throw CmsError.forbidden(
            "This deployment does not accept a first account over HTTP; use heyo-cms create-admin",
          );
        }
        try {
          await assertRolesExist(roles);
        } catch (cause) {
          // The role is configuration's business, not the caller's: say what
          // to change rather than repeating "unknown role" at somebody who
          // never chose it.
          if (cause instanceof CmsError && cause.code === "validation_failed") {
            throw CmsError.validation(
              `The first account would be given the role ${roles.map((role) => `"${role}"`).join(", ")}, which rbac.roles does not define; set admin.auth.firstUser.roles`,
            );
          }
          throw cause;
        }
        assertPassword(args.password);

        const result = await run(async (tx, adapter) => {
          // Inside the transaction, not before it: "is anybody here yet" and
          // "then it is me" have to be one decision, or two browsers opened at
          // the same moment both become administrators. The memo above is not
          // consulted here — a cache may say "no accounts" a moment too long,
          // and this is the statement that must never be wrong.
          const rows = await adapter.query(tx, {
            table: usersTable,
            count: true,
          });
          if (Number(rows[0]?.count ?? 0) > 0) {
            throw CmsError.conflict(
              "This CMS already has an account; sign in instead",
            );
          }

          const user = await createUser(tx, adapter, {
            email: args.email,
            password: args.password,
            roles,
            status: "active",
            ...(args.name === undefined ? {} : { name: args.name }),
          });
          await emit(tx, "user.joined", {
            userId: user.id,
            email: user.email,
            first: true,
          });
          // No second factor to honour: the account is one statement old.
          return startSession(tx, adapter, user, args);
        });

        claimed = true;
        options.deliver();
        return result;
      },
    },

    // ---- sessions -------------------------------------------------------
    sessions: {
      async verify(token: string): Promise<SignedIn | null> {
        return run(async (tx, adapter) => {
          const row = await findOne(
            tx,
            adapter,
            sessionsTable,
            eq("token_hash", await hashToken(token)),
          );
          if (!row || expired(row.expires_at)) return null;

          const user = await userById(tx, adapter, String(row.user_id));
          if (!user || user.status !== "active") return null;

          return {
            status: "signed-in",
            token,
            expiresAt: toIso(row.expires_at) ?? "",
            session: sessionFromRow(row),
            user,
            actor: await actorForUser(user),
          };
        });
      },

      async list(userId: string): Promise<CmsSession[]> {
        const rows = await run((tx, adapter) =>
          adapter.query(tx, {
            table: sessionsTable,
            where: eq("user_id", userId),
            orderBy: [orderBy("created_at", "desc")],
          }),
        );
        return rows.map(sessionFromRow);
      },

      async revoke(token: string): Promise<boolean> {
        const hash = await hashToken(token);
        const count = await run((tx, adapter) =>
          remove(tx, adapter, sessionsTable, eq("token_hash", hash)),
        );
        return count > 0;
      },

      async revokeById(id: string): Promise<boolean> {
        const count = await run((tx, adapter) =>
          remove(tx, adapter, sessionsTable, eq("id", id)),
        );
        return count > 0;
      },

      async revokeAll(userId: string): Promise<number> {
        return run((tx, adapter) =>
          remove(tx, adapter, sessionsTable, eq("user_id", userId)),
        );
      },

      async cleanup(): Promise<number> {
        const now = new Date();
        return run(async (tx, adapter) => {
          const sessions = await remove(
            tx,
            adapter,
            sessionsTable,
            lt("expires_at", now),
          );
          // Spent and expired tokens go at the same time: both are rows whose
          // only remaining purpose would be to grow the table.
          await remove(tx, adapter, tokensTable, lt("expires_at", now));
          return sessions;
        });
      },
    },

    // ---- password -------------------------------------------------------
    password: {
      async signIn(args): Promise<SignInResult> {
        requireMethod("password");
        const result = await run(async (tx, adapter) => {
          const found = await userByEmail(tx, adapter, args.email);
          const stored = found
            ? (found.row.password_hash as string | null)
            : await decoyHash();
          const correct = await verifyPassword(args.password, stored);

          if (!found || !correct) {
            // One message for "no such account" and "wrong password": the
            // difference is exactly what a credential-stuffing run is
            // probing for.
            throw CmsError.unauthorized("Invalid email or password");
          }
          assertSignInAllowed(found.user);
          if (found.user.status === "invited") {
            throw CmsError.forbidden(
              "This invitation has not been accepted yet",
            );
          }
          return completeFirstFactor(tx, adapter, found.user, args);
        });

        options.deliver();
        return result;
      },

      async requestReset(args): Promise<IssuedToken | null> {
        requireMethod("password");
        return run(async (tx, adapter) => {
          const found = await userByEmail(tx, adapter, args.email);
          // `null` rather than an error: the caller must not be able to use
          // the reset form as a directory of who has an account.
          if (!found || found.user.status === "disabled") return null;

          const issued = await issueToken(tx, adapter, {
            type: "password-reset",
            ttlMs: ttl("passwordReset", auth()?.passwordReset?.expiresIn),
            userId: found.user.id,
            email: found.user.email,
          });
          return {
            token: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
            userId: found.user.id,
            email: found.user.email,
          };
        });
      },

      async reset(args): Promise<CmsUser> {
        requireMethod("password");
        assertPassword(args.password);
        return run(async (tx, adapter) => {
          const token = await consumeToken(
            tx,
            adapter,
            "password-reset",
            args.token,
          );
          const userId = String(token.user_id);
          await update(tx, adapter, usersTable, eq("id", userId), {
            password_hash: await hashPassword(args.password),
            status: "active",
            updated_at: new Date(),
          });
          // Whoever asked for the reset may have been locked out by someone
          // else's session; the reset is what ends it.
          await remove(tx, adapter, sessionsTable, eq("user_id", userId));

          const user = await userById(tx, adapter, userId);
          if (!user) throw CmsError.unauthorized("This link is no longer valid"); // prettier-ignore
          return user;
        });
      },
    },

    // ---- magic link -----------------------------------------------------
    magicLink: {
      async request(args): Promise<IssuedToken | null> {
        requireMethod("magic-link");
        return run(async (tx, adapter) => {
          const found = await userByEmail(tx, adapter, args.email);
          if (!found || found.user.status === "disabled") return null;

          const issued = await issueToken(tx, adapter, {
            type: "magic-link",
            ttlMs: ttl("magicLink", auth()?.magicLink?.expiresIn),
            userId: found.user.id,
            email: found.user.email,
          });
          return {
            token: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
            userId: found.user.id,
            email: found.user.email,
          };
        });
      },

      async verify(args): Promise<SignInResult> {
        requireMethod("magic-link");
        const result = await run(async (tx, adapter) => {
          const token = await consumeToken(
            tx,
            adapter,
            "magic-link",
            args.token,
          );
          const user = await userById(tx, adapter, String(token.user_id));
          if (!user) throw CmsError.unauthorized("This link is no longer valid"); // prettier-ignore
          assertSignInAllowed(user);

          if (user.status === "invited") {
            // Receiving mail at the address is the same proof the invitation
            // asked for, so the link doubles as an acceptance.
            await update(tx, adapter, usersTable, eq("id", user.id), {
              status: "active",
              updated_at: new Date(),
            });
            await emit(tx, "user.joined", { userId: user.id, email: user.email }); // prettier-ignore
            return completeFirstFactor(
              tx,
              adapter,
              { ...user, status: "active" },
              args,
            );
          }
          return completeFirstFactor(tx, adapter, user, args);
        });

        options.deliver();
        return result;
      },
    },

    // ---- oauth ----------------------------------------------------------
    oauth: {
      async authorize(args) {
        const provider = await resolveProvider(args.provider);
        const state = randomToken(24);
        const verifier = randomToken();
        const challenge = provider.pkce
          ? (await pkcePair(verifier)).challenge
          : undefined;

        // The state lives in the database, not in a cookie: the callback can
        // land on a different instance, and a serverless deployment has no
        // shared memory to put it in. Only the hash is stored, so a leaked
        // database still cannot complete somebody else's sign-in.
        await run((tx, adapter) =>
          issueToken(tx, adapter, {
            type: "oauth",
            ttlMs: ttl("oauth", undefined),
            token: state,
            data: {
              provider: provider.id,
              redirectUri: args.redirectUri,
              verifier,
              redirectTo: args.redirectTo ?? null,
            },
          }),
        );

        return {
          url: buildAuthorizeUrl({
            endpoints: provider.endpoints,
            clientId: provider.clientId,
            redirectUri: args.redirectUri,
            scope: provider.scope,
            state,
            ...(challenge === undefined ? {} : { codeChallenge: challenge }),
          }),
          state,
        };
      },

      async callback(args) {
        const provider = await resolveProvider(args.provider);
        const result = await run(async (tx, adapter) => {
          const stored = await consumeToken(tx, adapter, "oauth", args.state);
          const data = asObject(stored.data);

          if (data.provider !== provider.id) {
            throw CmsError.unauthorized("This sign-in request does not match");
          }
          if (data.redirectUri !== args.redirectUri) {
            // The redirect URI is part of what the code was issued for;
            // accepting a different one would make the state reusable against
            // another callback.
            throw CmsError.unauthorized("The redirect URI does not match");
          }

          const tokens = await exchangeCode({
            endpoints: provider.endpoints,
            clientId: provider.clientId,
            clientSecret: provider.clientSecret,
            code: args.code,
            redirectUri: args.redirectUri,
            ...(provider.pkce && typeof data.verifier === "string"
              ? { codeVerifier: data.verifier }
              : {}),
            fetchImpl,
          });

          const profile = await provider.profile(tokens, fetchImpl);
          const user = await resolveOAuthUser(tx, adapter, provider, profile);
          assertSignInAllowed(user);

          const signIn = await completeFirstFactor(tx, adapter, user, args);
          return {
            ...signIn,
            redirectTo:
              typeof data.redirectTo === "string" ? data.redirectTo : null,
          };
        });

        options.deliver();
        return result;
      },
    },

    // ---- two-factor -----------------------------------------------------
    twoFactor: {
      async begin(userId: string): Promise<TwoFactorSetup> {
        const secret = generateTotpSecret();
        return run(async (tx, adapter) => {
          const user = await userById(tx, adapter, userId);
          if (!user) throw CmsError.notFound(`No user with id "${userId}"`);

          if (user.twoFactorEnabled) {
            throw CmsError.conflict(
              "Disable the existing authenticator before enrolling another.",
            );
          }
          // Stored but not enabled: the factor only starts guarding the
          // account once a code proves the authenticator actually has it.
          await update(tx, adapter, usersTable, eq("id", userId), {
            two_factor_secret: secret,
            updated_at: new Date(),
          });
          return {
            secret,
            uri: totpUri({
              secret,
              account: user.email,
              issuer: config.admin.title ?? "Heyo CMS",
            }),
          };
        });
      },

      async enable(args): Promise<CmsUser> {
        return run(async (tx, adapter) => {
          const row = await findOne(
            tx,
            adapter,
            usersTable,
            eq("id", args.userId),
          );
          if (!row) throw CmsError.notFound(`No user with id "${args.userId}"`);

          const secret = row.two_factor_secret as string | null;
          if (!secret) {
            throw CmsError.validation("Start the setup before enabling it");
          }
          if (!(await verifyTotp(secret, args.code))) {
            throw CmsError.unauthorized("That code is not valid");
          }
          await update(tx, adapter, usersTable, eq("id", args.userId), {
            two_factor_enabled: true,
            updated_at: new Date(),
          });
          return { ...userFromRow(row), twoFactorEnabled: true };
        });
      },

      async disable(userId: string): Promise<CmsUser> {
        return run(async (tx, adapter) => {
          const changed = await update(
            tx,
            adapter,
            usersTable,
            eq("id", userId),
            {
              two_factor_enabled: false,
              two_factor_secret: null,
              updated_at: new Date(),
            },
          );
          if (changed === 0) {
            throw CmsError.notFound(`No user with id "${userId}"`);
          }
          return (await userById(tx, adapter, userId)) as CmsUser;
        });
      },

      async complete(args): Promise<SignedIn> {
        const result = await run(async (tx, adapter) => {
          const token = await readToken(
            tx,
            adapter,
            "two-factor",
            args.challenge,
          );
          const row = await findOne(
            tx,
            adapter,
            usersTable,
            eq("id", String(token.user_id)),
          );
          if (!row) throw CmsError.unauthorized("This challenge is no longer valid"); // prettier-ignore

          const valid = await verifyTotp(
            row.two_factor_secret as string | null,
            args.code,
          );
          if (!valid) {
            // A typo must not send the user back to the password form, and an
            // unlimited retry turns a six-digit code into a five-minute
            // brute force. The challenge counts its own attempts and dies on
            // the fifth.
            let current = token;
            for (let retry = 0; retry < maxTwoFactorAttempts; retry += 1) {
              const storedAttempts = asObject(current.data).attempts;
              const previous =
                typeof storedAttempts === "number" ? storedAttempts : null;
              const attempts = Number(previous ?? 0) + 1;
              const changed = await update(
                tx,
                adapter,
                tokensTable,
                and(
                  eq("id", String(current.id)),
                  eq("consumed_at", null),
                  eq("data.attempts", previous),
                ),
                {
                  data: { ...asObject(current.data), attempts },
                  ...(attempts >= maxTwoFactorAttempts
                    ? { consumed_at: new Date() }
                    : {}),
                },
              );
              if (changed === 1) break;
              const latest = await findOne(
                tx,
                adapter,
                tokensTable,
                eq("id", String(current.id)),
              );
              if (!latest || latest.consumed_at !== null) break;
              current = latest;
            }
            // Commit the failed attempt before answering 401. Throwing here
            // rolls back the counter on Postgres/SQLite and permits brute force.
            return null;
          }
          await spendToken(tx, adapter, token);

          const user = userFromRow(row);
          assertSignInAllowed(user);
          return startSession(tx, adapter, user, args);
        });

        if (result === null)
          throw CmsError.unauthorized("That code is not valid");
        options.deliver();
        return result;
      },
    },

    // ---- api keys -------------------------------------------------------
    apiKeys: {
      async create(args): Promise<IssuedApiKey> {
        const configured = auth()?.apiKeys;
        if (!configured?.enabled) {
          throw new CmsError(
            "API keys are not enabled; set admin.auth.apiKeys.enabled",
            { status: 400, code: "method_not_enabled" },
          );
        }
        const scopes = args.scopes ?? configured.scopes ?? ["read"];
        const allowed = configured.scopes;
        if (allowed) {
          const extra = scopes.filter((scope) => !allowed.includes(scope));
          if (extra.length > 0) {
            throw CmsError.validation(
              `Scope ${extra.map((scope) => `"${scope}"`).join(", ")} is not in admin.auth.apiKeys.scopes`,
            );
          }
        }

        const secret = `${apiKeyPrefix}${randomToken()}`;
        const expiresIn = args.expiresIn ?? configured.expiresIn;
        const expiresAt = expiresIn
          ? new Date(Date.now() + parseDuration(expiresIn))
          : null;

        const record = await run(async (tx, adapter) => {
          const row = await insert(tx, adapter, apiKeysTable, {
            id: createId("key"),
            name: args.name,
            user_id: args.userId ?? null,
            key_hash: await hashToken(secret),
            // Enough to recognise a key in a list, far too little to use it.
            prefix: secret.slice(0, apiKeyPrefix.length + 6),
            scopes,
            last_used_at: null,
            expires_at: expiresAt,
            revoked_at: null,
            created_at: new Date(),
          });
          await emit(
            tx,
            "apikey.created",
            { id: String(row.id), name: args.name, scopes, userId: args.userId ?? null }, // prettier-ignore
            args.actor ?? null,
          );
          return apiKeyFromRow(row);
        });

        options.deliver();
        return { ...record, key: secret };
      },

      async list(args = {}): Promise<ApiKeyRecord[]> {
        const rows = await run((tx, adapter) =>
          adapter.query(tx, {
            table: apiKeysTable,
            ...(args.userId ? { where: eq("user_id", args.userId) } : {}),
            orderBy: [orderBy("created_at", "desc")],
          }),
        );
        return rows.map(apiKeyFromRow);
      },

      async revoke(id, args = {}): Promise<boolean> {
        const revoked = await run(async (tx, adapter) => {
          // Revoked, not deleted: the activity log refers to the key by id,
          // and a trail that points at a row which no longer exists is not a
          // trail.
          const count = await update(
            tx,
            adapter,
            apiKeysTable,
            and(eq("id", id), eq("revoked_at", null)),
            { revoked_at: new Date() },
          );
          if (count > 0) {
            await emit(tx, "apikey.revoked", { id }, args.actor ?? null);
          }
          return count > 0;
        });

        options.deliver();
        return revoked;
      },

      async verify(key: string): Promise<Actor | null> {
        return run(async (tx, adapter) => {
          const row = await findOne(
            tx,
            adapter,
            apiKeysTable,
            eq("key_hash", await hashToken(key)),
          );
          if (!row) return null;
          if (row.revoked_at !== null) return null;
          if (row.expires_at !== null && expired(row.expires_at)) return null;

          const scopes = toStringArray(row.scopes);
          const granted = scopePermissions(scopes);

          let roles: string[] = [];
          let permissions = granted;
          let id = String(row.id);

          if (row.user_id !== null && row.user_id !== undefined) {
            const user = await userById(tx, adapter, String(row.user_id));
            if (!user || user.status !== "active") return null;
            const actor = await actorForUser(user);
            roles = actor.roles;
            // A key can never exceed its owner: the scopes narrow the user's
            // permissions, they do not add to them.
            permissions = intersectPermissions(actor.permissions, granted);
            // The owner's id, so an ownership rule such as
            // `record.authorId === actor.id` keeps working for a key.
            id = user.id;
          }

          await update(tx, adapter, apiKeysTable, eq("id", String(row.id)), {
            last_used_at: new Date(),
          });

          return { id, source: "api-key", roles, permissions };
        });
      },
    },

    // ---- roles ----------------------------------------------------------
    roles: {
      async list(): Promise<RoleRecord[]> {
        const configured: RoleRecord[] = Object.entries(
          config.rbac?.roles ?? {},
        ).map(([name, permissions]) => ({
          name,
          label: null,
          permissions,
          source: "config",
        }));

        if (config.rbac?.customRoles !== true) return configured;

        const rows = await run((tx, adapter) =>
          adapter.query(tx, { table: rolesTable, orderBy: [orderBy("name")] }),
        );
        const names = new Set(configured.map((role) => role.name));
        const stored: RoleRecord[] = rows
          .filter((row) => !names.has(String(row.name)))
          .map((row) => ({
            name: String(row.name),
            label: (row.label as string | null) ?? null,
            permissions: toStringArray(row.permissions),
            source: "database",
          }));

        return [...configured, ...stored].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      },

      async create(args): Promise<RoleRecord> {
        assertCustomRoles();
        assertRoleName(args.name);
        if (config.rbac?.roles[args.name]) {
          throw CmsError.conflict(
            `"${args.name}" is defined in the configuration; change it there`,
          );
        }

        const row = await run(async (tx, adapter) => {
          const taken = await findOne(
            tx,
            adapter,
            rolesTable,
            eq("name", args.name),
          );
          if (taken) throw CmsError.conflict(`The role "${args.name}" already exists`); // prettier-ignore
          return insert(tx, adapter, rolesTable, {
            id: createId("rol"),
            name: args.name,
            label: args.label ?? null,
            permissions: args.permissions,
            created_at: new Date(),
            updated_at: new Date(),
          });
        });

        roleCache = undefined;
        return {
          name: String(row.name),
          label: (row.label as string | null) ?? null,
          permissions: toStringArray(row.permissions),
          source: "database",
        };
      },

      async update(name, args): Promise<RoleRecord> {
        assertCustomRoles();
        const row = await run(async (tx, adapter) => {
          const set: Row = { updated_at: new Date() };
          if (args.permissions) set.permissions = args.permissions;
          if (args.label !== undefined) set.label = args.label;
          const changed = await update(
            tx,
            adapter,
            rolesTable,
            eq("name", name),
            set,
          );
          if (changed === 0) throw CmsError.notFound(`No role named "${name}"`);
          return findOne(tx, adapter, rolesTable, eq("name", name));
        });

        roleCache = undefined;
        return {
          name,
          label: (row?.label as string | null) ?? null,
          permissions: toStringArray(row?.permissions),
          source: "database",
        };
      },

      async remove(name: string): Promise<boolean> {
        assertCustomRoles();
        const count = await run((tx, adapter) =>
          remove(tx, adapter, rolesTable, eq("name", name)),
        );
        roleCache = undefined;
        return count > 0;
      },

      async permissionsFor(roles: string[]): Promise<string[]> {
        return expandRoles(roles, await roleMap());
      },
    },
  };

  function assertCustomRoles(): void {
    if (config.rbac?.customRoles !== true) {
      throw new CmsError(
        "Roles are defined in the configuration; set rbac.customRoles to manage them in the panel",
        { status: 400, code: "custom_roles_disabled" },
      );
    }
  }

  function assertRoleName(name: string): void {
    if (!roleNameFormat.test(name)) {
      throw CmsError.validation(
        `"${name}" is not a role name; use lowercase letters, digits, dashes and underscores`,
      );
    }
  }

  return api;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function userFromRow(row: Row): CmsUser {
  return {
    id: String(row.id),
    email: String(row.email),
    name: (row.name as string | null) ?? null,
    status: (row.status as CmsUserStatus) ?? "active",
    roles: toStringArray(row.roles),
    avatarUrl: (row.avatar_url as string | null) ?? null,
    locale: (row.locale as string | null) ?? null,
    twoFactorEnabled: row.two_factor_enabled === true,
    lastLoginAt: toIso(row.last_login_at),
    createdAt: toIso(row.created_at) ?? "",
    updatedAt: toIso(row.updated_at) ?? "",
  };
}

function sessionFromRow(row: Row): CmsSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    expiresAt: toIso(row.expires_at) ?? "",
    createdAt: toIso(row.created_at) ?? "",
    ip: (row.ip as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
  };
}

function apiKeyFromRow(row: Row): ApiKeyRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.prefix),
    userId: (row.user_id as string | null) ?? null,
    scopes: toStringArray(row.scopes),
    lastUsedAt: toIso(row.last_used_at),
    expiresAt: toIso(row.expires_at),
    revokedAt: toIso(row.revoked_at),
    createdAt: toIso(row.created_at) ?? "",
  };
}

function toStringArray(value: JsonValue | undefined | unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function expired(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const date = value instanceof Date ? value : new Date(String(value));
  return date.getTime() <= Date.now();
}

function normaliseEmail(email: string): string {
  const cleaned = email.trim().toLowerCase();
  if (!emailFormat.test(cleaned)) {
    throw CmsError.validation(`"${email}" is not an email address`);
  }
  return cleaned;
}

function sameRoles(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sorted = [...right].sort();
  return [...left].sort().every((role, index) => role === sorted[index]);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

function readEnv(name: string): string | undefined {
  // `process` does not exist on every runtime this package targets, and
  // reaching for it unguarded is the classic way a package stops working on
  // Workers.
  const environment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env; // prettier-ignore
  return environment?.[name];
}
