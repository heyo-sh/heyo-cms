import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";

import { heyoCmsClient } from "../src/client";
import { defineCollection, heyoCms, systemActor } from "../src/config";
import { mongodb } from "../src/db/mongodb";
import { postgres, type PostgresClient } from "../src/db/postgres";
import { sqlite } from "../src/db/sqlite";
import { select, slug, slugify, text } from "../src/fields";
import { emptySnapshot } from "../src/schema/snapshot";
import type { DatabaseAdapter } from "../src/types/database";
import { memoryMongo } from "./mongo-memory";

/**
 * The `slug` field.
 *
 * What it promises is a URL that is made for you, stays put, and keeps
 * working after it moves: generated from the title once, cleaned when typed,
 * unique per language (which no index can say), and — with `history` — an
 * old address that still finds the page, that no other page may take, and
 * that disappears with the page. Every one of those is a query, so the suite
 * runs on the three engines.
 */

const actor = systemActor("usr_test");

const collections = () => ({
  posts: defineCollection({
    fields: {
      title: text({ required: true, localized: true }),
      slug: slug({ from: "title", localized: true, history: true }),
      status: select({ options: ["draft", "published"], localized: true }),
    },
    access: { read: () => true, create: () => true, update: () => true, delete: () => true }, // prettier-ignore
  }),
  tags: defineCollection({
    fields: {
      name: text({ required: true }),
      slug: slug({ from: "name" }),
    },
  }),
});

interface EngineUnderTest {
  name: string;
  create(): Promise<DatabaseAdapter> | DatabaseAdapter;
}

function runSlugSuite(entry: EngineUnderTest): void {
  describe(`slugs: ${entry.name}`, () => {
    const setup = async () => {
      const adapter = await entry.create();
      const cms = heyoCms({
        database: () => adapter,
        collections: collections(),
        i18n: { locales: ["en", "pl"], defaultLocale: "en" },
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_slugs"),
      );
      return cms;
    };

    test("is made from the title once, cleaned when typed, and never moved by a retitle", async () => {
      const cms = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Łódź in Autumn — a Guide" },
        actor,
      });
      expect(post?.slug).toBe("lodz-in-autumn-a-guide");

      const retitled = await cms.api.posts.update({
        id: String(post!.id),
        data: { title: "Something else entirely" },
        actor,
      });
      expect(retitled?.slug).toBe("lodz-in-autumn-a-guide");

      const typed = await cms.api.posts.update({
        id: String(post!.id),
        data: { slug: "  Kraków & Łódź!! " },
        actor,
      });
      expect(typed?.slug).toBe("krakow-lodz");

      await expect(
        cms.api.posts.update({ id: String(post!.id), data: { slug: "!!!" }, actor }), // prettier-ignore
      ).rejects.toThrow(/no letters or digits/);

      // Cleared on purpose: made again from the title as it is now.
      const cleared = await cms.api.posts.update({
        id: String(post!.id),
        data: { slug: null },
        actor,
      });
      expect(cleared?.slug).toBe("something-else-entirely");
      await cms.close();
    });

    test("is unique per language, with a suffix when generated and a 409 when typed", async () => {
      const cms = await setup();
      const first = await cms.api.posts.create({ data: { title: "Hello" }, actor }); // prettier-ignore
      const second = await cms.api.posts.create({ data: { title: "Hello" }, actor }); // prettier-ignore
      expect(first?.slug).toBe("hello");
      expect(second?.slug).toBe("hello-2");

      await expect(
        cms.api.posts.update({ id: String(second!.id), data: { slug: "hello" }, actor }), // prettier-ignore
      ).rejects.toThrow(/already used by posts/);

      // Another language is another address space.
      const polish = await cms.api.posts.update({
        id: String(second!.id),
        locale: "pl",
        data: { title: "Hello" },
        actor,
      });
      expect(polish?.slug).toBe("hello");

      // A trashed page keeps its address: restoring it must not collide.
      await cms.api.posts.delete({ id: String(first!.id), actor });
      const third = await cms.api.posts.create({ data: { title: "Hello" }, actor }); // prettier-ignore
      expect(third?.slug).toBe("hello-3");
      await cms.close();
    });

    test("a non-localized slug is unique across the collection", async () => {
      const cms = await setup();
      const a = await cms.api.tags.create({
        data: { name: "Art Deco" },
        actor,
      });
      const b = await cms.api.tags.create({
        data: { name: "Art déco" },
        actor,
      });
      expect([a?.slug, b?.slug]).toEqual(["art-deco", "art-deco-2"]);
      await expect(
        cms.api.tags.update({ id: String(b!.id), data: { slug: "art-deco" }, actor }), // prettier-ignore
      ).rejects.toThrow(/already used/);
      expect(cms.schema.tables.map((table) => table.name)).toContain("slug_history"); // prettier-ignore
      await cms.close();
    });

    test("with history, an old slug still finds the page, and no other page may take it", async () => {
      const cms = await setup();
      const post = await cms.api.posts.create({ data: { title: "Old name" }, actor }); // prettier-ignore
      const id = String(post!.id);
      await cms.api.posts.update({ id, data: { slug: "new-name" }, actor });

      const now = await cms.api.posts.resolveSlug("new-name", { locale: "en" });
      expect(now).toMatchObject({ id, field: "slug", locale: "en", current: true }); // prettier-ignore
      expect(now?.document.slug).toBe("new-name");

      const before = await cms.api.posts.resolveSlug("old-name", { locale: "en" }); // prettier-ignore
      expect(before).toMatchObject({ id, locale: "en", current: false });
      expect(before?.document.slug).toBe("new-name");

      expect(
        (await cms.api.posts.previousSlugs({ id, locale: "en" })).map((entry) => entry.slug), // prettier-ignore
      ).toEqual(["old-name"]);

      // Generated slugs step around it; typed ones are refused with the way out.
      const other = await cms.api.posts.create({ data: { title: "Old name" }, actor }); // prettier-ignore
      expect(other?.slug).toBe("old-name-2");
      await expect(
        cms.api.posts.update({ id: String(other!.id), data: { slug: "old-name" }, actor }), // prettier-ignore
      ).rejects.toThrow(/previous address of posts .* Remove it/);

      // Moving back is not a redirect to itself.
      await cms.api.posts.update({ id, data: { slug: "old-name" }, actor });
      expect(
        (await cms.api.posts.previousSlugs({ id, locale: "en" })).map((entry) => entry.slug), // prettier-ignore
      ).toEqual(["new-name"]);
      await cms.close();
    });

    test("a slug from another language still arrives, after the right one", async () => {
      const cms = await setup();
      const post = await cms.api.posts.create({ data: { title: "Autumn" }, actor }); // prettier-ignore
      const id = String(post!.id);
      await cms.api.posts.update({ id, locale: "pl", data: { title: "Jesień" }, actor }); // prettier-ignore

      const wrongPrefix = await cms.api.posts.resolveSlug("jesien", { locale: "en" }); // prettier-ignore
      expect(wrongPrefix).toMatchObject({ id, locale: "pl", current: true });
      // Read in the language asked for: the page can redirect to its slug there.
      expect(wrongPrefix?.document.slug).toBe("autumn");
      expect(await cms.api.posts.resolveSlug("nothing-here")).toBeNull();
      expect(await cms.api.posts.resolveSlug("../etc/passwd")).toBeNull();
      await cms.close();
    });

    test("merging: a slug added by hand leads here; removing it frees it", async () => {
      const cms = await setup();
      const keep = await cms.api.posts.create({ data: { title: "Keep" }, actor }); // prettier-ignore
      const merge = await cms.api.posts.create({ data: { title: "Merge me" }, actor }); // prettier-ignore
      const keepId = String(keep!.id);

      // Still the other page's address: refused.
      await expect(
        cms.api.posts.addPreviousSlug({ id: keepId, slug: "merge-me", locale: "en", actor }), // prettier-ignore
      ).rejects.toThrow(/already used/);
      await cms.api.posts.delete({
        id: String(merge!.id),
        permanent: true,
        actor,
      });

      const list = await cms.api.posts.addPreviousSlug({
        id: keepId,
        slug: "Merge Me",
        locale: "en",
        actor,
      });
      expect(list.map((entry) => entry.slug)).toEqual(["merge-me"]);
      expect((await cms.api.posts.resolveSlug("merge-me"))?.id).toBe(keepId);
      await expect(
        cms.api.posts.addPreviousSlug({ id: keepId, slug: "keep", actor }),
      ).rejects.toThrow(/this document's slug already/);

      expect(
        await cms.api.posts.removePreviousSlug({ id: keepId, slug: "merge-me", locale: "en", actor }), // prettier-ignore
      ).toEqual([]);
      expect(await cms.api.posts.resolveSlug("merge-me")).toBeNull();
      await cms.close();
    });

    test("a purged page takes its previous addresses with it; a trashed one keeps them", async () => {
      const cms = await setup();
      const post = await cms.api.posts.create({ data: { title: "Gone soon" }, actor }); // prettier-ignore
      const id = String(post!.id);
      await cms.api.posts.update({ id, data: { slug: "renamed" }, actor });

      await cms.api.posts.delete({ id, actor });
      // A trashed page has no address, but the address is still its own.
      expect(await cms.api.posts.resolveSlug("gone-soon")).toBeNull();
      const blocked = await cms.api.posts.create({ data: { title: "Gone soon" }, actor }); // prettier-ignore
      expect(blocked?.slug).toBe("gone-soon-2");

      await cms.api.posts.purge({ id, actor });
      const free = await cms.api.posts.create({ data: { title: "Renamed" }, actor }); // prettier-ignore
      expect(free?.slug).toBe("renamed");
      const freed = await cms.api.posts.update({
        id: String(free!.id),
        data: { slug: "gone-soon" },
        actor,
      });
      expect(freed?.slug).toBe("gone-soon");
      await cms.close();
    });

    test("over HTTP: resolve-slug and previous-slugs, through the client", async () => {
      const cms = await setup();
      const client = heyoCmsClient<typeof cms>({
        baseUrl: "https://site.test/api/heyo-cms",
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          cms.handler(new Request(input, init))) as typeof fetch,
      });
      const post = await cms.api.posts.create({ data: { title: "Over the wire" }, actor }); // prettier-ignore
      const id = String(post!.id);
      await cms.api.posts.update({ id, data: { slug: "wired" }, actor });

      const resolved = await client.posts.resolveSlug("over-the-wire", { locale: "en" }); // prettier-ignore
      expect(resolved?.current).toBe(false);
      expect(resolved?.document.slug).toBe("wired");
      expect(await client.posts.resolveSlug("missing")).toBeNull();
      expect(
        (await client.posts.previousSlugs({ id, locale: "en" })).map((entry) => entry.slug), // prettier-ignore
      ).toEqual(["over-the-wire"]);
      // Writing needs a credential: the collection lets anyone update in
      // this suite, so the write is refused by nothing but the slug rules.
      await expect(
        client.posts.addPreviousSlug({ id, slug: "wired", locale: "en" }),
      ).rejects.toThrow(/slug already/);
      await cms.close();
    });
  });
}

describe("slug configuration", () => {
  test("from must name a text field of the collection", () => {
    const build = (from: string) => () =>
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        collections: {
          posts: defineCollection({
            fields: {
              title: text({}),
              status: select({ options: ["a"] }),
              slug: slug({ from }),
            },
          }),
        },
      });
    expect(build("titel")).toThrow(/"titel" is not another field of posts/);
    expect(build("slug")).toThrow(/not another field/);
    expect(build("title")).not.toThrow();
  });

  test("the history table exists only where history is kept, and is not needed elsewhere", async () => {
    const adapter = sqlite(new Database(":memory:"));
    const cms = heyoCms({
      database: () => adapter,
      collections: {
        posts: defineCollection({
          fields: { title: text({}), slug: slug({ from: "title" }) },
        }),
      },
    });
    expect(cms.schema.tables.map((table) => table.name)).not.toContain("slug_history"); // prettier-ignore
    adapter.useSchema(cms.schema);
    await adapter.applyMigration(
      adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_plain"),
    );
    const a = await cms.api.posts.create({ data: { title: "Same" }, actor });
    const b = await cms.api.posts.create({ data: { title: "Same" }, actor });
    await cms.api.posts.update({ id: String(a!.id), data: { slug: "moved" }, actor }); // prettier-ignore
    expect(b?.slug).toBe("same-2");
    expect((await cms.api.posts.resolveSlug("moved"))?.id).toBe(String(a!.id));
    expect(await cms.api.posts.resolveSlug("same")).toBeNull();
    await expect(cms.api.posts.previousSlugs({ id: String(a!.id) })).rejects.toThrow(/no slug field with history/); // prettier-ignore
    await cms.close();
  });

  test("the generator behind the panel's button is the same slugify", async () => {
    const field = slug({ from: "title" });
    expect(await field.generate?.({ fields: { title: "Zażółć gęślą jaźń" }, locale: "pl" })).toBe("zazolc-gesla-jazn"); // prettier-ignore
    expect(await field.generate?.({ fields: { title: "" }, locale: "en" })).toBeNull(); // prettier-ignore
    expect(slugify("Привіт, світе")).toBe("pryvit-svite");
    expect(slugify("Καλημέρα")).toBe("kalimera");
    expect(slugify("Straße & Øresund")).toBe("strasse-oresund");
    expect(slugify("a".repeat(60) + "-" + "b".repeat(60))).toBe("a".repeat(60));
    expect(slugify(slugify("Already a slug-42"))).toBe("already-a-slug-42");
  });
});

runSlugSuite({
  name: "sqlite",
  create: () => sqlite(new Database(":memory:")),
});

runSlugSuite({
  name: "postgres (pglite)",
  create: () => {
    const database = new PGlite();
    const client: PostgresClient = {
      async query(text_, values) {
        const result = await database.query(text_, values as unknown[]);
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

runSlugSuite({
  name: "mongodb (in-process)",
  create: () => mongodb(memoryMongo(), { transactions: false }),
});
