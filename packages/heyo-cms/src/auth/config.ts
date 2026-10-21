import { isValidScope } from "../access/permissions";
import { parseDuration } from "../duration";
import { CmsConfigError } from "../errors";
import type {
  ApiKeyConfig,
  AuthMethod,
  Duration,
  EditorAuthConfig,
  FirstUserConfig,
  OAuthCredentials,
  OidcConfig,
  PasswordPolicy,
  TokenDelivery,
} from "../types/config";

export interface CmsUsersOptions {
  methods: AuthMethod[];
  sso?: OidcConfig;
  twoFactor?: boolean;
  apiKeys?: ApiKeyConfig;
  session?: { expiresIn?: Duration };
  invites?: { expiresIn?: Duration };
  magicLink?: { expiresIn?: Duration };
  passwordReset?: { expiresIn?: Duration };
  providers?: Record<string, OAuthCredentials>;
  password?: PasswordPolicy;
  /**
   * Whether the first account can be claimed from the sign-in screen.
   *
   * On by default, and only while there are no accounts at all: an empty
   * `cms_users` is the only state in which the route answers, and the account
   * that answers it is the one that closes it. `false` leaves
   * `heyo-cms create-admin` as the only way in.
   */
  firstUser?: FirstUserConfig;
  /**
   * Delivers a magic link or a reset link to its owner.
   *
   * The CMS still sends no email: it hands the message to this function and
   * the application decides what a mailbox is. Without it the magic-link and
   * password-reset HTTP routes are not registered, because over HTTP the
   * caller is an anonymous browser and a response carrying the token would
   * let a stranger sign in as an administrator.
   */
  deliverToken?: (message: TokenDelivery) => void | Promise<void>;
}

/**
 * Editor authentication.
 *
 * The CMS authenticates editors and nothing else: there is no identity for the
 * users of the application being built, by design (section 0). API keys are
 * configured here rather than as a separate feature, because a key is an
 * authentication method that produces the same `Actor` a session does.
 */
export function cmsUsers(options: CmsUsersOptions): EditorAuthConfig {
  if (options.methods.length === 0) {
    throw new CmsConfigError(
      "admin.auth.methods",
      "at least one sign-in method is required",
    );
  }
  for (const [key, duration] of [
    ["session", options.session?.expiresIn],
    ["invites", options.invites?.expiresIn],
    ["magicLink", options.magicLink?.expiresIn],
    ["passwordReset", options.passwordReset?.expiresIn],
    ["apiKeys", options.apiKeys?.expiresIn],
  ] as const) {
    if (duration) parseDuration(duration, `admin.auth.${key}.expiresIn`);
  }

  for (const scope of options.apiKeys?.scopes ?? []) {
    if (!isValidScope(scope)) {
      throw new CmsConfigError(
        "admin.auth.apiKeys.scopes",
        `"${scope}" is not a scope; use "read", "write", "delete", "*" or "collection:action"`,
      );
    }
  }

  const firstUser = options.firstUser;
  if (typeof firstUser === "object") {
    const roles = firstUser.roles;
    if (roles !== undefined && roles.length === 0) {
      // An account with no roles cannot administer anything, and the first
      // account exists to administer: this is a typo, not a policy.
      throw new CmsConfigError(
        "admin.auth.firstUser.roles",
        "the first account needs at least one role",
      );
    }
  }
  if (
    firstUser !== undefined &&
    firstUser !== false &&
    !options.methods.includes("password")
  ) {
    // Claiming the deployment means choosing a password, and a password is
    // only a way in where `password` is a method. Asked for explicitly, this
    // is a contradiction worth naming; left to the default it is simply off.
    throw new CmsConfigError(
      "admin.auth.firstUser",
      'the first account signs in with a password; add "password" to methods, or set firstUser: false',
    );
  }

  const minLength = options.password?.minLength;
  if (minLength !== undefined && minLength < 8) {
    // Eight is already the floor every standard converged on; letting a
    // configuration go lower would make the CMS the weakest link by request.
    throw new CmsConfigError(
      "admin.auth.password.minLength",
      "must be at least 8",
    );
  }

  return { kind: "cms-users", ...options };
}

export interface OidcOptions {
  issuer: string;
  clientId?: string;
  clientSecret?: string;
  mapRoles?: (claims: Record<string, unknown>) => string[];
  scope?: string;
  provision?: boolean;
}

/**
 * Single sign-on for organisations.
 *
 * `mapRoles` is the whole point: a company that already decides access in its
 * identity provider should not have to decide it again in the CMS.
 */
export function oidc(options: OidcOptions): OidcConfig {
  if (!/^https?:\/\//.test(options.issuer)) {
    throw new CmsConfigError(
      "admin.auth.sso.issuer",
      "must be an HTTP(S) issuer URL",
    );
  }
  return { kind: "oidc", ...options };
}
