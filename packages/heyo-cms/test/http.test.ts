import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { defineCollection, defineGlobal, heyoCms } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { CmsError } from "../src/errors";
import {
  boolean as booleanField,
  media,
  number,
  richText,
  select,
  text,
} from "../src/fields";
import { and, eq, gte, or, orderBy } from "../src/query";
import { emptySnapshot } from "../src/schema/snapshot";
import { memory } from "../src/storage/local";
import { permits } from "../src/access/permissions";
import { Router } from "../src/http/router";
import type { Actor } from "../src/types/actor";
import type { CmsPlugin } from "../src/types/plugin";
import type { CmsInstance } from "../src/types/instance";
import type { HeyoCmsConfig } from "../src/types/config";
import type { JsonObject } from "../src/types/json";
import { pngFixture } from "./images";

/**
 * Stage 7: the handler.
 *
 * The claim being settled here is the one from section 10: that `cms.handler`
 * is the whole HTTP surface, generated from the configuration, and that it is
 * the *same* operation as the local API rather than a second implementation of
 * it. So the suite is written against `fetch`-shaped requests and asserts the
 * things only the transport can get wrong — the base path, the status codes,
 * the 204 that means "a hook stopped it", the filter syntax, the cookie, the
 * conflict detection — and leaves what the engine already proves to the engine
 * suites.
 *
 * SQLite because the transport is engine-agnostic by construction: every
 * handler is three lines around a method the other suites run on Postgres,
 * SQLite and MongoDB. What differs per engine is below the line this file
 * tests, and `bun run example smoke` exercises this file's subject over a real
 * socket against a real Postgres.
 */

const collections = () => ({
  posts: defineCollection({
    fields: {
      title: text({ required: true, localized: true }),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
      status: select({
        options: ["draft", "published"],
        default: "draft",
        // The whole of "who may publish": who may write this field.
        access: { update: ({ actor }) => permits(actor, "posts:publish") },
      }),
      views: number({ integer: true }),
      secret: text({ access: { read: ({ actor }) => permits(actor, "posts:secrets") } }), // prettier-ignore
      cover: media({}),
      body: richText({ localized: true }),
    },
    access: {
      read: () => true,
      create: ({ actor }) => permits(actor, "posts:create"),
      update: ({ actor }) => permits(actor, "posts:update"),
      delete: ({ actor }) => permits(actor, "posts:delete"),
    },
  }),
});

const globals = () => ({
  settings: defineGlobal({
    fields: {
      siteName: text({ required: true, default: "Acme" }),
      maintenance: booleanField({ default: false }),
    },
  }),
});

type Fixture = ReturnType<typeof collections>;
type Globals = ReturnType<typeof globals>;

type Overrides = Partial<
  Omit<HeyoCmsConfig<Fixture, Globals>, "database" | "collections" | "globals">
>;

const editor: Actor = {
  id: "usr_editor",
  source: "session",
  roles: ["editor"],
  permissions: ["posts:create", "posts:update", "posts:publish", "posts:delete", "media:create", "media:update", "media:delete"], // prettier-ignore
};

const writer: Actor = {
  id: "usr_writer",
  source: "session",
  roles: ["writer"],
  permissions: ["posts:create", "posts:update"],
};

async function setup(overrides: Overrides = {}): Promise<{
  cms: CmsInstance<Fixture, Globals>;
  call: Caller;
}> {
  const adapter = sqlite(new Database(":memory:"));
  const cms = heyoCms({
    ...overrides,
    database: () => adapter,
    collections: collections(),
    globals: globals(),
  });
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_http"),
  );
  return { cms, call: caller(cms) };
}

interface CallOptions {
  method?: string;
  body?: unknown;
  actor?: Actor | null;
  headers?: Record<string, string>;
  raw?: BodyInit;
}

interface Called {
  status: number;
  headers: Headers;
  body: JsonObject;
  text: string;
}

type Caller = (path: string, options?: CallOptions) => Promise<Called>;

/**
 * A request, with the actor injected by an HTTP hook.
 *
 * Signing in on every assertion would make this a test of `cms.auth`, which
 * has its own suite. A `before` hook is also the documented way to do exactly
 * this in production — a proxy that authenticated upstream — so the mechanism
 * under test is a real one.
 */
function caller(cms: CmsInstance<Fixture, Globals>): Caller {
  return async (path, options = {}) => {
    const actor = options.actor;
    const headers = new Headers(options.headers);
    if (actor) headers.set("x-test-actor", JSON.stringify(actor));
    let body: BodyInit | undefined;
    if (options.raw !== undefined) {
      body = options.raw;
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set("content-type", "application/json");
    }

    const response = await cms.handler(
      new Request(`http://cms.test${path}`, {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        ...(body === undefined ? {} : { body }),
      }),
    );
    const raw = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text: raw,
      body: raw.length > 0 && raw.startsWith("{") ? (JSON.parse(raw) as JsonObject) : {}, // prettier-ignore
    };
  };
}

/**
 * The caller, resolved the way a deployment resolves it.
 *
 * `cms.auth.actorFromRequest` is the seam the handler uses, so replacing that
 * one method keeps every route under test on its real authentication path
 * without a sign-in per assertion — which would make this a second copy of
 * the auth suite. The sign-in route itself is exercised in `client.test.ts`,
 * end to end, against the real service.
 */
function withTestAuth(cms: CmsInstance<Fixture, Globals>): void {
  const auth = cms.auth as { actorFromRequest: (request: Request) => Promise<Actor | null> }; // prettier-ignore
  auth.actorFromRequest = async (request: Request) => {
    const raw = request.headers.get("x-test-actor");
    return raw ? (JSON.parse(raw) as Actor) : null;
  };
}

describe("router", () => {
  test("matches static segments before parameters", () => {
    const router = new Router();
    const hit: string[] = [];
    const record = (name: string) => ({
      source: "core" as const,
      handler: () => {
        hit.push(name);
        return new Response(null);
      },
    });

    router.add({ method: "GET", path: "/media/:id", ...record("by-id") });
    router.add({ method: "GET", path: "/media/upload", ...record("upload") });
    router.add({ method: "GET", path: "/admin/*", ...record("admin") });

    const upload = router.match("GET", "/media/upload");
    expect(upload.kind).toBe("found");
    expect(upload.kind === "found" && upload.route.path).toBe("/media/upload");

    const byId = router.match("GET", "/media/m_1");
    expect(byId.kind === "found" && byId.params.id).toBe("m_1");

    const deep = router.match("GET", "/admin/posts/doc_1");
    expect(deep.kind === "found" && deep.params["*"]).toBe("posts/doc_1");
  });

  test("answers 405 with the methods that do exist", () => {
    const router = new Router();
    router.add({
      method: "GET",
      path: "/posts",
      source: "core",
      handler: () => new Response(null),
    });
    router.add({
      method: "POST",
      path: "/posts",
      source: "core",
      handler: () => new Response(null),
    });

    const match = router.match("DELETE", "/posts");
    expect(match.kind).toBe("method-not-allowed");
    expect(match.kind === "method-not-allowed" && match.allowed).toEqual([
      "GET",
      "POST",
    ]);
  });

  test("refuses two routes that claim the same path, naming both", () => {
    const router = new Router();
    router.add({
      method: "GET",
      path: "/analytics/:id",
      source: "analytics",
      handler: () => new Response(null),
    });

    expect(() =>
      router.add({
        method: "GET",
        path: "/analytics/:other",
        source: "reports",
        handler: () => new Response(null),
      }),
    ).toThrow(/analytics/);
  });

  test("treats a trailing slash as the same route", () => {
    const router = new Router();
    router.add({
      method: "GET",
      path: "/posts",
      source: "core",
      handler: () => new Response(null),
    });
    expect(router.match("GET", "/posts/").kind).toBe("found");
  });
});

describe("handler", () => {
  let cms: CmsInstance<Fixture, Globals>;
  let call: Caller;

  beforeEach(async () => {
    const built = await setup();
    cms = built.cms;
    call = built.call;
    withTestAuth(cms);
  });

  test("serves only under the base path, and says so otherwise", async () => {
    const outside = await call("/posts");
    expect(outside.status).toBe(404);
    expect(outside.body).toMatchObject({
      error: { code: "outside_base_path" },
    });

    const inside = await call("/api/heyo-cms/posts");
    expect(inside.status).toBe(200);

    // A path that merely starts with the same characters is not ours.
    const neighbour = await call("/api/heyo-cms-staging/posts");
    expect(neighbour.status).toBe(404);
    expect(neighbour.body).toMatchObject({ error: { code: "outside_base_path" } }); // prettier-ignore
  });

  test("the generated route list is printable and includes plugins", async () => {
    const analytics: CmsPlugin = {
      id: "analytics",
      routes: [
        {
          method: "GET",
          path: "/analytics/pageviews",
          handler: (context) => context.json({ views: 1, actor: context.actor?.id ?? null }), // prettier-ignore
        },
      ],
    };
    const built = await setup({ plugins: [analytics] });
    const routes = built.cms.inspect().routes;

    expect(routes.some((route) => route.path === "/api/heyo-cms/posts" && route.method === "GET")).toBe(true); // prettier-ignore
    expect(routes.some((route) => route.path === "/api/heyo-cms/globals/settings")).toBe(true); // prettier-ignore
    expect(
      routes.find((route) => route.path === "/api/heyo-cms/analytics/pageviews")
        ?.source,
    ).toBe("analytics");

    const answered = await built.call("/api/heyo-cms/analytics/pageviews");
    expect(answered.status).toBe(200);
    expect(answered.body.views).toBe(1);
  });

  test("a document round-trips through the same path as the local API", async () => {
    const created = await call("/api/heyo-cms/posts", {
      body: { data: { title: "Hello", handle: "hello", views: 2 } },
      actor: editor,
    });
    expect(created.status).toBe(201);
    const id = String(created.body.id);
    expect(created.body.status).toBe("draft");

    const read = await call(`/api/heyo-cms/posts/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.title).toBe("Hello");

    const patched = await call(`/api/heyo-cms/posts/${id}`, {
      method: "PATCH",
      body: { data: { status: "published" } },
      actor: editor,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("published");

    // The engine saw the same write: the local API reads it back unchanged.
    const local = await cms.api.posts.findById(id);
    expect(local?.status).toBe("published");
  });

  test("rich text can be asked for as HTML, Markdown or text", async () => {
    const created = await call("/api/heyo-cms/posts", {
      body: {
        data: {
          title: "Rendered",
          handle: "rendered",
          body: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Hello " },
                  { type: "text", text: "world", marks: [{ type: "bold" }] },
                ],
              },
            ],
          },
        },
      },
      actor: editor,
    });
    const id = String(created.body.id);

    // The default is the stored document, because a client that writes back
    // what it read must get back what is stored.
    const stored = await call(`/api/heyo-cms/posts/${id}`);
    expect((stored.body.body as JsonObject).type).toBe("doc");

    const html = await call(`/api/heyo-cms/posts/${id}?richText=html`);
    expect(html.body.body).toBe("<p>Hello <strong>world</strong></p>");

    const markdown = await call(`/api/heyo-cms/posts/${id}?richText=markdown`);
    expect(markdown.body.body).toBe("Hello **world**");

    const listed = await call("/api/heyo-cms/posts?richText=text");
    const docs = listed.body.docs as JsonObject[];
    expect(docs.some((document) => document.body === "Hello world")).toBe(true);

    const wrong = await call(`/api/heyo-cms/posts/${id}?richText=pdf`);
    expect(wrong.status).toBe(422);
  });

  test("filters with both syntaxes, and sorts", async () => {
    const statuses = ["draft", "published", "published"] as const;
    for (const [index, status] of statuses.entries()) {
      await cms.api.posts.create({
        data: { title: `Post ${index}`, handle: `post-${index}`, status, views: index }, // prettier-ignore
        actor: editor,
      });
    }

    const shorthand = await call(
      "/api/heyo-cms/posts?status=published&views[gte]=2&count=true",
    );
    expect(shorthand.status).toBe(200);
    expect((shorthand.body.docs as JsonObject[]).length).toBe(1);
    expect(shorthand.body.totalDocs).toBe(1);

    // The AST the client sends, composed with the same helpers an access rule
    // uses.
    const composed = encodeURIComponent(
      JSON.stringify(
        and(eq("status", "published"), or(gte("views", 2), eq("views", 1))),
      ),
    );
    const ast = await call(`/api/heyo-cms/posts?where=${composed}&sort=-views`);
    expect((ast.body.docs as JsonObject[]).map((doc) => doc.views)).toEqual([2, 1]); // prettier-ignore

    // And the local API agrees, which is the point of one query language.
    const localPage = await cms.api.posts.find({
      where: and(
        eq("status", "published"),
        or(gte("views", 2), eq("views", 1)),
      ),
      orderBy: [orderBy("views", "desc")],
    });
    expect(localPage.docs.map((doc) => doc.views)).toEqual([2, 1]);
  });

  test("refuses a filter on something that is not a field", async () => {
    const answered = await call("/api/heyo-cms/posts?password=secret");
    expect(answered.status).toBe(422);
    expect(answered.body).toMatchObject({ error: { code: "validation_failed" } }); // prettier-ignore
  });

  test("resolves one locale per read, and filters inside it", async () => {
    const created = await cms.api.posts.create({
      data: { title: "English", handle: "en" },
      actor: editor,
      locale: "en",
    });
    const id = String(created?.id);
    await cms.api.posts.update({
      id,
      data: { title: "Deutsch" },
      actor: editor,
      locale: "de",
    });

    const german = await call(`/api/heyo-cms/posts/${id}?locale=de`);
    expect(german.body.title).toBe("Deutsch");

    const filtered = await call("/api/heyo-cms/posts?locale=de&title=Deutsch");
    expect((filtered.body.docs as JsonObject[]).length).toBe(1);

    // A language nobody has translated into falls back to the default one,
    // and says which fields it had to answer that way.
    const untranslated = await call(`/api/heyo-cms/posts/${id}?locale=fr`);
    expect(untranslated.body.title).toBe("English");
    expect(untranslated.body._fallback).toEqual({ title: "en" });

    // Which a panel filling in translations turns off for its own reads.
    const gaps = await call(
      `/api/heyo-cms/posts/${id}?locale=fr&fallbackLocale=false`,
    );
    expect(gaps.body.title).toBeNull();
  });

  test("a stopped write answers 204 rather than inventing a body", async () => {
    const built = await setup({
      databaseHooks: {
        posts: { create: { before: () => false } },
      },
    });
    withTestAuth(built.cms);

    const created = await built.call("/api/heyo-cms/posts", {
      body: { data: { title: "Never", handle: "never" } },
      actor: editor,
    });
    expect(created.status).toBe(204);
    expect(created.headers.get("x-heyo-cms-stopped")).toBe("before-hook");
    expect(created.text).toBe("");
  });

  test("access control answers 403, and a field rule hides a field", async () => {
    const created = await call("/api/heyo-cms/posts", {
      body: { data: { title: "Draft", handle: "draft", secret: "shh" } },
      actor: editor,
    });
    const id = String(created.body.id);

    const refused = await call(`/api/heyo-cms/posts/${id}`, {
      method: "PATCH",
      body: { data: { status: "published" } },
      actor: writer,
    });
    expect(refused.status).toBe(403);

    const anonymous = await call(`/api/heyo-cms/posts/${id}`);
    expect("secret" in anonymous.body).toBe(false);

    const privileged = await call(`/api/heyo-cms/posts/${id}`, {
      actor: { ...editor, permissions: [...editor.permissions, "posts:secrets"] }, // prettier-ignore
    });
    expect(privileged.body.secret).toBe("shh");
  });

  test("the trash, restore and purge are three different verbs", async () => {
    const created = await call("/api/heyo-cms/posts", {
      body: { data: { title: "Temporary", handle: "temp" } },
      actor: editor,
    });
    const id = String(created.body.id);

    const trashed = await call(`/api/heyo-cms/posts/${id}`, {
      method: "DELETE",
      actor: editor,
    });
    expect(trashed.status).toBe(200);
    expect(trashed.body.deletedAt).not.toBeNull();
    expect((await call(`/api/heyo-cms/posts/${id}`)).status).toBe(404);

    const bin = await call("/api/heyo-cms/trash", { actor: editor });
    expect((bin.body.entries as JsonObject[]).some((entry) => entry.id === id)).toBe(true); // prettier-ignore

    const restored = await call(`/api/heyo-cms/trash/posts/${id}/restore`, {
      method: "POST",
      actor: editor,
    });
    expect(restored.status).toBe(200);
    expect((await call(`/api/heyo-cms/posts/${id}`)).status).toBe(200);

    const purged = await call(`/api/heyo-cms/posts/${id}?permanent=true`, {
      method: "DELETE",
      actor: editor,
    });
    expect(purged.status).toBe(200);
    expect(await cms.api.posts.findById(id, { includeTrashed: true })).toBeNull(); // prettier-ignore
  });

  test("schedules a change and cancels it", async () => {
    const created = await call("/api/heyo-cms/posts", {
      body: { data: { title: "Later", handle: "later" } },
      actor: editor,
    });
    const id = String(created.body.id);

    const scheduled = await call(`/api/heyo-cms/posts/${id}/schedule`, {
      body: { at: "2099-01-01T09:00:00.000Z", data: { status: "published" } },
      actor: editor,
    });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.scheduledAt).toBe("2099-01-01T09:00:00.000Z");

    const cancelled = await call(`/api/heyo-cms/posts/${id}/schedule`, {
      method: "DELETE",
      actor: editor,
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.scheduledAt).toBeNull();

    const again = await call(`/api/heyo-cms/posts/${id}/schedule`, {
      method: "DELETE",
      actor: editor,
    });
    expect(again.status).toBe(409);
  });

  test("a global reads as its defaults before it is ever saved", async () => {
    const before = await call("/api/heyo-cms/globals/settings");
    expect(before.status).toBe(200);
    expect(before.body.siteName).toBe("Acme");
    expect(before.body.createdAt).toBeNull();

    const saved = await call("/api/heyo-cms/globals/settings", {
      method: "PATCH",
      body: { data: { maintenance: true } },
      actor: editor,
    });
    expect(saved.body.maintenance).toBe(true);
  });

  test("405 carries an Allow header, 404 names the route", async () => {
    const wrongMethod = await call("/api/heyo-cms/posts/doc_1", {
      method: "PUT",
      body: { data: {} },
      actor: editor,
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toContain("PATCH");

    const missing = await call("/api/heyo-cms/nothing-here");
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "not_found" } });
  });

  test("HEAD answers the GET headers with no body", async () => {
    const head = await call("/api/heyo-cms/posts", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(head.headers.get("content-type")).toContain("application/json");
  });

  test("a malformed body is a 400, not a 500", async () => {
    const answered = await call("/api/heyo-cms/posts", {
      method: "POST",
      raw: "{not json",
      headers: { "content-type": "application/json" },
      actor: editor,
    });
    expect(answered.status).toBe(400);
    expect(answered.body).toMatchObject({ error: { code: "invalid_body" } });
  });

  test("an unexpected error does not leak its message", async () => {
    const built = await setup({
      databaseHooks: {
        posts: {
          create: {
            before: () => {
              throw new Error(
                "postgres://user:password@host/db is unreachable",
              );
            },
          },
        },
      },
    });
    withTestAuth(built.cms);

    const answered = await built.call("/api/heyo-cms/posts", {
      body: { data: { title: "Boom", handle: "boom" } },
      actor: editor,
    });
    expect(answered.status).toBe(500);
    expect(answered.text).not.toContain("password");
    expect(answered.body).toMatchObject({ error: { code: "internal_error" } });

    // A `CmsError`, by contrast, is the engine speaking to the caller and
    // keeps its message and its status.
    const built2 = await setup({
      databaseHooks: {
        posts: {
          create: {
            before: () => {
              throw new CmsError("Only on Tuesdays.", { status: 409, code: "tuesdays" }); // prettier-ignore
            },
          },
        },
      },
    });
    withTestAuth(built2.cms);
    const refused = await built2.call("/api/heyo-cms/posts", {
      body: { data: { title: "x", handle: "x" } },
      actor: editor,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: { code: "tuesdays", message: "Only on Tuesdays." },
    });
  });

  test("HTTP hooks run before and after, and may answer instead", async () => {
    const seen: string[] = [];
    const built = await setup({
      hooks: {
        before: [
          {
            matcher: (context) => context.path.startsWith("/posts"),
            handler: (context) => {
              seen.push(`before ${context.method} ${context.path}`);
              context.meta.rate = "checked";
              if (context.request.headers.get("x-too-many") === "yes") {
                return new Response("slow down", { status: 429 });
              }
            },
          },
        ],
        after: [
          {
            matcher: (context) => context.status === 200,
            handler: (context) => {
              context.headers.set("x-cms-cache", "miss");
              seen.push(`after ${String(context.meta.rate)}`);
            },
          },
        ],
      },
    });
    withTestAuth(built.cms);

    const ok = await built.call("/api/heyo-cms/posts");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-cms-cache")).toBe("miss");
    expect(seen).toEqual(["before GET /posts", "after checked"]);

    const limited = await built.call("/api/heyo-cms/posts", {
      headers: { "x-too-many": "yes" },
    });
    expect(limited.status).toBe(429);
  });

  test("the activity trail records what the route did", async () => {
    await call("/api/heyo-cms/posts", {
      body: { data: { title: "Audited", handle: "audited" } },
      actor: editor,
    });

    const trail = await call("/api/heyo-cms/activity", { actor: editor });
    expect(trail.status).toBe(200);
    const entries = trail.body.entries as JsonObject[];
    expect(entries[0]).toMatchObject({
      action: "document.created",
      collection: "posts",
      actorId: "usr_editor",
    });

    // Anonymous callers do not read the audit trail.
    expect((await call("/api/heyo-cms/activity")).status).toBe(401);
  });

  test("locales are the configured list, anonymous and named", async () => {
    const listed = await call("/api/heyo-cms/locales");
    expect(listed.status).toBe(200);
    expect(listed.body.defaultLocale).toBe("en");
    expect((listed.body.locales as JsonObject[])[0]).toMatchObject({
      code: "en",
      // The code is what a deployment configures; the name is looked up, so a
      // language switcher never has to render "en".
      name: "English",
      isDefault: true,
    });
  });

  test("languages are configuration, so nothing can write to them", async () => {
    const built = await setup({
      i18n: { locales: ["en", "de"], defaultLocale: "en" },
    });
    withTestAuth(built.cms);

    const listed = await built.call("/api/heyo-cms/locales");
    expect((listed.body.locales as JsonObject[]).map((locale) => locale.code)).toEqual(["en", "de"]); // prettier-ignore
    expect((listed.body.locales as JsonObject[])[1]).toMatchObject({ name: "German" }); // prettier-ignore
    // The write routes do not exist, rather than existing and refusing.
    expect(
      built.cms
        .inspect()
        .routes.some((route) => route.path.endsWith("/locales") && route.method !== "GET"), // prettier-ignore
    ).toBe(false);
  });

  test("the panel answers under admin.path even without a bundle", async () => {
    const shell = await call("/api/heyo-cms/admin");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
    expect(shell.text).toContain("openapi.json");

    const deep = await call("/api/heyo-cms/admin/posts/doc_1");
    expect(deep.status).toBe(200);
  });

  test("a configured bundle is served, with the SPA fallback", async () => {
    const built = await setup({
      admin: {
        assets: {
          id: "test-bundle",
          asset: async (path) => {
            if (path === "") {
              return { body: "<html>panel</html>", contentType: "text/html" };
            }
            if (path === "assets/app-0123abcd.js") {
              return { body: "console.log(1)", contentType: "text/javascript" };
            }
            return null;
          },
        },
      },
    });
    withTestAuth(built.cms);

    expect((await built.call("/api/heyo-cms/admin")).text).toBe("<html>panel</html>"); // prettier-ignore
    // A deep link is a panel route, so it gets the shell.
    expect((await built.call("/api/heyo-cms/admin/posts/doc_1")).text).toBe("<html>panel</html>"); // prettier-ignore

    const asset = await built.call("/api/heyo-cms/admin/assets/app-0123abcd.js"); // prettier-ignore
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    // A missing file stays missing: serving HTML for a script is how a panel
    // breaks with a syntax error instead of a 404.
    expect((await built.call("/api/heyo-cms/admin/assets/missing.js")).status).toBe(404); // prettier-ignore
    expect(built.cms.inspect().admin.panel).toBe("test-bundle");
  });
});

describe("media over HTTP", () => {
  const uploads = () => ({
    storage: memory(),
    limits: { maxFileSize: "1mb" as const, accept: ["image/*"] },
    images: {
      variants: { mode: "on-demand" as const, sizes: { thumb: { width: 64 } } },
    },
  });

  test("uploads, serves, lists and refuses what it should", async () => {
    const built = await setup({ uploads: uploads() });
    withTestAuth(built.cms);
    const call = built.call;

    const form = new FormData();
    // The DOM typings model `BlobPart` more narrowly than any runtime this
    // has to work on; the bytes are the same bytes.
    const png = pngFixture(120, 80) as BlobPart;
    form.set("file", new Blob([png], { type: "image/png" }), "logo.png");
    form.set("alt", "The logo");

    const uploaded = await call("/api/heyo-cms/media/upload", {
      method: "POST",
      raw: form,
      actor: editor,
    });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.width).toBe(120);
    const id = String(uploaded.body.id);

    const listed = await call("/api/heyo-cms/media");
    expect((listed.body.docs as JsonObject[]).length).toBe(1);

    const bytes = await built.cms.handler(
      new Request(`http://cms.test/api/heyo-cms/media/${id}/original`),
    );
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/png");
    const etag = bytes.headers.get("etag") ?? "";
    expect(etag.length).toBeGreaterThan(2);
    await bytes.arrayBuffer();

    const cached = await built.cms.handler(
      new Request(`http://cms.test/api/heyo-cms/media/${id}/original`, {
        headers: { "if-none-match": etag },
      }),
    );
    expect(cached.status).toBe(304);

    // A size nothing declared is not a resource, and the error names the
    // ones that exist rather than saying "bad request".
    const unknown = await call(`/api/heyo-cms/media/${id}/gigantic`);
    expect(unknown.status).toBe(404);
    expect(String((unknown.body.error as JsonObject).message)).toContain("thumb"); // prettier-ignore

    // `usages` is a static sub-route, so it is reached rather than read as a
    // variant name.
    const usages = await call(`/api/heyo-cms/media/${id}/usages`);
    expect(usages.status).toBe(200);
    expect(usages.body.usages).toEqual([]);

    // Anonymous reads are allowed; anonymous writes are not.
    expect((await call("/api/heyo-cms/media/upload", { method: "POST", raw: form })).status).toBe(401); // prettier-ignore
  });

  test("a size name that collides with a media endpoint is refused", async () => {
    await expect(
      setup({
        uploads: {
          storage: memory(),
          images: {
            variants: { mode: "on-demand", sizes: { usages: { width: 64 } } },
          },
        },
      }),
    ).rejects.toThrow(/media endpoint/);
  });

  test("without uploads the media routes do not exist", async () => {
    const built = await setup();
    const routes = built.cms.inspect().routes;
    expect(routes.some((route) => route.path.includes("/media"))).toBe(false);
    expect(built.cms.inspect().storage).toBeNull();
  });
});

describe("configuration the router constrains", () => {
  test("a collection cannot take a URL the CMS serves itself", async () => {
    const database = () => sqlite(new Database(":memory:"));
    expect(() =>
      heyoCms({
        database,
        collections: {
          users: defineCollection({ fields: { name: text({}) } }),
        },
      }),
    ).toThrow(/serves itself/);

    // The failure is at configuration time, not on the first request that
    // happens to reach the router.
    expect(() =>
      heyoCms({
        database,
        collections: {
          team: defineCollection({ slug: "auth", fields: { name: text({}) } }),
        },
      }),
    ).toThrow(/serves itself/);
  });

  test("the panel can be mounted at the base path itself", async () => {
    const built = await setup({ admin: { path: "/" } });
    withTestAuth(built.cms);

    const shell = await built.call("/api/heyo-cms");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");

    // Every concrete route still wins over the panel's wildcard.
    expect((await built.call("/api/heyo-cms/posts")).status).toBe(200);
    expect(built.cms.inspect().admin.path).toBe("/api/heyo-cms");
  });

  test("an unusable panel path is refused while the module loads", () => {
    expect(() =>
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        admin: { path: "admin" },
        collections: {
          posts: defineCollection({ fields: { title: text({}) } }),
        },
      }),
    ).toThrow(/must start with/);
  });
});
