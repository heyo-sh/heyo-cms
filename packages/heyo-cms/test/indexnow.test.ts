import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { defineCollection, heyoCms, systemActor } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { select, slug, text } from "../src/fields";
import { indexNow } from "../src/plugins";
import { emptySnapshot } from "../src/schema/snapshot";
import type { JsonObject } from "../src/types/json";

/**
 * `indexNow()`: a ping after the commit, never before it, with the old
 * address as well as the new one, and a key file at the root of the site.
 */

const actor = systemActor("usr_test");
const key = "a1b2c3d4e5f6a7b8";

interface Sent {
  url: string;
  body: { host: string; key: string; keyLocation: string; urlList: string[] };
}

async function setup(options: { enabled?: boolean; status?: number } = {}) {
  const sent: Sent[] = [];
  const adapter = sqlite(new Database(":memory:"));
  const cms = heyoCms({
    database: () => adapter,
    collections: {
      posts: defineCollection({
        fields: {
          title: text({ required: true, localized: true }),
          slug: slug({ from: "title", localized: true }),
          status: select({ options: ["draft", "published"], localized: true }),
        },
      }),
      notes: defineCollection({ fields: { body: text({}) } }),
    },
    i18n: { locales: ["en", "pl"], defaultLocale: "en" },
    plugins: [
      indexNow({
        key: () => key,
        url: (post, { locale }) =>
          post.status === "published" && typeof post.slug === "string"
            ? `https://example.com/${locale}/blog/${post.slug}`
            : null,
        collections: ["posts"],
        ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
        fetch: async (url, init) => {
          sent.push({ url, body: JSON.parse(String(init.body)) as Sent["body"] }); // prettier-ignore
          return new Response(null, { status: options.status ?? 200 });
        },
      }),
    ],
  });
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_indexnow"),
  );
  return { cms, sent };
}

describe("indexNow", () => {
  test("announces a page once it is public, and both addresses when it moves", async () => {
    const { cms, sent } = await setup();
    const post = await cms.api.posts.create({ data: { title: "Hello" }, actor }); // prettier-ignore
    const id = String(post!.id);
    await cms.drainEvents();
    // A draft has no public address: nothing to say.
    expect(sent).toHaveLength(0);

    await cms.api.posts.update({ id, data: { status: "published" }, actor });
    await cms.drainEvents();
    expect(sent).toEqual([
      {
        url: "https://api.indexnow.org/indexnow",
        body: {
          host: "example.com",
          key,
          keyLocation: `https://example.com/${key}.txt`,
          urlList: ["https://example.com/en/blog/hello"],
        },
      },
    ]);

    await cms.api.posts.update({ id, data: { slug: "hello-again" }, actor });
    await cms.drainEvents();
    expect(sent[1]?.body.urlList).toEqual([
      "https://example.com/en/blog/hello-again",
      "https://example.com/en/blog/hello",
    ]);

    // Gone: its last address is what the engines should look at again.
    await cms.api.posts.delete({ id, actor });
    await cms.drainEvents();
    expect(sent[2]?.body.urlList).toEqual(["https://example.com/en/blog/hello-again"]); // prettier-ignore

    // Other collections are not its business.
    await cms.api.notes.create({ data: { body: "x" }, actor });
    await cms.drainEvents();
    expect(sent).toHaveLength(3);
    await cms.close();
  });

  test("a rolled back write announces nothing", async () => {
    const { cms, sent } = await setup();
    await expect(
      cms.api.posts.create({
        data: {
          title: "Hello",
          status: "published",
          slug: "!!!",
        } as JsonObject,
        actor,
      }),
    ).rejects.toThrow();
    await cms.drainEvents();
    expect(sent).toHaveLength(0);
    await cms.close();
  });

  test("sends nothing when disabled, and survives an engine that says no", async () => {
    const off = await setup({ enabled: false });
    await off.cms.api.posts.create({ data: { title: "A", status: "published" }, actor }); // prettier-ignore
    await off.cms.drainEvents();
    expect(off.sent).toHaveLength(0);
    await off.cms.close();

    const refused = await setup({ status: 403 });
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => warnings.push(message);
    try {
      await refused.cms.api.posts.create({ data: { title: "A", status: "published" }, actor }); // prettier-ignore
      await refused.cms.drainEvents();
    } finally {
      console.warn = warn;
    }
    expect(refused.sent).toHaveLength(1);
    expect(warnings[0]).toContain("HTTP 403");
    // Delivered, not retried: the outbox has nothing left for it.
    expect(await refused.cms.drainEvents()).toBe(0);
    await refused.cms.close();
  });

  test("serves its key file at the root, and nothing else there", async () => {
    const { cms } = await setup();
    const file = await cms.handler(new Request(`https://example.com/${key}.txt`)); // prettier-ignore
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(key);
    expect(file.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const other = await cms.handler(new Request("https://example.com/robots.txt")); // prettier-ignore
    expect(other.status).toBe(404);
    await cms.close();
  });

  test("refuses a key the protocol would", () => {
    expect(() => indexNow({ key: "short", url: () => null })).toThrow(
      /8 to 128 letters/,
    );
  });
});
