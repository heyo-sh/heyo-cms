import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { defineCollection, defineGlobal, heyoCms } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { text } from "../src/fields";
import { eq } from "../src/query";
import { emptySnapshot } from "../src/schema/snapshot";

const generate = ({ fields }: { fields: Record<string, unknown> }) => {
  if ("secret" in fields) throw new Error("Secret reached the generator");
  return String(fields.title ?? "")
    .toLowerCase()
    .replaceAll(" ", "-");
};

async function setup() {
  const adapter = sqlite(new Database(":memory:"));
  const cms = heyoCms({
    database: () => adapter,
    collections: {
      posts: defineCollection({
        fields: {
          title: text({ required: true }),
          secret: text({ access: { read: () => false } }),
          slug: text({
            required: true,
            generate,
            aiGenerate: { context: ["title"] },
            pattern: "^[a-z0-9-]+$",
          }),
        },
      }),
    },
  });
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_generate"),
  );
  const post = (path: string, document: Record<string, unknown>) =>
    cms.handler(
      new Request(`http://localhost/api/heyo-cms${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document }),
      }),
    );
  return { cms, post };
}

describe("deterministic field generation", () => {
  test("works without AI, with the current draft, without writing", async () => {
    const { cms, post } = await setup();
    expect(
      cms
        .inspect()
        .routes.some((route) => route.path.endsWith("/generate/:field")),
    ).toBe(true);
    const response = await post("/posts/generate/slug", {
      title: "New Post",
      secret: "private",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: "new-post" });
    expect((await cms.api.posts.find({})).docs).toHaveLength(0);
    const panel = (await (
      await cms.handler(new Request("http://localhost/api/heyo-cms/panel"))
    ).json()) as {
      collections: {
        fields: {
          name: string;
          generate: boolean;
          options: Record<string, unknown>;
        }[];
      }[];
    };
    const slug = panel.collections[0]?.fields.find(
      (field) => field.name === "slug",
    );
    expect(slug?.generate).toBe(true);
    expect(slug?.options).not.toHaveProperty("generate");
  });

  test("uses the saved record with a newer draft and refuses unconfigured fields", async () => {
    const { cms, post } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Original", slug: "original" },
    });
    expect(created).not.toBeNull();
    const response = await post(`/posts/${created!.id}/generate/slug`, {
      title: "Edited Title",
    });
    expect(await response.json()).toEqual({ value: "edited-title" });
    expect((await cms.api.posts.findById(created!.id))?.slug).toBe("original");
    expect(
      (await post("/posts/generate/title", { title: "Other" })).status,
    ).toBe(404);
  });

  test("requires write access and validates the generated value", async () => {
    const adapter = sqlite(new Database(":memory:"));
    const cms = heyoCms({
      database: () => adapter,
      collections: {
        posts: defineCollection({
          fields: {
            title: text({}),
            restricted: text({ generate, access: { update: () => false } }),
            unreadable: text({ generate, access: { read: () => false } }),
            invalid: text({ pattern: "^valid$", generate: () => "bad" }),
          },
        }),
      },
    });
    adapter.useSchema(cms.schema);
    await adapter.applyMigration(
      adapter.render(
        adapter.plan(emptySnapshot(), cms.schema),
        "0000_restricted",
      ),
    );
    const call = (name: string) =>
      cms.handler(
        new Request(`http://localhost/api/heyo-cms/posts/generate/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ document: { title: "test" } }),
        }),
      );
    expect((await call("restricted")).status).toBe(403);
    expect((await call("unreadable")).status).toBe(404);
    expect((await call("invalid")).status).toBe(422);
  });

  test("enforces collection update filters against the actual record", async () => {
    const adapter = sqlite(new Database(":memory:"));
    const cms = heyoCms({
      database: () => adapter,
      collections: {
        posts: defineCollection({
          fields: { title: text({ required: true }), slug: text({ generate }) },
          access: { update: () => eq("data.title", "Allowed") },
        }),
      },
    });
    adapter.useSchema(cms.schema);
    await adapter.applyMigration(
      adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_filter"),
    );
    const allowed = await cms.api.posts.create({ data: { title: "Allowed" } });
    const denied = await cms.api.posts.create({ data: { title: "Denied" } });
    const post = (id: string) =>
      cms.handler(
        new Request(`http://localhost/api/heyo-cms/posts/${id}/generate/slug`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ document: { title: "Forged" } }),
        }),
      );
    expect((await post(denied!.id)).status).toBe(404);
    const result = await post(allowed!.id);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ value: "forged" });
  });

  test("works for globals without an AI section", async () => {
    const adapter = sqlite(new Database(":memory:"));
    const cms = heyoCms({
      database: () => adapter,
      collections: {},
      globals: {
        settings: defineGlobal({
          fields: {
            title: text({ default: "Home" }),
            handle: text({ generate }),
          },
        }),
      },
    });
    adapter.useSchema(cms.schema);
    await adapter.applyMigration(
      adapter.render(
        adapter.plan(emptySnapshot(), cms.schema),
        "0000_global_generate",
      ),
    );
    const result = await cms.handler(
      new Request(
        "http://localhost/api/heyo-cms/globals/settings/generate/handle",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ document: { title: "Site Home" } }),
        },
      ),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ value: "site-home" });
    expect((await cms.globals.settings.get()).handle).toBeNull();
  });
});
