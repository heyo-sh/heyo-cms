import { CmsError } from "../errors";
import { trimTrailingSlashes } from "../strings";
import type { JsonObject } from "../types/json";
import { sha256Base64Url } from "./crypto";

/**
 * OAuth 2.0 and OpenID Connect, as plain functions.
 *
 * Nothing here touches the database or the configuration: a provider is a
 * record of endpoints plus a function that turns whatever the provider
 * returns into the three things the CMS needs — a stable id, an email and a
 * display name. Adding a provider is therefore a literal, not a subclass.
 */

export interface OAuthProfile {
  /** Stable at the provider. Never the email: emails get reassigned. */
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  /** Everything the provider said, for `oidc().mapRoles`. */
  claims: JsonObject;
}

export interface OAuthTokens {
  accessToken: string;
  idToken?: string;
  tokenType?: string;
}

export interface OAuthEndpoints {
  authorization: string;
  token: string;
  userinfo?: string;
}

export interface OAuthProvider {
  id: string;
  endpoints: OAuthEndpoints;
  scope: string;
  /** Proof Key for Code Exchange. Off for GitHub, which does not accept it. */
  pkce: boolean;
  profile(tokens: OAuthTokens, fetchImpl: FetchLike): Promise<OAuthProfile>;
}

/**
 * Just the call signature, not `typeof fetch`.
 *
 * Runtimes decorate the global with their own extras — Bun adds `preconnect`
 * — and typing against the global would make a hand-written test double fail
 * to compile for a reason that has nothing to do with HTTP.
 */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The three providers the plan names.
 *
 * Google and Microsoft are OpenID Connect, so the profile comes from the
 * id_token and needs no second round trip. GitHub is plain OAuth 2 and hides
 * a verified address behind a separate endpoint when the public profile has
 * none, which is the common case for a work account.
 */
export const builtinProviders: Record<string, OAuthProvider> = {
  github: {
    id: "github",
    endpoints: {
      authorization: "https://github.com/login/oauth/authorize",
      token: "https://github.com/login/oauth/access_token",
      userinfo: "https://api.github.com/user",
    },
    scope: "read:user user:email",
    pkce: false,
    async profile(tokens, fetchImpl) {
      const user = await getJson(
        fetchImpl,
        "https://api.github.com/user",
        tokens.accessToken,
      );
      const email =
        typeof user.email === "string"
          ? user.email
          : await primaryGithubEmail(fetchImpl, tokens.accessToken);

      return {
        id: String(user.id ?? ""),
        email,
        name: stringOrNull(user.name) ?? stringOrNull(user.login),
        avatarUrl: stringOrNull(user.avatar_url),
        claims: user,
      };
    },
  },

  google: {
    id: "google",
    endpoints: {
      authorization: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    },
    scope: "openid email profile",
    pkce: true,
    async profile(tokens, fetchImpl) {
      const claims = tokens.idToken
        ? decodeIdToken(tokens.idToken)
        : await getJson(
            fetchImpl,
            "https://openidconnect.googleapis.com/v1/userinfo",
            tokens.accessToken,
          );
      return oidcProfile(claims);
    },
  },

  microsoft: {
    id: "microsoft",
    endpoints: {
      authorization:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      userinfo: "https://graph.microsoft.com/oidc/userinfo",
    },
    scope: "openid email profile",
    pkce: true,
    async profile(tokens, fetchImpl) {
      const claims = tokens.idToken
        ? decodeIdToken(tokens.idToken)
        : await getJson(
            fetchImpl,
            "https://graph.microsoft.com/oidc/userinfo",
            tokens.accessToken,
          );
      return oidcProfile(claims);
    },
  },
};

/** The shape every OIDC provider agrees on, including a custom issuer. */
export function oidcProfile(claims: JsonObject): OAuthProfile {
  return {
    id: String(claims.sub ?? ""),
    email: stringOrNull(claims.email),
    name: stringOrNull(claims.name) ?? stringOrNull(claims.preferred_username),
    avatarUrl: stringOrNull(claims.picture),
    claims,
  };
}

/**
 * Reads an id_token without verifying its signature.
 *
 * Allowed, and only allowed, because of how it arrives: the authorization code
 * flow fetches it from the token endpoint over TLS, with the client
 * authenticating itself — OpenID Connect Core 3.1.3.7 explicitly permits
 * skipping signature validation on that path. A token that reached us any
 * other way must never be passed to this function.
 */
export function decodeIdToken(token: string): JsonObject {
  const payload = token.split(".")[1];
  if (!payload) return {};
  const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const decoded = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = Uint8Array.from(decoded, (character) =>
      character.charCodeAt(0),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonObject;
  } catch {
    return {};
  }
}

/**
 * OIDC discovery, cached for the lifetime of the process.
 *
 * An identity provider's endpoints change roughly never, and fetching
 * `.well-known` on every sign-in would add a round trip to the slowest part
 * of the flow.
 */
const discovered = new Map<string, Promise<OAuthEndpoints>>();

export function discoverOidc(
  issuer: string,
  fetchImpl: FetchLike,
): Promise<OAuthEndpoints> {
  const url = `${trimTrailingSlashes(issuer)}/.well-known/openid-configuration`;
  const existing = discovered.get(url);
  if (existing) return existing;

  const pending = (async (): Promise<OAuthEndpoints> => {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new CmsError(
        `OIDC discovery failed for ${issuer} (${response.status})`,
        { status: 502, code: "oidc_discovery_failed" },
      );
    }
    const document = (await response.json()) as JsonObject;
    return {
      authorization: String(document.authorization_endpoint ?? ""),
      token: String(document.token_endpoint ?? ""),
      ...(typeof document.userinfo_endpoint === "string"
        ? { userinfo: document.userinfo_endpoint }
        : {}),
    };
  })();

  discovered.set(url, pending);
  // A failed discovery must not be remembered, or one outage at the identity
  // provider would disable SSO until the process restarts.
  pending.catch(() => discovered.delete(url));
  return pending;
}

export interface AuthorizeUrlOptions {
  endpoints: OAuthEndpoints;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  /** The S256 challenge; omitted for providers that reject PKCE. */
  codeChallenge?: string;
  extra?: Record<string, string>;
}

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL(options.endpoints.authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", options.scope);
  url.searchParams.set("state", options.state);
  if (options.codeChallenge) {
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** The PKCE pair: a verifier to keep, a challenge to publish. */
export async function pkcePair(
  verifier: string,
): Promise<{ verifier: string; challenge: string }> {
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

export interface ExchangeOptions {
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  fetchImpl: FetchLike;
}

export async function exchangeCode(
  options: ExchangeOptions,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  });
  if (options.codeVerifier) body.set("code_verifier", options.codeVerifier);

  const response = await options.fetchImpl(options.endpoints.token, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const payload = (await response.json().catch(() => ({}))) as JsonObject;
  if (!response.ok || typeof payload.access_token !== "string") {
    // The provider's own error is the only useful diagnostic here, and it is
    // not secret: it says "bad redirect_uri", not "here is the client secret".
    const reason = stringOrNull(payload.error_description) ?? stringOrNull(payload.error) ?? `HTTP ${response.status}`; // prettier-ignore
    throw new CmsError(`OAuth token exchange failed: ${reason}`, {
      status: 401,
      code: "oauth_exchange_failed",
    });
  }

  return {
    accessToken: payload.access_token,
    ...(typeof payload.id_token === "string"
      ? { idToken: payload.id_token }
      : {}),
    ...(typeof payload.token_type === "string"
      ? { tokenType: payload.token_type }
      : {}),
  };
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  accessToken: string,
): Promise<JsonObject> {
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      // GitHub rejects requests without one, and a missing agent header is a
      // confusing 403 rather than an error that names itself.
      "user-agent": "heyo-cms",
    },
  });
  if (!response.ok) {
    throw new CmsError(`OAuth profile request failed (${response.status})`, {
      status: 502,
      code: "oauth_profile_failed",
    });
  }
  return (await response.json()) as JsonObject;
}

async function primaryGithubEmail(
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<string | null> {
  const response = await fetchImpl("https://api.github.com/user/emails", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": "heyo-cms",
    },
  });
  if (!response.ok) return null;

  const emails = (await response.json()) as {
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }[];
  // Verified only: an unverified address at the provider is an address
  // somebody else may control, and it is about to be matched against a CMS
  // account.
  const chosen =
    emails.find((entry) => entry.primary && entry.verified) ??
    emails.find((entry) => entry.verified);
  return chosen?.email ?? null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
