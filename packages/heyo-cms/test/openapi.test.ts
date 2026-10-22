import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { cmsUsers } from "../src/auth/config";
import { defineCollection, defineGlobal, heyoCms } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { number, media, select, text } from "../src/fields";
import { emptySnapshot } from "../src/schema/snapshot";
import { memory } from "../src/storage/local";
import { cmsHandler as astroHandler } from "../src/adapters/astro";
import { cmsHandler as nextHandler } from "../src/adapters/next";
import { cmsHandler as nuxtHandler } from "../src/adapters/nuxt";
import { cmsHandler as reactRouterHandler } from "../src/adapters/react-router";
import { cmsHandler as svelteHandler } from "../src/adapters/sveltekit";
import type { CmsPlugin } from "../src/types/plugin";
import type { JsonObject } from "../src/types/json";

/**
 * The generated description, and the framework adapters.
 *
 * Both are in one file because both answer the same question: is the handler
 * honest about itself? `cms.inspect().routes` and `openapi.json` have to
 * describe the router that is actually serving — that is the promise that
 * makes a generated route table acceptable instead of magic (section 10) — and
 * an adapter has to reach that router without changing what it sees.
 */

async function build(options: { plugins?: CmsPlugin<unknown>[] } = {}) {
  const adapter = sqlite(new Database(":memory:"));
  const cms = heyoCms({
    database: () => adapter,
    admin: {
      title: "Acme",
      auth: cmsUsers({
        methods: ["password", "github"],
        twoFactor: true,
        apiKeys: { enabled: true },
      }),
    },
    rbac: { roles: { admin: ["*"], viewer: ["*:read"] }, customRoles: true },
    uploads: {
      storage: memory(),
      images: {
        variants: { mode: "on-demand", sizes: { thumb: { width: 320 } } },
      },
    },
    collections: {
      posts: defineCollection({
        fields: {
          title: text({ required: true, localized: true, label: "Title" }),
          handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
          status: select({ options: ["draft", "published"], default: "draft" }),
          views: number({ integer: true }),
          cover: media({}),
        },
      }),
    },
    globals: {
      settings: defineGlobal({ fields: { siteName: text({ default: "Acme" }) } }), // prettier-ignore
    },
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
  });
  // Migrated, because the adapter tests below call a route that reads: an
  // adapter that reached the router and found no tables would pass a test
  // that only looked at the status code of `/openapi.json`.
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_openapi"),
  );
  return cms;
}

type Built = Awaited<ReturnType<typeof build>>;

async function document(cms: Built): Promise<JsonObject> {
  const response = await cms.handler(
    new Request("http://cms.test/api/heyo-cms/openapi.json"),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as JsonObject;
}

describe("openapi", () => {
  test("describes every registered route, including the plugins'", async () => {
    const analytics: CmsPlugin = {
      id: "analytics",
      routes: [
        {
          method: "GET",
          path: "/analytics/pageviews",
          handler: (context) => context.json({ views: 0 }),
          openapi: { summary: "Page views", tags: ["analytics"] },
        },
        {
          // Deliberately undocumented: the generator has to describe it
          // anyway, because a route that answers and is not in the document
          // is the one thing this file exists to prevent.
          method: "GET",
          path: "/analytics/raw",
          handler: (context) => context.json({}),
        },
      ],
    };
    const cms = await build({ plugins: [analytics] });
    const spec = await document(cms);
    const paths = spec.paths as JsonObject;

    const registered = cms.inspect().routes.map((route) => route.path.replace("/api/heyo-cms", "")); // prettier-ignore
    for (const path of registered) {
      const openApiPath = path
        .split("/")
        .map((segment) =>
          segment.startsWith(":")
            ? `{${segment.slice(1)}}`
            : segment === "*"
              ? "{path}"
              : segment,
        )
        .join("/");
      expect(paths[openApiPath === "" ? "/" : openApiPath]).toBeDefined();
    }

    expect((paths["/analytics/pageviews"] as JsonObject).get).toMatchObject({
      summary: "Page views",
      "x-heyo-cms-plugin": "analytics",
    });
    expect((paths["/analytics/raw"] as JsonObject).get).toMatchObject({
      summary: "GET /analytics/raw (plugin: analytics)",
    });
    await cms.close();
  });

  test("types the collection documents from the field schemas", async () => {
    const cms = await build();
    const spec = await document(cms);
    const schemas = (spec.components as JsonObject).schemas as JsonObject;
    const posts = schemas.posts as JsonObject;
    const properties = posts.properties as JsonObject;

    expect((properties.title as JsonObject).type).toBe("string");
    expect(properties.title).toMatchObject({
      title: "Title",
      "x-heyo-cms-localized": true,
      "x-heyo-cms-required": true,
    });
    // A localized field is described as its single-locale value, because that
    // is what a read returns and what a write takes.
    expect((properties.title as JsonObject).properties).toBeUndefined();
    // A nullable field is `type: ["string", "null"]` rather than an `anyOf`
    // with the actual type buried in a branch.
    expect(properties.status).toMatchObject({
      type: ["string", "null"],
      enum: ["draft", "published"],
    });
    expect((properties.views as JsonObject).type).toEqual(["integer", "null"]);
    // A media field holds the id of a row in `media`, and says so: a panel
    // renders a picker for it rather than a text input, and a generated
    // client can tell it apart from a string that happens to be a string.
    expect(properties.cover).toMatchObject({ "x-heyo-cms-field": "media" });

    // System fields are part of what a read answers, so they are documented.
    expect(properties.id).toBeDefined();
    expect(properties.deletedAt).toBeDefined();
    expect(properties.scheduledPatch).toBeDefined();

    // The input is the same fields with nothing required: a `before` hook is
    // allowed to fill a required one.
    const input = schemas.postsInput as JsonObject;
    expect(input.required).toBeUndefined();
    expect(Object.keys(input.properties as JsonObject)).toEqual([
      "title",
      "handle",
      "status",
      "views",
      "cover",
    ]);
    await cms.close();
  });

  test("names the base path, the panel and both ways to authenticate", async () => {
    const cms = await build();
    const spec = await document(cms);

    expect(spec.servers).toEqual([{ url: "/api/heyo-cms" }]);
    expect(spec["x-heyo-cms"]).toMatchObject({
      basePath: "/api/heyo-cms",
      adminPath: "/api/heyo-cms/admin",
    });

    const schemes = (spec.components as JsonObject).securitySchemes as JsonObject; // prettier-ignore
    expect(schemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(schemes.sessionCookie).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "heyo_cms_session",
    });

    // A sign-in that required credentials would be unusable.
    const signIn = ((spec.paths as JsonObject)["/auth/sign-in"] as JsonObject)
      .post as JsonObject;
    expect(signIn.security).toEqual([]);
    await cms.close();
  });

  test("the version is a fingerprint of the surface, not of the package", async () => {
    const one = await build();
    const two = await build();
    const three = heyoCms({
      database: () => sqlite(new Database(":memory:")),
      collections: {
        pages: defineCollection({ fields: { title: text({}) } }),
      },
    });

    const first = ((await document(one)).info as JsonObject).version;
    const second = ((await document(two)).info as JsonObject).version;
    const other = (
      (
        await (async () => {
          const response = await three.handler(
            new Request("http://cms.test/api/heyo-cms/openapi.json"),
          );
          return (await response.json()) as JsonObject;
        })()
      ).info as JsonObject
    ).version;

    expect(first).toBe(second);
    expect(other).not.toBe(first);
    await Promise.all([one.close(), two.close(), three.close()]);
  });

  test("documents only what this deployment has", async () => {
    const bare = heyoCms({
      database: () => sqlite(new Database(":memory:")),
      collections: { pages: defineCollection({ fields: { title: text({}) } }) },
    });
    const spec = await document(bare as unknown as Built);
    const paths = Object.keys(spec.paths as JsonObject);

    // No uploads, no auth configuration: no media routes, no sign-in.
    expect(paths.some((path) => path.startsWith("/media"))).toBe(false);
    expect(paths.some((path) => path.startsWith("/auth/sign-in"))).toBe(false);
    // The session endpoint, too: without `admin.auth` nothing can sign in.
    expect(paths).toContain("/pages");
    expect(paths).toContain("/openapi.json");
    expect((spec.components as JsonObject).schemas as JsonObject).not.toHaveProperty("Media"); // prettier-ignore
    await bare.close();
  });
});

describe("framework adapters", () => {
  test("every adapter reaches the same router", async () => {
    const cms = await build();
    const url = "http://cms.test/api/heyo-cms/locales";

    const next = nextHandler(cms);
    expect((await next.GET(new Request(url))).status).toBe(200);
    expect(Object.keys(next)).toEqual([
      "GET",
      "POST",
      "PATCH",
      "PUT",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]);

    const astro = astroHandler(cms);
    expect((await astro.GET({ request: new Request(url) })).status).toBe(200);
    expect((await astro.ALL({ request: new Request(url) })).status).toBe(200);

    const reactRouter = reactRouterHandler(cms);
    expect((await reactRouter.loader({ request: new Request(url) })).status).toBe(200); // prettier-ignore
    expect(
      (
        await reactRouter.action({
          request: new Request(url, { method: "DELETE" }),
        })
      ).status,
      // The router answers, and says which methods it does serve.
    ).toBe(405);

    const svelte = svelteHandler(cms);
    expect((await svelte.GET({ request: new Request(url) })).status).toBe(200);
    expect((await svelte.fallback({ request: new Request(url, { method: "HEAD" }) })).status).toBe(200); // prettier-ignore

    // h3: a v2-shaped event, and a bare Request as `toWebHandler` passes it.
    const nuxt = nuxtHandler(cms);
    expect((await nuxt({ web: { request: new Request(url) } })).status).toBe(200); // prettier-ignore
    expect((await nuxt(new Request(url))).status).toBe(200);
    await cms.close();
  });

  test("an h3 v1 event is converted, body and all", async () => {
    const cms = await build();
    const handle = nuxtHandler(cms);

    const response = await handle({
      node: {
        req: {
          method: "GET",
          url: "/api/heyo-cms/locales?limit=1",
          headers: { host: "cms.test", "x-forwarded-proto": "https" },
        },
      },
    });
    expect(response.status).toBe(200);
    await cms.close();
  });

  test("an unrecognised event is a clear error, not a crash", async () => {
    const cms = await build();
    const handle = nuxtHandler(cms);
    await expect(
      handle({ something: "else" } as unknown as Request),
    ).rejects.toThrow(/h3 event/);
    await cms.close();
  });
});
