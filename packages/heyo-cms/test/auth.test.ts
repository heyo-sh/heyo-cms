import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, test } from "bun:test";

import { cmsUsers, oidc } from "../src/auth";
import { sessionCookieName } from "../src/auth/service";
import { totpCode } from "../src/auth/totp";
import { defineCollection, heyoCms } from "../src/config";
import { mongodb } from "../src/db/mongodb";
import { postgres, type PostgresClient } from "../src/db/postgres";
import { sqlite } from "../src/db/sqlite";
import { text } from "../src/fields";
import { eq } from "../src/query";
import { emptySnapshot } from "../src/schema/snapshot";
import type { DatabaseAdapter } from "../src/types/database";
import type { CmsEvent } from "../src/types/events";
import type { SignedIn } from "../src/types/auth";
import { memoryMongo } from "./mongo-memory";

/**
 * Stage 4: editor authentication.
 *
 * Everything here runs on all three engines, because an auth layer that works
 * on Postgres and leaks a session on MongoDB is worse than one that works
 * nowhere. The things being asserted are the ones that are easy to get subtly
 * wrong: single-use tokens, a second factor that cannot be stepped around, a
 * key that cannot outgrow its owner, and a disabled account that stops being
 * able to do anything *now* rather than at its next sign-in.
 */

interface EngineUnderTest {
  name: string;
  create(): Promise<DatabaseAdapter> | DatabaseAdapter;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch that answers from a table instead of the network. */
function stubFetch(routes: Record<string, unknown>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; // prettier-ignore
    // Longest prefix wins, so `/user/emails` is not answered by `/user`.
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((candidate) => url.startsWith(candidate));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function runAuthSuite(entry: EngineUnderTest): void {
  describe(`auth: ${entry.name}`, () => {
    const setup = async (
      options: {
        twoFactor?: boolean;
        customRoles?: boolean;
        sso?: boolean;
        methods?: Parameters<typeof cmsUsers>[0]["methods"];
        firstUser?: Parameters<typeof cmsUsers>[0]["firstUser"];
      } = {},
    ) => {
      const adapter = await entry.create();
      const cms = heyoCms({
        database: () => adapter,
        admin: {
          title: "Acme",
          auth: cmsUsers({
            methods: options.methods ?? ["password", "magic-link", "github"],
            ...(options.twoFactor === undefined
              ? {}
              : { twoFactor: options.twoFactor }),
            apiKeys: { enabled: true, scopes: ["read", "write"] },
            session: { expiresIn: "7d" },
            ...(options.firstUser === undefined
              ? {}
              : { firstUser: options.firstUser }),
            providers: {
              github: { clientId: "gh-id", clientSecret: "gh-secret" },
            },
            ...(options.sso
              ? {
                  sso: oidc({
                    issuer: "https://id.example.com",
                    clientId: "oidc-id",
                    clientSecret: "oidc-secret",
                    mapRoles: (claims) => (claims.groups as string[]) ?? [],
                  }),
                }
              : {}),
          }),
        },
        rbac: {
          roles: {
            admin: ["*"],
            editor: ["posts:*"],
            viewer: ["*:read"],
          },
          ...(options.customRoles === undefined
            ? {}
            : { customRoles: options.customRoles }),
        },
        collections: {
          posts: defineCollection({ fields: { title: text({}) } }),
        },
      });

      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_auth"),
      );

      const events: CmsEvent[] = [];
      cms.on("*", (event) => {
        events.push(event);
      });
      return { cms, adapter, events };
    };

    // -----------------------------------------------------------------------
    // Password
    // -----------------------------------------------------------------------

    test("signs in with a password and resolves the actor from a request", async () => {
      const { cms } = await setup();
      await cms.auth.users.create({
        email: "Editor@Example.com ",
        password: "correct horse",
        roles: ["editor"],
      });

      const result = await cms.auth.password.signIn({
        email: "editor@example.com",
        password: "correct horse",
        ip: "203.0.113.1",
      });
      expect(result.status).toBe("signed-in");
      const session = result as SignedIn;
      // Roles become permissions once, at sign-in, so every later check is a
      // string match rather than a database read.
      expect(session.actor.permissions).toEqual(["posts:*"]);
      expect(session.user.email).toBe("editor@example.com");

      const byHeader = await cms.auth.actorFromRequest(
        new Request("https://example.com", {
          headers: { authorization: `Bearer ${session.token}` },
        }),
      );
      expect(byHeader?.id).toBe(session.user.id);

      const byCookie = await cms.auth.actorFromRequest(
        new Request("https://example.com", {
          headers: { cookie: `other=1; ${sessionCookieName}=${session.token}` },
        }),
      );
      expect(byCookie?.id).toBe(session.user.id);

      // The plaintext exists once; the row holds a hash.
      const adapter = await cms.database();
      const rows = await adapter.transaction((tx) =>
        adapter.query(tx, { table: "cms_sessions" }),
      );
      expect(String(rows[0]?.token_hash)).not.toBe(session.token);
      await cms.close();
    });

    test("answers the same way for a wrong password and an unknown address", async () => {
      const { cms } = await setup();
      await cms.auth.users.create({ email: "a@example.com", password: "correct horse" }); // prettier-ignore

      await expect(
        cms.auth.password.signIn({
          email: "a@example.com",
          password: "wrong horse",
        }),
      ).rejects.toThrow("Invalid email or password");
      await expect(
        cms.auth.password.signIn({
          email: "nobody@example.com",
          password: "correct horse",
        }),
      ).rejects.toThrow("Invalid email or password");
      await cms.close();
    });

    test("a disabled account loses its sessions immediately", async () => {
      const { cms } = await setup();
      const user = await cms.auth.users.create({
        email: "a@example.com",
        password: "correct horse",
        roles: ["editor"],
      });
      const signedIn = (await cms.auth.password.signIn({
        email: "a@example.com",
        password: "correct horse",
      })) as SignedIn;
      expect(await cms.auth.actorFromToken(signedIn.token)).not.toBeNull();

      await cms.auth.users.update(user.id, { status: "disabled" });

      // Not "at the next sign-in": the live session is what access is made of.
      expect(await cms.auth.actorFromToken(signedIn.token)).toBeNull();
      await expect(
        cms.auth.password.signIn({
          email: "a@example.com",
          password: "correct horse",
        }),
      ).rejects.toThrow(/disabled/);
      await cms.close();
    });

    test("a reset ends every session and the link cannot be replayed", async () => {
      const { cms } = await setup();
      const user = await cms.auth.users.create({
        email: "a@example.com",
        password: "correct horse",
      });
      const old = (await cms.auth.password.signIn({
        email: "a@example.com",
        password: "correct horse",
      })) as SignedIn;

      const issued = await cms.auth.password.requestReset({ email: "A@example.com" }); // prettier-ignore
      expect(issued?.userId).toBe(user.id);

      await cms.auth.password.reset({
        token: issued?.token as string,
        password: "a new password",
      });
      expect(await cms.auth.actorFromToken(old.token)).toBeNull();
      await expect(
        cms.auth.password.reset({
          token: issued?.token as string,
          password: "another password",
        }),
      ).rejects.toThrow(/already been used/);

      const fresh = await cms.auth.password.signIn({
        email: "a@example.com",
        password: "a new password",
      });
      expect(fresh.status).toBe("signed-in");
      await cms.close();
    });

    test("an unknown address gets no reset token and no error", async () => {
      const { cms } = await setup();
      // Returning `null` rather than throwing is what stops the reset form
      // from becoming a directory of who has an account.
      expect(await cms.auth.password.requestReset({ email: "ghost@example.com" })).toBeNull(); // prettier-ignore
      await cms.close();
    });

    test("refuses a sign-in method the configuration never enabled", async () => {
      const { cms } = await setup({ methods: ["password"] });
      await expect(
        cms.auth.magicLink.request({ email: "a@example.com" }),
      ).rejects.toThrow(/"magic-link" sign-in method is not enabled/);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // The first account
    // -----------------------------------------------------------------------

    test("claims an empty CMS once, and never again", async () => {
      const { cms, events } = await setup();
      expect(await cms.auth.setup.required()).toBe(true);

      const first = await cms.auth.setup.claim({
        email: "Owner@Example.com ",
        password: "a good password",
        name: "Owner",
      });
      expect(first.status).toBe("signed-in");
      expect(first.user.email).toBe("owner@example.com");
      expect(first.user.roles).toEqual(["admin"]);
      // The point of the exercise: the account that claims the deployment can
      // administer it, which means `*`.
      expect(first.actor.permissions).toEqual(["*"]);
      // And it is signed in, not merely created: nobody has to go and find a
      // password they never chose.
      expect(await cms.auth.actorFromToken(first.token)).not.toBeNull();

      // One account is enough to close the door, whoever opened it.
      expect(await cms.auth.setup.required()).toBe(false);
      await expect(
        cms.auth.setup.claim({
          email: "squatter@example.com",
          password: "another password",
        }),
      ).rejects.toThrow(/already has an account/);

      await cms.drainEvents();
      const joined = events.find((event) => event.type === "user.joined");
      expect(joined?.data.email).toBe("owner@example.com");
      expect(joined?.data.first).toBe(true);
      await cms.close();
    });

    test("an account made any other way closes the first-account route too", async () => {
      const { cms } = await setup();
      // `heyo-cms create-admin` is still the provisioning path for a pipeline,
      // and a deployment that used it must not also offer the screen.
      await cms.auth.users.create({
        email: "cli@example.com",
        password: "a good password",
        roles: ["admin"],
      });
      expect(await cms.auth.setup.required()).toBe(false);
      await expect(
        cms.auth.setup.claim({
          email: "someone@example.com",
          password: "a good password",
        }),
      ).rejects.toThrow(/already has an account/);
      await cms.close();
    });

    test("the first account still obeys the password policy", async () => {
      const { cms } = await setup();
      await expect(
        cms.auth.setup.claim({ email: "owner@example.com", password: "short" }),
      ).rejects.toThrow(/at least 8 characters/);
      // A refused claim leaves the deployment unclaimed rather than half-made.
      expect(await cms.auth.setup.required()).toBe(true);
      await cms.close();
    });

    test("a configuration can refuse to be claimed over HTTP", async () => {
      const { cms } = await setup({ firstUser: false });
      expect(await cms.auth.setup.required()).toBe(false);
      await expect(
        cms.auth.setup.claim({
          email: "owner@example.com",
          password: "a good password",
        }),
      ).rejects.toThrow(/create-admin/);
      await cms.close();
    });

    test("the first account can be given the roles the deployment names", async () => {
      const { cms } = await setup({ firstUser: { roles: ["editor"] } });
      const claimed = await cms.auth.setup.claim({
        email: "owner@example.com",
        password: "a good password",
      });
      expect(claimed.user.roles).toEqual(["editor"]);
      expect(claimed.actor.permissions).toEqual(["posts:*"]);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Invitations and magic links
    // -----------------------------------------------------------------------

    test("invites, accepts once, and emits who was invited but not the token", async () => {
      const { cms, events } = await setup();
      const invite = await cms.auth.users.invite({
        email: "new@example.com",
        roles: ["editor"],
      });
      expect(invite.user.status).toBe("invited");

      // An invited account is not an account yet.
      await expect(
        cms.auth.password.signIn({
          email: "new@example.com",
          password: "whatever you like",
        }),
      ).rejects.toThrow(/Invalid email or password/);

      const joined = await cms.auth.users.acceptInvite({
        token: invite.token,
        password: "a good password",
        name: "New Editor",
      });
      expect(joined.user.status).toBe("active");
      expect(joined.user.name).toBe("New Editor");
      expect(joined.actor.permissions).toEqual(["posts:*"]);

      await expect(
        cms.auth.users.acceptInvite({ token: invite.token }),
      ).rejects.toThrow(/already been used/);

      await cms.drainEvents();
      const invited = events.find((event) => event.type === "user.invited");
      expect(invited?.data.email).toBe("new@example.com");
      // The event says who, never the secret: a webhook subscriber that could
      // read the token could become the invitee.
      expect(JSON.stringify(invited)).not.toContain(invite.token);
      expect(events.map((event) => event.type)).toContain("user.joined");
      await cms.close();
    });

    test("a magic link signs in once and activates an invitation", async () => {
      const { cms } = await setup();
      await cms.auth.users.invite({ email: "new@example.com", roles: ["viewer"] }); // prettier-ignore

      const link = await cms.auth.magicLink.request({ email: "new@example.com" }); // prettier-ignore
      const result = (await cms.auth.magicLink.verify({
        token: link?.token as string,
      })) as SignedIn;

      expect(result.status).toBe("signed-in");
      // Receiving mail at the address proves what the invitation asked for.
      expect(result.user.status).toBe("active");

      await expect(
        cms.auth.magicLink.verify({ token: link?.token as string }),
      ).rejects.toThrow(/already been used/);
      await cms.close();
    });

    test("an expired token is refused", async () => {
      const { cms } = await setup();
      await cms.auth.users.create({ email: "a@example.com", password: "correct horse" }); // prettier-ignore
      const link = await cms.auth.magicLink.request({ email: "a@example.com" });

      const adapter = await cms.database();
      await adapter.transaction((tx) =>
        adapter.mutate(tx, {
          kind: "update",
          table: "cms_tokens",
          where: eq("type", "magic-link"),
          set: { expires_at: new Date(Date.now() - 1000) },
          returning: false,
        }),
      );

      await expect(
        cms.auth.magicLink.verify({ token: link?.token as string }),
      ).rejects.toThrow(/invalid or has expired/);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Two-factor
    // -----------------------------------------------------------------------

    test("a second factor cannot be skipped by signing in another way", async () => {
      const { cms } = await setup({ twoFactor: true });
      const user = await cms.auth.users.create({
        email: "a@example.com",
        password: "correct horse",
        roles: ["editor"],
      });

      const setupResult = await cms.auth.twoFactor.begin(user.id);
      expect(setupResult.uri).toContain("otpauth://totp/Acme:");

      // Enrolment is not complete until a code proves the authenticator has
      // the secret, so sign-in is untouched in the meantime.
      const beforeEnable = await cms.auth.password.signIn({
        email: "a@example.com",
        password: "correct horse",
      });
      expect(beforeEnable.status).toBe("signed-in");

      await expect(
        cms.auth.twoFactor.enable({ userId: user.id, code: "000000" }),
      ).rejects.toThrow(/not valid/);
      await cms.auth.twoFactor.enable({
        userId: user.id,
        code: await totpCode(setupResult.secret),
      });

      const challenged = await cms.auth.password.signIn({
        email: "a@example.com",
        password: "correct horse",
      });
      expect(challenged.status).toBe("two-factor-required");
      const challenge =
        challenged.status === "two-factor-required" ? challenged.challenge : "";

      // The magic link is the other door into the same account, and it is
      // challenged too.
      const link = await cms.auth.magicLink.request({ email: "a@example.com" });
      const viaLink = await cms.auth.magicLink.verify({
        token: link?.token as string,
      });
      expect(viaLink.status).toBe("two-factor-required");

      // A typo does not send the editor back to the password form; the fifth
      // one destroys the challenge.
      await expect(
        cms.auth.twoFactor.complete({ challenge, code: "000000" }),
      ).rejects.toThrow(/not valid/);

      const session = await cms.auth.twoFactor.complete({
        challenge,
        code: await totpCode(setupResult.secret),
      });
      expect(session.status).toBe("signed-in");
      expect(session.user.twoFactorEnabled).toBe(true);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // API keys
    // -----------------------------------------------------------------------

    test("a key narrows its owner and never widens them", async () => {
      const { cms, events } = await setup();
      const admin = await cms.auth.users.create({
        email: "admin@example.com",
        roles: ["admin"],
      });

      const key = await cms.auth.apiKeys.create({
        name: "Deploy",
        userId: admin.id,
        scopes: ["read"],
      });
      expect(key.key).toStartWith("hck_");
      expect(key.prefix.length).toBeLessThan(key.key.length);

      const actor = await cms.auth.actorFromToken(key.key);
      // The owner is an administrator; the key is read-only anyway.
      expect(actor?.source).toBe("api-key");
      expect(actor?.permissions).toEqual(["*:read"]);
      // The owner's id, so an ownership rule keeps working for a key.
      expect(actor?.id).toBe(admin.id);

      await expect(
        cms.auth.apiKeys.create({ name: "Bad", scopes: ["posts:delete"] }),
      ).rejects.toThrow(/not in admin.auth.apiKeys.scopes/);

      expect(await cms.auth.apiKeys.revoke(key.id)).toBe(true);
      expect(await cms.auth.actorFromToken(key.key)).toBeNull();
      // Revoked, not deleted: the activity log refers to it by id.
      const listed = await cms.auth.apiKeys.list();
      expect(listed[0]?.revokedAt).not.toBeNull();
      expect(listed[0]?.lastUsedAt).not.toBeNull();

      await cms.drainEvents();
      expect(events.map((event) => event.type)).toContain("apikey.created");
      expect(events.map((event) => event.type)).toContain("apikey.revoked");
      await cms.close();
    });

    test("an unbound key carries its scopes and nothing else", async () => {
      const { cms } = await setup();
      const key = await cms.auth.apiKeys.create({
        name: "Build",
        scopes: ["write"],
      });
      const actor = await cms.auth.actorFromToken(key.key);
      expect(actor?.roles).toEqual([]);
      expect(actor?.permissions).toEqual(["*:create", "*:read", "*:update"]);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Roles
    // -----------------------------------------------------------------------

    test("roles created in the panel join the configured ones", async () => {
      const { cms, events } = await setup({ customRoles: true });
      await cms.auth.roles.create({
        name: "translator",
        permissions: ["posts:read", "posts:update"],
      });

      const names = (await cms.auth.roles.list()).map((role) => role.name);
      expect(names).toContain("translator");
      expect(names).toContain("editor");

      expect(await cms.auth.roles.permissionsFor(["translator"])).toEqual([
        "posts:read",
        "posts:update",
      ]);

      // Configuration wins: a database row must not silently redefine a role
      // that is reviewable in the repository.
      await expect(
        cms.auth.roles.create({ name: "editor", permissions: ["*"] }),
      ).rejects.toThrow(/defined in the configuration/);

      const user = await cms.auth.users.create({
        email: "t@example.com",
        roles: ["translator"],
      });
      await cms.auth.users.update(user.id, { roles: ["editor"] });
      await cms.drainEvents();
      expect(events.map((event) => event.type)).toContain("role.changed");

      await expect(
        cms.auth.users.update(user.id, { roles: ["nonexistent"] }),
      ).rejects.toThrow(/Unknown role "nonexistent"/);
      await cms.close();
    });

    test("refuses to manage roles in a configuration that did not ask for it", async () => {
      const { cms } = await setup();
      await expect(
        cms.auth.roles.create({ name: "translator", permissions: ["*:read"] }),
      ).rejects.toThrow(/rbac.customRoles/);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // OAuth
    // -----------------------------------------------------------------------

    test("links an external identity to an invited account, and refuses a stranger", async () => {
      const { cms } = await setup();
      await cms.auth.users.invite({ email: "dev@example.com", roles: ["editor"] }); // prettier-ignore

      stubFetch({
        "https://github.com/login/oauth/access_token": {
          access_token: "gho_1",
        },
        "https://api.github.com/user": { id: 42, login: "dev", email: null },
        "https://api.github.com/user/emails": [
          { email: "dev@example.com", primary: true, verified: true },
        ],
      });

      const start = await cms.auth.oauth.authorize({
        provider: "github",
        redirectUri: "https://app.example.com/callback",
        redirectTo: "/admin",
      });
      expect(start.url).toContain("client_id=gh-id");
      expect(start.url).toContain("state=");

      const signedIn = await cms.auth.oauth.callback({
        provider: "github",
        code: "code-1",
        state: start.state,
        redirectUri: "https://app.example.com/callback",
      });
      expect(signedIn.status).toBe("signed-in");
      expect(signedIn.redirectTo).toBe("/admin");

      // The state is single use, so a replayed callback is dead.
      await expect(
        cms.auth.oauth.callback({
          provider: "github",
          code: "code-1",
          state: start.state,
          redirectUri: "https://app.example.com/callback",
        }),
      ).rejects.toThrow(/already been used/);

      // A GitHub account is not an invitation.
      stubFetch({
        "https://github.com/login/oauth/access_token": {
          access_token: "gho_2",
        },
        "https://api.github.com/user": {
          id: 99,
          login: "stranger",
          email: "stranger@example.com",
        },
      });
      const second = await cms.auth.oauth.authorize({
        provider: "github",
        redirectUri: "https://app.example.com/callback",
      });
      await expect(
        cms.auth.oauth.callback({
          provider: "github",
          code: "code-2",
          state: second.state,
          redirectUri: "https://app.example.com/callback",
        }),
      ).rejects.toThrow(/has to invite this address first/);
      await cms.close();
    });

    test("SSO provisions an account and re-applies mapped roles on every sign-in", async () => {
      const { cms } = await setup({ sso: true });
      const claims = {
        sub: "sso-1",
        email: "person@acme.test",
        name: "Person",
        groups: ["editor"],
      };

      stubFetch({
        "https://id.example.com/.well-known/openid-configuration": {
          authorization_endpoint: "https://id.example.com/authorize",
          token_endpoint: "https://id.example.com/token",
          userinfo_endpoint: "https://id.example.com/userinfo",
        },
        "https://id.example.com/token": { access_token: "at_1" },
        "https://id.example.com/userinfo": claims,
      });

      const start = await cms.auth.oauth.authorize({
        provider: "oidc",
        redirectUri: "https://app.example.com/callback",
      });
      // Discovery, and PKCE because the provider supports it.
      expect(start.url).toStartWith("https://id.example.com/authorize?");
      expect(start.url).toContain("code_challenge_method=S256");

      const first = (await cms.auth.oauth.callback({
        provider: "oidc",
        code: "code-1",
        state: start.state,
        redirectUri: "https://app.example.com/callback",
      })) as SignedIn & { redirectTo: string | null };
      expect(first.user.email).toBe("person@acme.test");
      expect(first.actor.roles).toEqual(["editor"]);

      // The identity provider demotes them; the next sign-in has to notice.
      stubFetch({
        "https://id.example.com/.well-known/openid-configuration": {
          authorization_endpoint: "https://id.example.com/authorize",
          token_endpoint: "https://id.example.com/token",
          userinfo_endpoint: "https://id.example.com/userinfo",
        },
        "https://id.example.com/token": { access_token: "at_2" },
        "https://id.example.com/userinfo": { ...claims, groups: ["viewer"] },
      });
      const second = await cms.auth.oauth.authorize({
        provider: "oidc",
        redirectUri: "https://app.example.com/callback",
      });
      const again = (await cms.auth.oauth.callback({
        provider: "oidc",
        code: "code-2",
        state: second.state,
        redirectUri: "https://app.example.com/callback",
      })) as SignedIn & { redirectTo: string | null };
      expect(again.actor.roles).toEqual(["viewer"]);
      expect(again.actor.permissions).toEqual(["*:read"]);
      await cms.close();
    });

    test("a callback whose redirect URI moved is refused", async () => {
      const { cms } = await setup();
      stubFetch({
        "https://github.com/login/oauth/access_token": {
          access_token: "gho_1",
        },
      });
      const start = await cms.auth.oauth.authorize({
        provider: "github",
        redirectUri: "https://app.example.com/callback",
      });
      await expect(
        cms.auth.oauth.callback({
          provider: "github",
          code: "code-1",
          state: start.state,
          redirectUri: "https://evil.example.com/callback",
        }),
      ).rejects.toThrow(/redirect URI does not match/);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Housekeeping
    // -----------------------------------------------------------------------

    test("removing a user takes the sessions and keys with it", async () => {
      const { cms, events } = await setup();
      const user = await cms.auth.users.create({
        email: "a@example.com",
        password: "correct horse",
      });
      const session = (await cms.auth.password.signIn({
        email: "a@example.com",
        password: "correct horse",
      })) as SignedIn;
      const key = await cms.auth.apiKeys.create({
        name: "k",
        userId: user.id,
        scopes: ["read"],
      });

      await cms.auth.users.remove(user.id);

      // Explicit cleanup rather than a foreign key, because MongoDB has none.
      expect(await cms.auth.actorFromToken(session.token)).toBeNull();
      expect(await cms.auth.actorFromToken(key.key)).toBeNull();
      expect(await cms.auth.users.count()).toBe(0);

      await cms.drainEvents();
      expect(events.map((event) => event.type)).toContain("user.removed");
      await cms.close();
    });

    test("cleanup deletes what has expired and nothing else", async () => {
      const { cms } = await setup();
      await cms.auth.users.create({ email: "a@example.com", password: "correct horse" }); // prettier-ignore
      const live = (await cms.auth.password.signIn({
        email: "a@example.com",
        password: "correct horse",
      })) as SignedIn;

      await cms.auth.users.create({ email: "b@example.com", password: "correct horse" }); // prettier-ignore
      const stale = (await cms.auth.password.signIn({
        email: "b@example.com",
        password: "correct horse",
      })) as SignedIn;

      const adapter = await cms.database();
      await adapter.transaction((tx) =>
        adapter.mutate(tx, {
          kind: "update",
          table: "cms_sessions",
          where: eq("user_id", stale.user.id),
          set: { expires_at: new Date(Date.now() - 1000) },
          returning: false,
        }),
      );

      // An expired session stops working the moment it expires; cleanup is
      // about the row, not about the access.
      expect(await cms.auth.actorFromToken(stale.token)).toBeNull();
      expect(await cms.auth.sessions.cleanup()).toBe(1);
      expect(await cms.auth.actorFromToken(live.token)).not.toBeNull();
      expect(await cms.auth.sessions.list(live.user.id)).toHaveLength(1);
      await cms.close();
    });

    test("refuses a weak password and a malformed address", async () => {
      const { cms } = await setup();
      await expect(
        cms.auth.users.create({ email: "a@example.com", password: "short" }),
      ).rejects.toThrow(/at least 8 characters/);
      await expect(
        cms.auth.users.create({ email: "not-an-address" }),
      ).rejects.toThrow(/is not an email address/);

      await cms.auth.users.create({ email: "a@example.com" });
      await expect(
        cms.auth.users.create({ email: "A@EXAMPLE.COM" }),
      ).rejects.toThrow(/already exists/);
      await cms.close();
    });

    test("inspect prints what is actually enabled", async () => {
      const { cms } = await setup({ twoFactor: true, sso: true });
      const auth = cms.inspect().auth;

      expect(auth.methods).toEqual(["password", "magic-link", "github"]);
      expect(auth.twoFactor).toBe(true);
      expect(auth.apiKeys).toBe(true);
      expect(auth.sso).toBe("https://id.example.com");
      expect(auth.roles).toEqual(["admin", "editor", "viewer"]);
      await cms.close();
    });
  });
}

runAuthSuite({
  name: "sqlite",
  create: () => sqlite(new Database(":memory:")),
});

runAuthSuite({
  name: "postgres (pglite)",
  create: () => {
    const database = new PGlite();
    const client: PostgresClient = {
      async query(text, values) {
        const result = await database.query(text, values as unknown[]);
        return {
          rows: result.rows as never[],
          rowCount: result.affectedRows ?? result.rows.length,
        };
      },
      async end() {
        await database.close();
      },
    };
    return postgres(client);
  },
});

runAuthSuite({
  name: "mongodb (in-process)",
  create: () => mongodb(memoryMongo(), { transactions: false }),
});
