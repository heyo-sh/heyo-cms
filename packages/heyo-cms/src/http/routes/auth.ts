import { sessionCookieName } from "../../auth/service";
import { CmsError } from "../../errors";
import type { AuthMethod, TokenDelivery } from "../../types/config";
import type { CmsInstance } from "../../types/instance";
import type { IssuedToken, RequestMeta, SignInResult } from "../../types/auth";
import { requireActor, requireSession } from "../guard";
import {
  json,
  noContent,
  optionalString,
  optionalStringArray,
  readJsonObject,
  requireString,
} from "../respond";
import type { RouteRecord } from "../router";
import { jsonBody, okJson, pathParam, queryParam, ref } from "../spec";

/**
 * Editor authentication over HTTP.
 *
 * Every handler is a call into `cms.auth` plus a cookie, and the routes that
 * exist are decided by `admin.auth.methods`: a deployment that never enabled
 * magic links does not answer `POST /auth/magic-link` with "not configured",
 * it does not have the endpoint. `cms.inspect().routes` is then a true
 * statement about the doors this deployment has.
 */
export function authRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  const auth = config.admin.auth;
  if (!auth) return [];

  const methods = new Set<AuthMethod>(auth.methods);
  const tags = ["auth"];
  const routes: RouteRecord[] = [];

  /**
   * The cookie the panel uses, and the token the body carries.
   *
   * Both, deliberately. A browser needs an HttpOnly cookie — a token in
   * `localStorage` is readable by every script on the page — and a CLI or a
   * test needs the string. `Path` is the mount point rather than `/`, so the
   * rest of the application never receives the editor's session.
   */
  const withSession = (result: SignInResult, request: Request): Response => {
    if (result.status !== "signed-in") {
      return json(
        {
          status: result.status,
          challenge: result.challenge,
          expiresAt: result.expiresAt,
        },
        200,
      );
    }
    return json(
      {
        status: result.status,
        token: result.token,
        expiresAt: result.expiresAt,
        user: result.user,
        actor: result.actor,
      },
      200,
      { "set-cookie": sessionCookie(result.token, result.expiresAt, request, config.basePath) }, // prettier-ignore
    );
  };

  if (methods.has("password") && auth.firstUser !== false) {
    /**
     * The one unauthenticated write in the API.
     *
     * It is safe because it is self-closing: the handler refuses the moment
     * `cms_users` has a row, and the row it creates is the one that makes it
     * refuse. That is a different thing from Payload's open first-user route,
     * which stays mounted and has to be remembered; here there is no state to
     * remember, because the account *is* the state.
     *
     * `GET /panel` reports the same fact as `auth.setupRequired`, so the
     * sign-in screen knows whether to draw this form before it is submitted.
     */
    routes.push({
      method: "POST",
      path: "/auth/setup",
      source: "core",
      handler: async (context) => {
        const body = await readJsonObject(context.request);
        const name = optionalString(body, "name");
        const result = await cms.auth.setup.claim({
          email: requireString(body, "email"),
          password: requireString(body, "password"),
          ...(name === undefined ? {} : { name }),
          ...requestMeta(context.request),
        });
        return withSession(result, context.request);
      },
      openapi: {
        summary: "Claim a CMS that has no accounts",
        description:
          "Creates the first editor and signs it in. Answers 409 once any account exists, including one created by a request that arrived a millisecond earlier: the count is taken inside the transaction that does the insert. Disable with `admin.auth.firstUser: false`.",
        tags,
        security: false,
        requestBody: jsonBody({
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
            name: { type: "string" },
          },
        }),
        responses: {
          "200": okJson(ref("SignInResult"), "A session for the first editor."),
          "409": okJson(ref("Error"), "Somebody got here first. Sign in."),
        },
      },
    });
  }

  if (methods.has("password")) {
    routes.push({
      method: "POST",
      path: "/auth/sign-in",
      source: "core",
      handler: async (context) => {
        const body = await readJsonObject(context.request);
        const result = await cms.auth.password.signIn({
          email: requireString(body, "email"),
          password: requireString(body, "password"),
          ...requestMeta(context.request),
        });
        return withSession(result, context.request);
      },
      openapi: {
        summary: "Sign in with a password",
        description:
          'Answers either a session or `{ status: "two-factor-required", challenge }`. There is no way to turn the second into the first without a valid code.',
        tags,
        security: false,
        requestBody: jsonBody({
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
          },
        }),
        responses: {
          "200": okJson(ref("SignInResult"), "A session, or a challenge."),
          "401": okJson(ref("Error"), "Wrong credentials, in constant time."),
        },
      },
    });
  }

  routes.push(
    {
      method: "GET",
      path: "/auth/session",
      source: "core",
      handler: async (context) => {
        // Not an error when absent: "am I signed in" is a question a sign-in
        // page asks before it has an answer, and a 401 there would put a
        // failure in every browser console on first load.
        if (!context.actor) return json({ actor: null, user: null });
        const user = await cms.auth.users.get(context.actor.id);
        return json({ actor: context.actor, user });
      },
      openapi: {
        summary: "Who is calling",
        description:
          "Resolves the session cookie or the `Authorization` header. Answers `{ actor: null }` rather than 401 when there is no caller.",
        tags,
        security: false,
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                actor: { oneOf: [ref("Actor"), { type: "null" }] },
                user: { oneOf: [ref("User"), { type: "null" }] },
              },
            },
            "The caller, if any.",
          ),
        },
      },
    },
    {
      method: "POST",
      path: "/auth/sign-out",
      source: "core",
      handler: async (context) => {
        const token = bearerOrCookie(context.request);
        if (token) await cms.auth.sessions.revoke(token);
        return noContent({
          "set-cookie": clearedCookie(context.request, config.basePath),
        });
      },
      openapi: {
        summary: "Sign out",
        description:
          "Revokes the session server-side and clears the cookie. Idempotent: signing out twice is not an error.",
        tags,
        responses: { "204": { description: "The session is gone." } },
      },
    },
  );

  if (methods.has("magic-link")) {
    const deliver = auth.deliverToken;
    if (deliver) {
      routes.push({
        method: "POST",
        path: "/auth/magic-link",
        source: "core",
        handler: async (context) => {
          const body = await readJsonObject(context.request);
          const issued = await cms.auth.magicLink.request({
            email: requireString(body, "email"),
          });
          await deliverIfIssued(deliver, "magic-link", issued, context.request, cms); // prettier-ignore
          // The same answer either way. A different response for an unknown
          // address turns this endpoint into a way to enumerate the editors
          // of every site that uses the CMS.
          return json({ status: "sent" });
        },
        openapi: {
          summary: "Request a magic link",
          description:
            "Mints a single-use token and hands it to `admin.auth.deliverToken`. The response never contains the token and never says whether the address exists.",
          tags,
          security: false,
          requestBody: jsonBody({
            type: "object",
            required: ["email"],
            properties: { email: { type: "string", format: "email" } },
          }),
          responses: { "200": okJson({ type: "object" }, '`{ status: "sent" }`.') }, // prettier-ignore
        },
      });
    }

    routes.push({
      method: "POST",
      path: "/auth/magic-link/verify",
      source: "core",
      handler: async (context) => {
        const body = await readJsonObject(context.request);
        const result = await cms.auth.magicLink.verify({
          token: requireString(body, "token"),
          ...requestMeta(context.request),
        });
        return withSession(result, context.request);
      },
      openapi: {
        summary: "Exchange a magic link for a session",
        tags,
        security: false,
        requestBody: jsonBody({
          type: "object",
          required: ["token"],
          properties: { token: { type: "string" } },
        }),
        responses: {
          "200": okJson(ref("SignInResult"), "A session, or a challenge."),
          "401": okJson(ref("Error"), "The token is spent, expired or unknown."), // prettier-ignore
        },
      },
    });
  }

  if (methods.has("password")) {
    const deliver = auth.deliverToken;
    if (deliver) {
      routes.push({
        method: "POST",
        path: "/auth/password/forgot",
        source: "core",
        handler: async (context) => {
          const body = await readJsonObject(context.request);
          const issued = await cms.auth.password.requestReset({
            email: requireString(body, "email"),
          });
          await deliverIfIssued(deliver, "password-reset", issued, context.request, cms); // prettier-ignore
          return json({ status: "sent" });
        },
        openapi: {
          summary: "Request a password reset",
          description:
            "Same shape as the magic link, and the same silence about whether the address exists.",
          tags,
          security: false,
          requestBody: jsonBody({
            type: "object",
            required: ["email"],
            properties: { email: { type: "string", format: "email" } },
          }),
          responses: { "200": okJson({ type: "object" }, '`{ status: "sent" }`.') }, // prettier-ignore
        },
      });
    }

    routes.push({
      method: "POST",
      path: "/auth/password/reset",
      source: "core",
      handler: async (context) => {
        const body = await readJsonObject(context.request);
        const user = await cms.auth.password.reset({
          token: requireString(body, "token"),
          password: requireString(body, "password"),
        });
        return json({ user });
      },
      openapi: {
        summary: "Set a new password with a reset token",
        description:
          "Every session of that user is revoked: a reset is what somebody does when they believe their password is known to a stranger.",
        tags,
        security: false,
        requestBody: jsonBody({
          type: "object",
          required: ["token", "password"],
          properties: {
            token: { type: "string" },
            password: { type: "string", minLength: 8 },
          },
        }),
        responses: {
          "200": okJson({ type: "object", properties: { user: ref("User") } }, "The user."), // prettier-ignore
          "401": okJson(ref("Error"), "The token is spent, expired or unknown."), // prettier-ignore
        },
      },
    });
  }

  routes.push({
    method: "POST",
    path: "/auth/invite/accept",
    source: "core",
    handler: async (context) => {
      const body = await readJsonObject(context.request);
      const password = optionalString(body, "password");
      const name = optionalString(body, "name");
      const result = await cms.auth.users.acceptInvite({
        token: requireString(body, "token"),
        ...(password === undefined ? {} : { password }),
        ...(name === undefined ? {} : { name }),
        ...requestMeta(context.request),
      });
      return withSession(result, context.request);
    },
    openapi: {
      summary: "Accept an invitation",
      description:
        "Turns an invited account into an active one and signs it in. The token comes from `POST /users/invite`, which an administrator calls.",
      tags,
      security: false,
      requestBody: jsonBody({
        type: "object",
        required: ["token"],
        properties: {
          token: { type: "string" },
          password: { type: "string", minLength: 8 },
          name: { type: "string" },
        },
      }),
      responses: {
        "200": okJson(ref("SignInResult"), "A session."),
        "401": okJson(ref("Error"), "The invitation is spent, expired or unknown."), // prettier-ignore
      },
    },
  });

  // ---- OAuth and SSO ----------------------------------------------------
  const providers = [
    ...["github", "google", "microsoft"].filter((provider) =>
      methods.has(provider as AuthMethod),
    ),
    ...(auth.sso ? ["oidc"] : []),
  ];

  if (providers.length > 0) {
    routes.push(
      {
        method: "GET",
        path: "/auth/oauth/:provider",
        source: "core",
        handler: async (context) => {
          const provider = requireProvider(context.params.provider, providers);
          const redirectTo = context.query.get("redirectTo");
          const start = await cms.auth.oauth.authorize({
            provider,
            redirectUri: callbackUrl(
              context.request,
              config.basePath,
              provider,
            ),
            ...(redirectTo === null ? {} : { redirectTo }),
          });
          // A redirect rather than JSON: this URL is what a browser is sent
          // to, and a fetch wrapper around it would lose the provider's
          // cookies and break every "you are already signed in" shortcut.
          return new Response(null, {
            status: 302,
            headers: { location: start.url },
          });
        },
        openapi: {
          summary: "Start an OAuth or SSO sign-in",
          description: `Redirects to the provider. Configured here: ${providers.join(", ")}.`, // prettier-ignore
          tags,
          security: false,
          parameters: [
            pathParam("provider", providers.join(", ")),
            queryParam("redirectTo", "string", "Where to land after the callback."), // prettier-ignore
          ],
          responses: {
            "302": { description: "To the provider." },
            "404": okJson(ref("Error"), "That provider is not configured."),
          },
        },
      },
      {
        method: "GET",
        path: "/auth/oauth/:provider/callback",
        source: "core",
        handler: async (context) => {
          const provider = requireProvider(context.params.provider, providers);
          const code = context.query.get("code");
          const state = context.query.get("state");
          if (!code || !state) {
            throw CmsError.validation(
              "The provider did not return a code and a state.",
            );
          }
          const result = await cms.auth.oauth.callback({
            provider,
            code,
            state,
            redirectUri: callbackUrl(
              context.request,
              config.basePath,
              provider,
            ),
            ...requestMeta(context.request),
          });

          const target = result.redirectTo;
          if (result.status === "signed-in" && target) {
            // The panel asked where to go before the round trip started, so
            // the browser lands where the editor was rather than on a JSON
            // document it cannot read.
            return new Response(null, {
              status: 302,
              headers: {
                location: target,
                "set-cookie": sessionCookie(
                  result.token,
                  result.expiresAt,
                  context.request,
                  config.basePath,
                ),
              },
            });
          }
          return withSession(result, context.request);
        },
        openapi: {
          summary: "Finish an OAuth or SSO sign-in",
          tags,
          security: false,
          parameters: [
            pathParam("provider", providers.join(", ")),
            queryParam("code", "string", "From the provider."),
            queryParam("state", "string", "From the provider; checked against the stored one."), // prettier-ignore
          ],
          responses: {
            "200": okJson(ref("SignInResult"), "A session, or a challenge."),
            "302": { description: "To `redirectTo`, with the cookie set." },
            "401": okJson(ref("Error"), "The state did not match, or the account is unknown."), // prettier-ignore
          },
        },
      },
    );
  }

  // ---- Two-factor -------------------------------------------------------
  if (auth.twoFactor === true) {
    routes.push(
      {
        method: "POST",
        path: "/auth/2fa/begin",
        source: "core",
        handler: async (context) => {
          const actor = requireSession(context.actor);
          const setup = await cms.auth.twoFactor.begin(actor.id);
          return json(setup);
        },
        openapi: {
          summary: "Start enrolling an authenticator",
          description:
            "Returns the secret and the `otpauth://` URI the panel renders as a QR code. The factor is not enabled until a code proves it works.",
          tags,
          responses: {
            "200": okJson(
              {
                type: "object",
                properties: { secret: { type: "string" }, uri: { type: "string" } }, // prettier-ignore
              },
              "The secret and its URI.",
            ),
          },
        },
      },
      {
        method: "POST",
        path: "/auth/2fa/enable",
        source: "core",
        handler: async (context) => {
          const actor = requireSession(context.actor);
          const body = await readJsonObject(context.request);
          const user = await cms.auth.twoFactor.enable({
            userId: actor.id,
            code: requireString(body, "code"),
          });
          return json({ user });
        },
        openapi: {
          summary: "Confirm the authenticator",
          tags,
          requestBody: jsonBody({
            type: "object",
            required: ["code"],
            properties: { code: { type: "string" } },
          }),
          responses: {
            "200": okJson({ type: "object", properties: { user: ref("User") } }, "The user."), // prettier-ignore
            "401": okJson(ref("Error"), "The code is wrong."),
          },
        },
      },
      {
        method: "POST",
        path: "/auth/2fa/disable",
        source: "core",
        handler: async (context) => {
          const actor = requireSession(context.actor);
          const user = await cms.auth.twoFactor.disable(actor.id);
          return json({ user });
        },
        openapi: {
          summary: "Remove the second factor",
          tags,
          responses: {
            "200": okJson({ type: "object", properties: { user: ref("User") } }, "The user."), // prettier-ignore
          },
        },
      },
      {
        method: "POST",
        path: "/auth/2fa/verify",
        source: "core",
        handler: async (context) => {
          const body = await readJsonObject(context.request);
          const result = await cms.auth.twoFactor.complete({
            challenge: requireString(body, "challenge"),
            code: requireString(body, "code"),
            ...requestMeta(context.request),
          });
          return withSession(result, context.request);
        },
        openapi: {
          summary: "Exchange a challenge and a code for a session",
          description:
            "The only way a `two-factor-required` answer becomes a session. Five wrong codes destroy the challenge.",
          tags,
          security: false,
          requestBody: jsonBody({
            type: "object",
            required: ["challenge", "code"],
            properties: { challenge: { type: "string" }, code: { type: "string" } }, // prettier-ignore
          }),
          responses: {
            "200": okJson(ref("SignInResult"), "A session."),
            "401": okJson(ref("Error"), "The code is wrong, or the challenge is spent."), // prettier-ignore
          },
        },
      },
    );
  }

  // ---- API keys ---------------------------------------------------------
  if (auth.apiKeys?.enabled === true) {
    routes.push(
      {
        method: "GET",
        path: "/auth/api-keys",
        source: "core",
        handler: async (context) => {
          const actor = requireActor(context.actor);
          const keys = await cms.auth.apiKeys.list({ userId: actor.id });
          return json({ keys });
        },
        openapi: {
          summary: "List your API keys",
          description: "Your own keys. The key material is never returned again.", // prettier-ignore
          tags,
          responses: {
            "200": okJson(
              { type: "object", properties: { keys: { type: "array", items: ref("ApiKey") } } }, // prettier-ignore
              "The caller's keys.",
            ),
          },
        },
      },
      {
        method: "POST",
        path: "/auth/api-keys",
        source: "core",
        handler: async (context) => {
          // A session, not a key: a key that can mint keys turns one leak
          // into a permanent foothold that revoking the original does not
          // close.
          const actor = requireSession(context.actor);
          const body = await readJsonObject(context.request);
          const scopes = optionalStringArray(body, "scopes");
          const issued = await cms.auth.apiKeys.create({
            name: requireString(body, "name"),
            userId: actor.id,
            actor,
            ...(scopes === undefined ? {} : { scopes }),
          });
          return json(issued, 201);
        },
        openapi: {
          summary: "Issue an API key",
          description:
            "Bound to the caller, and never wider: the scopes are intersected with the caller's own permissions, so a read-only key on an administrator's account is read-only. `key` is shown once.",
          tags,
          requestBody: jsonBody({
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              scopes: { type: "array", items: { type: "string" } },
            },
          }),
          responses: {
            "201": okJson(ref("IssuedApiKey"), "The key, once."),
            "403": okJson(ref("Error"), "An API key cannot issue another."),
          },
        },
      },
      {
        method: "DELETE",
        path: "/auth/api-keys/:id",
        source: "core",
        handler: async (context) => {
          const actor = requireActor(context.actor);
          const id = context.params.id as string;
          const keys = await cms.auth.apiKeys.list({ userId: actor.id });
          if (!keys.some((key) => key.id === id)) {
            // Somebody else's key reads as missing rather than forbidden: a
            // 403 here would confirm that the id exists.
            throw CmsError.notFound("No such API key.");
          }
          await cms.auth.apiKeys.revoke(id, { actor });
          return noContent();
        },
        openapi: {
          summary: "Revoke one of your API keys",
          tags,
          parameters: [pathParam("id", "Key id.")],
          responses: {
            "204": { description: "Revoked." },
            "404": okJson(ref("Error"), "Not one of your keys."),
          },
        },
      },
    );
  }

  return routes;
}

async function deliverIfIssued(
  deliver: (message: TokenDelivery) => void | Promise<void>,
  type: TokenDelivery["type"],
  issued: IssuedToken | null,
  request: Request,
  cms: CmsInstance,
): Promise<void> {
  if (!issued) return;
  const url = new URL(request.url);
  const path = type === "magic-link" ? "magic-link" : "reset-password";
  await deliver({
    type,
    token: issued.token,
    expiresAt: issued.expiresAt,
    email: issued.email,
    userId: issued.userId,
    url: `${url.origin}${cms._config.basePath}${cms._config.admin.path}/${path}?token=${encodeURIComponent(issued.token)}`, // prettier-ignore
  });
}

function requestMeta(request: Request): RequestMeta {
  // Only what a proxy actually set. Inventing an address from the socket is
  // worse than none: every record would read as the load balancer.
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() ?? request.headers.get("cf-connecting-ip"); // prettier-ignore
  return {
    ip: ip && ip.length > 0 ? ip : null,
    userAgent: request.headers.get("user-agent"),
  };
}

function bearerOrCookie(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer "))
    return header.slice(7).trim();
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === sessionCookieName) return rest.join("=");
  }
  return null;
}

/**
 * The session cookie.
 *
 * `Secure` is set whenever the request arrived over HTTPS, and omitted on
 * plain HTTP — which is only ever `localhost`, where setting it would stop
 * development from working at all. `SameSite=Lax` lets the OAuth callback's
 * top-level redirect carry it while keeping it off cross-site requests.
 */
function sessionCookie(
  token: string,
  expiresAt: string,
  request: Request,
  basePath: string,
): string {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${sessionCookieName}=${token}`,
    `Path=${basePath}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function clearedCookie(request: Request, basePath: string): string {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${sessionCookieName}=`,
    `Path=${basePath}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function callbackUrl(
  request: Request,
  basePath: string,
  provider: string,
): string {
  const url = new URL(request.url);
  return `${url.origin}${basePath}/auth/oauth/${provider}/callback`;
}

function requireProvider(value: string | undefined, allowed: string[]): string {
  if (value === undefined || !allowed.includes(value)) {
    throw CmsError.notFound(
      `"${value ?? ""}" is not a configured sign-in provider.`,
    );
  }
  return value;
}
