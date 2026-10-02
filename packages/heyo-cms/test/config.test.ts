import { describe, expect, test } from "bun:test";

import { cmsUsers, oidc } from "../src/auth";
import { defineCollection, defineGlobal, heyoCms } from "../src/config";
import { CmsConfigError } from "../src/errors";
import { media, relation, richText, select, slug, text } from "../src/fields";
import type { DatabaseAdapter } from "../src/types/database";

const database = { id: "fixture" } as unknown as DatabaseAdapter;

const posts = () =>
  defineCollection({
    fields: {
      title: text({ required: true, localized: true }),
      handle: slug({}),
      status: select({
        options: ["draft", "review", "published"],
        default: "draft",
      }),
      body: richText({ localized: true }),
      cover: media({ accept: "image/*" }),
      author: relation("cms_users"),
    },
  });

describe("heyoCms", () => {
  test("fills in the defaults the plan specifies", () => {
    const cms = heyoCms({ database, collections: { posts: posts() } });

    expect(cms._config.basePath).toBe("/api/heyo-cms");
    expect(cms._config.admin.path).toBe("/admin");
    expect(cms._config.trash).toEqual({ enabled: true, purgeAfter: "30d" });
    expect(cms._config.i18n.defaultLocale).toBe("en");
    // Locales live in a table so a new language is not a migration.
    expect(cms._config.i18n.locales).toBe("dynamic");
  });

  test("derives a URL-safe slug from the collection name", () => {
    const cms = heyoCms({
      database,
      collections: { blog_posts: posts() },
    });
    expect(cms._config.collections.blog_posts?.slug).toBe("blog-posts");
  });

  test("builds a schema with the system tables and the content indexes", () => {
    const cms = heyoCms({ database, collections: { posts: posts() } });
    const tables = cms.schema.tables.map((table) => table.name);

    expect(tables).toContain("documents");
    expect(tables).toContain("media_usages");
    expect(tables).toContain("outbox");
    expect(tables).toContain("jobs");

    const documents = cms.schema.tables.find(
      (table) => table.name === "documents",
    );
    const handle = documents?.indexes.find(
      (index) => index.name === "uniq_documents_posts_handle",
    );
    expect(handle?.unique).toBe(true);
    // Collections share one table, so every content index is partial.
    expect(handle?.where).toEqual({ column: "collection", equals: "posts" });
  });

  test("keeps localized fields out of the index list", () => {
    const cms = heyoCms({
      database,
      collections: {
        posts: defineCollection({
          fields: { title: text({ localized: true, index: true }) },
        }),
      },
    });
    const documents = cms.schema.tables.find(
      (table) => table.name === "documents",
    );
    expect(
      documents?.indexes.some((index) => index.name.includes("posts_title")),
    ).toBe(false);
  });

  test("refuses a collection that collides with a system table", () => {
    expect(() =>
      heyoCms({ database, collections: { media: posts() } }),
    ).toThrow(CmsConfigError);
  });

  test("refuses two collections with the same slug", () => {
    expect(() =>
      heyoCms({
        database,
        collections: {
          posts: posts(),
          articles: defineCollection({
            slug: "posts",
            fields: { title: text({}) },
          }),
        },
      }),
    ).toThrow(/already used/);
  });

  test("refuses a relation to a collection that does not exist", () => {
    expect(() =>
      heyoCms({
        database,
        collections: {
          posts: defineCollection({
            fields: { author: relation("writers") },
          }),
        },
      }),
    ).toThrow(/not a collection/);
  });

  test("refuses a hook on a collection that does not exist", () => {
    expect(() =>
      heyoCms({
        database,
        collections: { posts: posts() },
        databaseHooks: {
          // A typo here would otherwise be a hook that simply never runs.
          postz: { create: { before: async () => undefined } },
        } as never,
      }),
    ).toThrow(/no collection or global/);
  });

  test("refuses chat context that names a field the collection lacks", () => {
    expect(() =>
      heyoCms({
        database,
        collections: {
          posts: defineCollection({
            fields: { title: text({}) },
            ai: { chat: { context: ["title", "body"] } },
          }),
        },
      }),
    ).toThrow(/not a field/);
  });

  test("refuses a chat that may write a field it cannot read", () => {
    expect(() =>
      heyoCms({
        database,
        collections: {
          posts: defineCollection({
            fields: { title: text({}), body: richText({}) },
            ai: { chat: { context: ["title"], writable: ["body"] } },
          }),
        },
      }),
    ).toThrow(/cannot write a field it cannot read/);
  });

  test("refuses an AI model whose provider has no credentials", () => {
    expect(() =>
      heyoCms({
        database,
        collections: { posts: posts() },
        ai: {
          auth: { openai: { type: "api-key", token: "sk-test" } },
          defaultModel: { provider: "anthropic", model: "claude-sonnet-4" },
        },
      }),
    ).toThrow(/has no entry in ai.auth/);
  });

  test("refuses webhooks without a signing secret", () => {
    expect(() =>
      heyoCms({
        database,
        collections: { posts: posts() },
        webhooks: { enabled: true },
      }),
    ).toThrow(/must be signed/);
  });

  test("refuses a malformed permission", () => {
    expect(() =>
      heyoCms({
        database,
        collections: { posts: posts() },
        rbac: { roles: { editor: ["posts"] } },
      }),
    ).toThrow(/is not a permission/);
  });

  test("refuses a base path that is not a plain absolute path", () => {
    for (const basePath of ["api/cms", "/api/cms?x=1", "/api//cms", "/"]) {
      expect(() =>
        heyoCms({ database, basePath, collections: { posts: posts() } }),
      ).toThrow(CmsConfigError);
    }
  });

  test("accepts globals on the same machinery as collections", () => {
    const cms = heyoCms({
      database,
      collections: { posts: posts() },
      globals: {
        settings: defineGlobal({
          fields: { title: text({ required: true }) },
        }),
      },
    });
    expect(cms._config.globals.settings?.kind).toBe("global");
    expect(
      cms.schema.collections.find((entry) => entry.name === "settings")?.kind,
    ).toBe("global");
  });

  test("validates editor auth options eagerly", () => {
    expect(() => cmsUsers({ methods: [] })).toThrow(/at least one sign-in/);
    expect(
      () =>
      cmsUsers({ methods: ["password"], session: { expiresIn: "7 days" as never } }), // prettier-ignore
    ).toThrow(/is not a duration/);
    expect(() => oidc({ issuer: "acme.example" })).toThrow(/issuer URL/);
    expect(cmsUsers({ methods: ["password"] }).kind).toBe("cms-users");
  });
});

describe("cms.inspect()", () => {
  test("prints the hook pipeline in the order it will run", () => {
    const cms = heyoCms({
      database,
      collections: { posts: posts() },
      plugins: [
        {
          id: "analytics",
          hooks: [
            {
              collection: "posts",
              operation: "create",
              timing: "after",
              priority: 10,
              handler: async () => undefined,
            },
          ],
        },
        {
          id: "search",
          hooks: [
            {
              collection: "posts",
              operation: "create",
              timing: "after",
              priority: 5,
              handler: async () => undefined,
            },
          ],
        },
      ],
      databaseHooks: {
        posts: { create: { after: async () => undefined } },
      },
    });

    const pipeline = cms.inspect().hooks;
    // Plugins by priority, the configuration last: a developer always has the
    // final word over a plugin they installed.
    expect(pipeline.map((entry) => entry.source)).toEqual([
      "search",
      "analytics",
      "config",
    ]);
  });

  test("reports collections, plugins and the base path", () => {
    const cms = heyoCms({
      database,
      basePath: "/cms",
      collections: { posts: posts() },
    });
    const inspection = cms.inspect();

    expect(inspection.basePath).toBe("/cms");
    expect(inspection.collections[0]?.name).toBe("posts");
    expect(
      inspection.collections[0]?.fields.find((field) => field.name === "title"),
    ).toEqual({
      name: "title",
      type: "text",
      localized: true,
      required: true,
    });
    // Routes arrive with the router in stage 7; an empty list is the honest
    // answer until then.
    expect(inspection.routes).toEqual([]);
  });

  test("refuses two plugins that register the same route", () => {
    const route = {
      method: "GET" as const,
      path: "/analytics",
      handler: async () => new Response("ok"),
    };
    expect(() =>
      heyoCms({
        database,
        collections: { posts: posts() },
        plugins: [
          { id: "a", routes: [route] },
          { id: "b", routes: [route] },
        ],
      }),
    ).toThrow(/already registered/);
  });
});
