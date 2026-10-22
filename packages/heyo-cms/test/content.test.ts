import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  defineCollection,
  defineGlobal,
  heyoCms,
  systemActor,
} from "../src/config";
import { exportContent } from "../src/content/export";
import { importContent, splitLocales } from "../src/content/import";
import {
  parseRecord,
  readRecords,
  serializeRecord,
  toLines,
  type ContentRecord,
  type DocumentRecord,
  type GlobalRecord,
} from "../src/content/records";
import { sqlite } from "../src/db/sqlite";
import { relation, select, text } from "../src/fields";
import { emptySnapshot } from "../src/schema/snapshot";
import type { CmsEvent } from "../src/types/events";
import type { CmsInstance } from "../src/types/instance";

/**
 * Stage 10: content leaves and comes back.
 *
 * The export is the only read in the product that bypasses `rowToDocument`,
 * and the reason is the thing this suite has to prove: a read resolves one
 * locale, so an export built on one would quietly drop every translation. The
 * import is the opposite claim — it is an ordinary sequence of writes, so
 * hooks, validation and events all run, and the ids survive because a
 * relation that pointed somewhere has to still point there.
 */

const collections = () => ({
  authors: defineCollection({
    fields: { name: text({ required: true }) },
  }),
  posts: defineCollection({
    fields: {
      title: text({ required: true, localized: true }),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
      status: select({ options: ["draft", "published"], default: "draft" }),
      author: relation("authors"),
    },
  }),
});

const globals = () => ({
  settings: defineGlobal({
    fields: {
      siteName: text({ default: "Untitled" }),
      tagline: text({ localized: true }),
    },
  }),
});

type Fixture = ReturnType<typeof collections>;
type GlobalFixture = ReturnType<typeof globals>;

async function setup(): Promise<{
  cms: CmsInstance<Fixture, GlobalFixture>;
  events: CmsEvent[];
}> {
  const adapter = sqlite(new Database(":memory:"));
  const cms = heyoCms({
    database: () => adapter,
    i18n: { locales: ["en", "pl"], defaultLocale: "en" },
    collections: collections(),
    globals: globals(),
  });
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_content"),
  );
  const events: CmsEvent[] = [];
  cms.on("*", (event) => {
    events.push(event);
  });
  return { cms, events };
}

async function collect(
  records: AsyncIterable<ContentRecord>,
): Promise<ContentRecord[]> {
  const all: ContentRecord[] = [];
  for await (const record of records) all.push(record);
  return all;
}

const actor = systemActor("usr_export");

test("locale splitting preserves nulls and cannot traverse prototypes", async () => {
  const { cms } = await setup();
  const definition = cms._config.collections.posts!;
  const result = splitLocales(
    definition,
    JSON.parse('{"title":{"en":null,"pl":null,"__proto__":"safe"}}'),
    "en",
  );
  expect(result.base.title).toBeNull();
  expect(result.translations.pl?.title).toBeNull();
  expect(Object.hasOwn(result.translations, "__proto__")).toBe(true);
  expect(result.translations["__proto__"]?.title).toBe("safe");
  expect(Object.hasOwn(Object.prototype, "title")).toBe(false);
  await cms.close();
});

describe("content export", () => {
  test("keeps every locale, not the one a read would have picked", async () => {
    const { cms } = await setup();
    const post = await cms.api.posts.create({
      data: { title: "Hello", handle: "hello" },
      actor,
    });
    await cms.api.posts.update({
      id: String(post?.id),
      data: { title: "Cześć" },
      locale: "pl",
      actor,
    });

    const records = await collect(exportContent(cms));
    const header = records[0];
    expect(header?.kind).toBe("header");
    if (header?.kind !== "header") throw new Error("no header");
    expect(header.format).toBe("heyo-cms/export");
    expect(header.defaultLocale).toBe("en");
    expect(header.collections).toEqual(["authors", "posts"]);

    const document = records.find(
      (record): record is DocumentRecord =>
        record.kind === "document" && record.collection === "posts",
    );
    // The storage shape: both languages, side by side.
    expect(document?.data.title).toEqual({ en: "Hello", pl: "Cześć" });
    expect(document?.data.handle).toBe("hello");
    expect(document?.id).toBe(String(post?.id));
  });

  test("leaves the trash out unless it is asked for", async () => {
    const { cms } = await setup();
    const kept = await cms.api.posts.create({
      data: { title: "Kept", handle: "kept" },
      actor,
    });
    const gone = await cms.api.posts.create({
      data: { title: "Gone", handle: "gone" },
      actor,
    });
    await cms.api.posts.delete({ id: String(gone?.id), actor });

    const plain = await collect(exportContent(cms, { collections: ["posts"] }));
    expect(plain.filter((record) => record.kind === "document")).toHaveLength(
      1,
    );
    expect((plain[1] as DocumentRecord).id).toBe(String(kept?.id));

    const withTrash = await collect(
      exportContent(cms, { collections: ["posts"], includeTrashed: true }),
    );
    expect(withTrash.filter((record) => record.kind === "document")).toHaveLength(2); // prettier-ignore
  });

  test("pages, so a large collection costs a constant amount of memory", async () => {
    const { cms } = await setup();
    for (let index = 0; index < 7; index += 1) {
      await cms.api.posts.create({
        data: { title: `Post ${index}`, handle: `post-${index}` },
        actor,
      });
    }

    const records = await collect(
      exportContent(cms, { collections: ["posts"], batchSize: 2 }),
    );
    const documents = records.filter(
      (record): record is DocumentRecord => record.kind === "document",
    );
    expect(documents).toHaveLength(7);
    // Keyset paging over `id`, so no document is read twice and none is lost.
    expect(new Set(documents.map((document) => document.id)).size).toBe(7);
  });

  test("exports a global nobody has saved", async () => {
    const { cms } = await setup();
    const records = await collect(exportContent(cms, { collections: [] }));
    const global = records.find(
      (record): record is GlobalRecord => record.kind === "global",
    );
    expect(global?.global).toBe("settings");
    expect(global?.updatedAt).toBeNull();
  });

  test("refuses a collection that is not declared", async () => {
    const { cms } = await setup();
    await expect(
      collect(exportContent(cms, { collections: ["post"] })),
    ).rejects.toThrow(/Unknown collection: post/);
  });
});

describe("content import", () => {
  test("round-trips documents, globals, ids and translations", async () => {
    const source = await setup();
    const author = await source.cms.api.authors.create({
      data: { name: "Ada" },
      actor,
    });
    const post = await source.cms.api.posts.create({
      data: {
        title: "Hello",
        handle: "hello",
        status: "published",
        author: String(author?.id),
      },
      actor,
    });
    await source.cms.api.posts.update({
      id: String(post?.id),
      data: { title: "Cześć" },
      locale: "pl",
      actor,
    });
    await source.cms.globals.settings.update({
      data: { siteName: "Acme" },
      actor,
    });

    const dump = await collect(exportContent(source.cms));

    const target = await setup();
    const report = await importContent(target.cms, dump);
    expect(report.errors).toEqual([]);
    expect(report.documents.created).toBe(2);
    expect(report.globals.updated).toBe(1);

    // The id survived, so the relation still resolves — without a rewriting
    // pass that would have to understand every field type a plugin adds.
    const restored = await target.cms.api.posts.findById(String(post?.id), {
      depth: 1,
    });
    expect(restored?.title).toBe("Hello");
    expect(restored?.status).toBe("published");
    expect((restored?.author as { name?: string }).name).toBe("Ada");

    const polish = await target.cms.api.posts.findById(String(post?.id), {
      locale: "pl",
    });
    expect(polish?.title).toBe("Cześć");

    expect((await target.cms.globals.settings.get()).siteName).toBe("Acme");
  });

  test("an import is a write: hooks run and events are emitted", async () => {
    const source = await setup();
    await source.cms.api.posts.create({
      data: { title: "Hooked", handle: "hooked" },
      actor,
    });
    const dump = await collect(exportContent(source.cms));

    const adapter = sqlite(new Database(":memory:"));
    const seen: string[] = [];
    const cms = heyoCms({
      database: () => adapter,
      collections: collections(),
      globals: globals(),
      databaseHooks: {
        posts: {
          create: {
            before: ({ data }) => {
              seen.push("before");
              return { data: { ...data, handle: `${String(data.handle)}-imported` } }; // prettier-ignore
            },
          },
        },
      },
    });
    adapter.useSchema(cms.schema);
    await adapter.applyMigration(
      adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_hooked"),
    );
    const events: CmsEvent[] = [];
    cms.on("*", (event) => {
      events.push(event);
    });

    await importContent(cms, dump);

    expect(seen).toEqual(["before"]);
    const created = await cms.api.posts.findOne({ actor });
    expect(created?.handle).toBe("hooked-imported");
    expect(events.map((event) => event.type)).toContain("document.created");
  });

  test("skips a document that is already there, and updates when told to", async () => {
    const source = await setup();
    const post = await source.cms.api.posts.create({
      data: { title: "First", handle: "first" },
      actor,
    });
    const dump = await collect(exportContent(source.cms));

    const target = await setup();
    await importContent(target.cms, dump);

    await source.cms.api.posts.update({
      id: String(post?.id),
      data: { title: "Second" },
      actor,
    });
    const second = await collect(exportContent(source.cms));

    const skipped = await importContent(target.cms, second);
    expect(skipped.documents.skipped).toBe(1);
    expect((await target.cms.api.posts.findById(String(post?.id)))?.title).toBe(
      "First",
    );

    const updated = await importContent(target.cms, second, {
      onConflict: "update",
    });
    expect(updated.documents.updated).toBe(1);
    expect((await target.cms.api.posts.findById(String(post?.id)))?.title).toBe(
      "Second",
    );

    const failed = await importContent(target.cms, second, {
      onConflict: "fail",
    });
    expect(failed.errors[0]).toContain("already here");
  });

  test("reports a record it cannot place instead of stopping", async () => {
    const { cms } = await setup();
    const records: ContentRecord[] = [
      {
        kind: "header",
        format: "heyo-cms/export",
        version: 1,
        exportedAt: new Date().toISOString(),
        database: "sqlite",
        defaultLocale: "en",
        collections: ["gone"],
        globals: [],
      },
      {
        kind: "document",
        collection: "gone",
        id: "doc_1",
        data: { title: "Orphan" },
        createdAt: null,
        updatedAt: null,
      },
      {
        kind: "document",
        collection: "posts",
        id: "doc_2",
        data: { title: { en: "Fine" }, handle: "fine" },
        createdAt: null,
        updatedAt: null,
      },
    ];

    const report = await importContent(cms, records);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('no collection named "gone"');
    // The good record still landed: one bad line in a dump of a hundred
    // thousand must not cost the other ninety-nine thousand.
    expect(report.documents.created).toBe(1);
  });

  test("a dry run writes nothing", async () => {
    const source = await setup();
    await source.cms.api.posts.create({
      data: { title: "Pretend", handle: "pretend" },
      actor,
    });
    const dump = await collect(exportContent(source.cms));

    const target = await setup();
    const report = await importContent(target.cms, dump, { dryRun: true });
    expect(report.documents.created).toBe(1);
    expect(await target.cms.api.posts.count({ actor })).toBe(0);
  });

  test("refuses a file that is not an export", async () => {
    const { cms } = await setup();
    await expect(importContent(cms, [])).rejects.toThrow(/empty/);
    await expect(
      importContent(cms, [
        {
          kind: "document",
          collection: "posts",
          id: "doc_1",
          data: {},
          createdAt: null,
          updatedAt: null,
        },
      ]),
    ).rejects.toThrow(/export header/);
    await expect(
      importContent(cms, [
        {
          kind: "header",
          format: "something/else",
          version: 1,
          exportedAt: "",
          database: "sqlite",
          defaultLocale: "en",
          collections: [],
          globals: [],
        } as unknown as ContentRecord,
      ]),
    ).rejects.toThrow(/Unknown export format/);
    await expect(
      importContent(cms, [
        {
          kind: "header",
          format: "heyo-cms/export",
          version: 99,
          exportedAt: "",
          database: "sqlite",
          defaultLocale: "en",
          collections: [],
          globals: [],
        },
      ]),
    ).rejects.toThrow(/version 99/);
  });

  test("carries a scheduled change with the document", async () => {
    const source = await setup();
    const post = await source.cms.api.posts.create({
      data: { title: "Later", handle: "later" },
      actor,
    });
    const at = new Date(Date.now() + 86_400_000).toISOString();
    await source.cms.api.posts.schedule({
      id: String(post?.id),
      at,
      data: { status: "published" },
      actor,
    });

    const dump = await collect(exportContent(source.cms));
    const record = dump.find(
      (entry): entry is DocumentRecord =>
        entry.kind === "document" && entry.id === String(post?.id),
    );
    expect(record?.scheduledAt).not.toBeUndefined();
    // The patch travels; the authority it was scheduled with does not. An
    // actor from another deployment means nothing in this one.
    expect(record?.scheduledPatch).toEqual({ status: "published" });

    const target = await setup();
    await importContent(target.cms, dump);
    const restored = await target.cms.api.posts.findById(String(post?.id));
    expect(restored?.scheduledPatch).toEqual({ status: "published" });
  });
});

describe("the NDJSON format", () => {
  test("survives a round trip through lines", async () => {
    const { cms } = await setup();
    await cms.api.posts.create({
      data: { title: "Line", handle: "line" },
      actor,
    });

    const text = (await collect(exportContent(cms)))
      .map(serializeRecord)
      .join("");
    async function* chunks(): AsyncGenerator<string> {
      // Split mid-record on purpose: a stream does not respect line endings.
      yield text.slice(0, 11);
      yield text.slice(11);
      yield "\n\n";
    }

    const parsed = await collect(readRecords(toLines(chunks())));
    expect(parsed[0]?.kind).toBe("header");
    expect(parsed.filter((record) => record.kind === "document")).toHaveLength(1); // prettier-ignore
  });

  test("names the line it could not read", () => {
    expect(() => parseRecord("{nope}", 4)).toThrow(/Line 4 is not JSON/);
    expect(() => parseRecord("{}", 2)).toThrow(/Line 2 has no "kind"/);
    expect(() => parseRecord('{"kind":"row"}', 7)).toThrow(/unknown kind: row/);
    expect(() =>
      parseRecord('{"kind":"document","collection":"posts","data":{}}', 8),
    ).toThrow(/non-empty document/);
    expect(() =>
      parseRecord('{"kind":"global","global":"settings","data":null}', 9),
    ).toThrow(/object "data"/);
    expect(() =>
      parseRecord(
        '{"kind":"header","format":"heyo-cms/export","version":"1"}',
        10,
      ),
    ).toThrow(/invalid export header/);
  });
});
