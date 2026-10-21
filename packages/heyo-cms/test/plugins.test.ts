import { Database } from "bun:sqlite";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineAiAction } from "../src/ai/index";
import { defineCollection, heyoCms, systemActor } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { defineEditorNode, richTextToHtml } from "../src/editor/index";
import { defineField, richText, text } from "../src/fields";
import { cmsScheduled, startJobRunner } from "../src/jobs/runner";
import { generateMigration, MigrationStore } from "../src/migrations";
import { eq } from "../src/query";
import { emptySnapshot } from "../src/schema/snapshot";
import type { AiCompletionRequest } from "../src/types/ai";
import type { CmsPlugin } from "../src/types/plugin";
import type { JsonObject } from "../src/types/json";

/**
 * Stage 9, the acceptance test: "an external plugin that adds a collection,
 * a field, an editor node, a route and a migration works without changes to
 * the core."
 *
 * So this file writes that plugin. It uses nothing but the published
 * entry points — `defineField`, `defineEditorNode`, `defineAiAction`, the
 * `CmsPlugin` contract — and then asserts that the CMS treats what it
 * brought exactly like the configuration's own: routes in the router,
 * documents in `cms.api`, columns in the schema, hooks in the printed
 * pipeline, and a migration file on disk.
 */

// --- The plugin's field type ------------------------------------------------

interface RatingOptions {
  max?: number;
  label?: string;
  required?: boolean;
  localized?: boolean;
  ai?: Record<string, { prompt?: string } | true>;
}

/**
 * `stars`, not `rating`: the field registry is module-level, so a name is
 * claimed for the whole process. That is the behaviour under test in
 * `fields.test.ts`, and two suites quietly claiming one name would make
 * whichever ran second fail for a reason that has nothing to do with it.
 */
const rating = defineField<number, RatingOptions>({
  name: "stars",
  optionsSchema: z.looseObject({
    max: z.number().int().positive().optional(),
  }) as unknown as z.ZodType<RatingOptions>,
  schema: (options) =>
    z
      .number()
      .int()
      .min(1)
      .max(options.max ?? 5),
  column: () => ({ type: "integer", index: true }),
  aiActions: ["guess-rating"],
});

// --- The plugin's editor node ----------------------------------------------

defineEditorNode({
  name: "pullQuote",
  group: "block",
  content: "inline*",
  attrs: { attribution: { default: null } },
  toHtml: ({ node, children }) =>
    `<figure class="pull-quote"><blockquote>${children}</blockquote>${
      node.attrs?.attribution
        ? `<figcaption>${String(node.attrs.attribution)}</figcaption>`
        : ""
    }</figure>`,
  toMarkdown: ({ node, children }) =>
    `> ${children}${node.attrs?.attribution ? `\n> — ${String(node.attrs.attribution)}` : ""}`, // prettier-ignore
});

// --- The plugin's AI action -------------------------------------------------

defineAiAction({
  id: "guess-rating",
  appliesTo: ["stars"],
  label: "Guess a rating",
  prompt: "Rate the document from 1 to 5.",
  run: async (context) => {
    const result = await context.complete({
      system: "Answer with a single digit.",
      prompt: `${context.options.prompt ?? "Rate it."}\n${JSON.stringify(context.context)}`, // prettier-ignore
    });
    const value = Number(result.text.trim());
    return {
      value: Number.isFinite(value) ? value : null,
      preview: result.text.trim(),
      usage: result.usage,
    };
  },
});

// --- The plugin -------------------------------------------------------------

interface ReviewsExtension {
  summary: () => Promise<unknown>;
}

const reviewsPlugin: CmsPlugin<ReviewsExtension> = {
  id: "reviews",

  schema: {
    // A whole collection, with a field type the core has never heard of.
    collections: {
      reviews: defineCollection({
        fields: {
          body: richText({}),
          score: rating({ max: 5, ai: { "guess-rating": true } }),
        },
      }),
    },
    // And a table of its own, for something that is not a document.
    tables: [
      {
        name: "review_votes",
        primaryKey: ["id"],
        columns: [
          { name: "id", type: "text", nullable: false, storage: "column" },
          { name: "review_id", type: "text", nullable: false, storage: "column" }, // prettier-ignore
          { name: "score", type: "integer", nullable: false, storage: "column" }, // prettier-ignore
        ],
        indexes: [
          {
            name: "idx_review_votes_review_id",
            table: "review_votes",
            targets: [{ kind: "column", column: "review_id" }],
            unique: false,
          },
        ],
      },
    ],
  },

  migrations: [
    {
      id: "seed_votes_index",
      steps: [
        {
          kind: "create_index",
          index: {
            name: "idx_review_votes_score",
            table: "review_votes",
            targets: [{ kind: "column", column: "score" }],
            unique: false,
          },
        },
      ],
    },
  ],

  // A field and a hook on a collection the application owns.
  extendCollections: () => [
    {
      collection: "posts",
      fields: { editorsPick: rating({ max: 3 }) },
      hooks: {
        create: {
          before: (input) => ({
            data: { ...input.data, title: `${String(input.data.title)} ★` },
          }),
        },
      },
    },
  ],

  routes: [
    {
      method: "GET",
      path: "/reviews/top",
      handler: async (context) => {
        const rows = await context.db.find("documents", eq("collection", "reviews")); // prettier-ignore
        return context.json({ count: rows.length });
      },
      openapi: { summary: "The highest scoring reviews", tags: ["reviews"] },
    },
  ],

  client: (base) => ({
    summary: () => base.request("/reviews/top"),
  }),

  admin: {
    navItems: [{ label: "Reviews", path: "/reviews" }],
    scripts: ["/reviews/panel.js"],
  },
};

const collections = () => ({
  posts: defineCollection({
    fields: { title: text({ required: true }), body: richText({}) },
  }),
});

async function setup(plugins: CmsPlugin<never>[] = []) {
  const adapter = sqlite(new Database(":memory:"));
  const cms = heyoCms({
    database: () => adapter,
    collections: collections(),
    ai: {
      auth: { openai: { type: "api-key", token: "sk" } },
      defaultModel: { provider: "openai", model: "gpt-4o-mini" },
      complete: async (request: AiCompletionRequest) => ({
        text: request.prompt.includes("Rate") ? "4" : "ok",
        usage: { input: 1, output: 1, total: 2, cost: 0 },
      }),
    },
    plugins: plugins as unknown as CmsPlugin<unknown>[],
  });
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_plugins"),
  );
  return { cms, adapter };
}

describe("an external plugin", () => {
  test("adds a collection that behaves like any other", async () => {
    const { cms } = await setup([reviewsPlugin as unknown as CmsPlugin<never>]);
    const api = cms.api as unknown as Record<
      string,
      {
        create(args: { data: JsonObject; actor: unknown }): Promise<JsonObject | null>; // prettier-ignore
        find(args: { actor: unknown }): Promise<{ docs: JsonObject[] }>;
      }
    >;

    const created = await api.reviews?.create({
      data: { score: 4, body: { type: "doc", content: [] } },
      actor: systemActor(),
    });
    expect(created?.score).toBe(4);

    // Validation comes from the plugin's own zod schema.
    await expect(
      api.reviews?.create({ data: { score: 9 }, actor: systemActor() }),
    ).rejects.toThrow();

    // And the REST surface was generated for it, like for the rest.
    const response = await cms.handler(
      new Request("http://cms.test/api/heyo-cms/reviews"),
    );
    expect(response.status).toBe(200);
    await cms.close();
  });

  test("adds a field and a hook to a collection it does not own", async () => {
    const { cms } = await setup([reviewsPlugin as unknown as CmsPlugin<never>]);

    const post = await cms.api.posts.create({
      data: { title: "Uploads", editorsPick: 2 } as never,
      actor: systemActor(),
    });
    // The field is stored and validated…
    expect((post as unknown as JsonObject)?.editorsPick).toBe(2);
    // …and the plugin's hook ran before the write.
    expect(post?.title).toBe("Uploads ★");

    // The pipeline says who is in it and in what order: plugin first.
    const hooks = cms
      .inspect()
      .hooks.filter((entry) => entry.collection === "posts");
    expect(hooks).toEqual([
      {
        collection: "posts",
        operation: "create",
        timing: "before",
        source: "reviews",
        priority: 0,
      },
    ]);
    await cms.close();
  });

  test("adds a table, and the schema includes it", async () => {
    const { cms } = await setup([reviewsPlugin as unknown as CmsPlugin<never>]);
    const tables = cms.schema.tables.map((table) => table.name);
    expect(tables).toContain("review_votes");
    await cms.close();
  });

  test("adds a route, and it is in the router and the document", async () => {
    const { cms } = await setup([reviewsPlugin as unknown as CmsPlugin<never>]);
    const route = cms
      .inspect()
      .routes.find((entry) => entry.path.endsWith("/reviews/top"));
    expect(route).toMatchObject({ method: "GET", source: "reviews" });

    const response = await cms.handler(
      new Request("http://cms.test/api/heyo-cms/reviews/top"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 0 });

    const document = (await (
      await cms.handler(
        new Request("http://cms.test/api/heyo-cms/openapi.json"),
      )
    ).json()) as JsonObject;
    const paths = document.paths as JsonObject;
    expect(paths["/reviews/top"]).toBeDefined();
    await cms.close();
  });

  test("adds an editor node that serialises everywhere", async () => {
    const { cms } = await setup([reviewsPlugin as unknown as CmsPlugin<never>]);
    const html = richTextToHtml({
      type: "doc",
      content: [
        {
          type: "pullQuote",
          attrs: { attribution: "A reader" },
          content: [{ type: "text", text: "It works." }],
        },
      ],
    });
    expect(html).toBe(
      '<figure class="pull-quote"><blockquote>It works.</blockquote><figcaption>A reader</figcaption></figure>',
    );

    // The panel is told about the node, so one static bundle can render it.
    const node = cms
      .inspect()
      .editor.nodes.find((entry) => entry.name === "pullQuote");
    expect(node).toMatchObject({ group: "block", content: "inline*" });
    await cms.close();
  });

  test("adds an AI action, usable from the field that declares it", async () => {
    const { cms } = await setup([reviewsPlugin as unknown as CmsPlugin<never>]);
    const result = await cms.ai.run({
      collection: "reviews",
      field: "score",
      action: "guess-rating",
      document: { body: null },
      actor: systemActor(),
    });
    expect(result.value).toBe(4);
    await cms.close();
  });

  test("adds a migration, written as a reviewable file", async () => {
    const { cms, adapter } = await setup([
      reviewsPlugin as unknown as CmsPlugin<never>,
    ]);
    const directory = await mkdtemp(join(tmpdir(), "heyo-cms-plugin-"));
    const store = new MigrationStore(directory);

    const first = await generateMigration({
      adapter,
      store,
      target: cms.schema,
      plugins: cms._config.plugins.flatMap((plugin) =>
        (plugin.migrations ?? []).map((migration) => ({
          plugin: plugin.id,
          id: migration.id,
          steps: migration.steps,
        })),
      ),
    });

    expect(first.created).toBe(true);
    // Numbered after the schema diff: a plugin's steps talk about tables the
    // diff creates, so they cannot run before it.
    expect(first.file).toMatch(/^0000_/);
    expect(first.plugins?.[0]?.file).toBe("0001_reviews_seed_votes_index.sql");
    const sql = await readFile(
      join(directory, first.plugins?.[0]?.file as string),
      "utf8",
    );
    expect(sql).toContain("idx_review_votes_score");

    // Twice must produce nothing, for the plugin's steps as much as for the
    // schema diff: a generator that writes a duplicate backfill is one
    // nobody can trust in a pull request.
    const second = await generateMigration({
      adapter,
      store,
      target: cms.schema,
      plugins: cms._config.plugins.flatMap((plugin) =>
        (plugin.migrations ?? []).map((migration) => ({
          plugin: plugin.id,
          id: migration.id,
          steps: migration.steps,
        })),
      ),
    });
    expect(second.created).toBe(false);
    expect(second.plugins ?? []).toHaveLength(0);

    const files = (await readdir(directory)).filter((file) =>
      file.endsWith(".sql"),
    );
    expect(files).toHaveLength(2);
    await cms.close();
  });

  test("is printed by inspect, down to what it contributed", async () => {
    const { cms } = await setup([reviewsPlugin as unknown as CmsPlugin<never>]);
    expect(cms.inspect().plugins).toEqual([
      {
        id: "reviews",
        collections: ["reviews"],
        tables: ["review_votes"],
        routes: 1,
        hooks: 1,
        migrations: ["seed_votes_index"],
        client: true,
        admin: true,
      },
    ]);
    await cms.close();
  });
});

describe("the loader", () => {
  test("refuses two plugins with the same id", async () => {
    await expect(
      setup([
        reviewsPlugin as unknown as CmsPlugin<never>,
        { id: "reviews" } as CmsPlugin<never>,
      ]),
    ).rejects.toThrow(/two plugins share this id/);
  });

  test("refuses a collection that already exists", async () => {
    const clashing: CmsPlugin = {
      id: "clash",
      schema: {
        collections: {
          posts: defineCollection({ fields: { title: text({}) } }),
        },
      },
    };
    await expect(
      setup([clashing as unknown as CmsPlugin<never>]),
    ).rejects.toThrow(/already declares a collection called "posts"/);
  });

  test("refuses a field that would shadow one that exists", async () => {
    const clashing: CmsPlugin = {
      id: "clash",
      extendCollections: () => [
        { collection: "posts", fields: { title: text({}) } },
      ],
    };
    await expect(
      setup([clashing as unknown as CmsPlugin<never>]),
    ).rejects.toThrow(/already has a field called "title"/);
  });

  test("refuses a patch aimed at nothing", async () => {
    const lost: CmsPlugin = {
      id: "lost",
      extendCollections: () => [
        { collection: "ghosts", fields: { title: text({}) } },
      ],
    };
    await expect(setup([lost as unknown as CmsPlugin<never>])).rejects.toThrow(
      /not a collection or a global/,
    );
  });

  test("refuses two plugins claiming one route", async () => {
    const one: CmsPlugin = {
      id: "one",
      routes: [{ method: "GET", path: "/shared", handler: (c) => c.json({}) }],
    };
    const two: CmsPlugin = {
      id: "two",
      routes: [{ method: "GET", path: "/shared", handler: (c) => c.json({}) }],
    };
    await expect(
      setup([one as unknown as CmsPlugin<never>, two as unknown as CmsPlugin<never>]), // prettier-ignore
    ).rejects.toThrow(/already registered by "one"/);
  });

  test("runs plugin hooks before the configuration's own", async () => {
    const adapter = sqlite(new Database(":memory:"));
    const order: string[] = [];
    const plugin: CmsPlugin = {
      id: "orderly",
      hooks: [
        {
          collection: "posts",
          operation: "create",
          timing: "before",
          priority: 10,
          handler: (data) => {
            order.push("plugin-late");
            return { data };
          },
        },
        {
          collection: "posts",
          operation: "create",
          timing: "before",
          priority: -10,
          handler: (data) => {
            order.push("plugin-early");
            return { data };
          },
        },
      ],
    };

    const cms = heyoCms({
      database: () => adapter,
      collections: collections(),
      plugins: [plugin],
      databaseHooks: {
        posts: {
          create: {
            before: () => {
              order.push("config");
            },
          },
        },
      },
    });
    adapter.useSchema(cms.schema);
    await adapter.applyMigration(
      adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_order"),
    );

    await cms.api.posts.create({
      data: { title: "x" },
      actor: systemActor(),
    });
    expect(order).toEqual(["plugin-early", "plugin-late", "config"]);
    await cms.close();
  });
});

describe("the job runner", () => {
  test("sweeps on a timer and stops when it is told", async () => {
    const { cms } = await setup();
    const reports: number[] = [];
    const runner = startJobRunner({
      cms,
      interval: 5,
      onReport: (report) => reports.push(report.processed),
    });

    await runner.runNow();
    expect(reports.length).toBeGreaterThanOrEqual(1);
    await runner.stop();
    expect(runner.running).toBe(false);

    const before = reports.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reports.length).toBe(before);
    await cms.close();
  });

  test("applies a scheduled change through the Workers handler", async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Later" },
      actor: systemActor(),
    });
    await cms.api.posts.schedule({
      id: created?.id as string,
      at: new Date(Date.now() - 1000),
      data: { title: "Now" },
      actor: systemActor(),
    });

    const waited: Promise<unknown>[] = [];
    const scheduled = cmsScheduled(cms);
    await scheduled({}, {}, { waitUntil: (promise) => waited.push(promise) });
    expect(waited).toHaveLength(1);

    const after = await cms.api.posts.findById(created?.id as string, {
      actor: systemActor(),
    });
    expect(after?.title).toBe("Now");
    await cms.close();
  });
});
