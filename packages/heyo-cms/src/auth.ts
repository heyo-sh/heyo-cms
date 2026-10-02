import { CmsConfigError } from "./errors";
import { parseDuration } from "./duration";
import type {
  ApiKeyConfig,
  AuthMethod,
  Duration,
  EditorAuthConfig,
  OidcConfig,
} from "./types/config";

export interface CmsUsersOptions {
  methods: AuthMethod[];
  sso?: OidcConfig;
  twoFactor?: boolean;
  apiKeys?: ApiKeyConfig;
  session?: { expiresIn?: Duration };
  invites?: { expiresIn?: Duration };
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
  if (options.session?.expiresIn) {
    parseDuration(options.session.expiresIn, "admin.auth.session.expiresIn");
  }
  if (options.invites?.expiresIn) {
    parseDuration(options.invites.expiresIn, "admin.auth.invites.expiresIn");
  }
  if (options.apiKeys?.expiresIn) {
    parseDuration(options.apiKeys.expiresIn, "admin.auth.apiKeys.expiresIn");
  }

  return { kind: "cms-users", ...options };
}

export interface OidcOptions {
  issuer: string;
  clientId?: string;
  clientSecret?: string;
  mapRoles?: (claims: Record<string, unknown>) => string[];
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
