import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineCollection, heyoCms } from "../src/config";
import { mongodb } from "../src/db/mongodb";
import { sqlite } from "../src/db/sqlite";
import { select, text } from "../src/fields";
import {
  generateMigration,
  MigrationStore,
  migrationStatus,
  runMigrations,
} from "../src/migrations";
import type { DatabaseAdapter } from "../src/types/database";
import type { SchemaSnapshot } from "../src/types/schema";
import { memoryMongo } from "./mongo-memory";

const fixture = { id: "fixture" } as unknown as DatabaseAdapter;

function schemaOf(fields: Record<string, never>): SchemaSnapshot {
  return heyoCms({
    database: fixture,
    collections: { posts: defineCollection({ fields }) },
  }).schema;
}

async function workspace(): Promise<{
  directory: string;
  store: MigrationStore;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "heyo-cms-migrations-"));
  return {
    directory,
    store: new MigrationStore(directory),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("generate", () => {
  test("writes a readable migration and records the snapshot", async () => {
    const { directory, store, cleanup } = await workspace();
    const adapter = sqlite(new Database(":memory:"));
    const schema = schemaOf({ title: text({}) } as never);

    const result = await generateMigration({ adapter, store, target: schema });
    expect(result.created).toBe(true);
    expect(result.file).toMatch(/^0000_create_schema_and_\d+_more\.sql$/);

    const sql = await readFile(join(directory, result.file as string), "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "documents"');
    // Every statement is preceded by the sentence that explains it.
    expect(sql).toContain("-- create table documents");
    expect(sql).toContain("-- create index idx_documents_collection");

    await cleanup();
  });

  test("a second generate with no changes writes nothing", async () => {
    const { store, cleanup } = await workspace();
    const adapter = sqlite(new Database(":memory:"));
    const schema = schemaOf({ title: text({}) } as never);

    await generateMigration({ adapter, store, target: schema });
    const second = await generateMigration({ adapter, store, target: schema });

    expect(second.created).toBe(false);
    expect(await store.list()).toHaveLength(1);
    await cleanup();
  });

  test("a changed field produces a migration that names the change", async () => {
    const { directory, store, cleanup } = await workspace();
    const adapter = sqlite(new Database(":memory:"));

    await generateMigration({
      adapter,
      store,
      target: schemaOf({ title: text({}) } as never),
    });
    const second = await generateMigration({
      adapter,
      store,
      target: schemaOf({
        title: text({}),
        handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
        status: select({ options: ["draft", "published"], default: "draft" }),
      } as never),
    });

    expect(second.created).toBe(true);
    expect(second.id).toBe("0001_index_documents_posts_handle_and_1_more");
    expect(second.summary).toEqual([
      "create unique index uniq_documents_posts_handle",
      'backfill posts.status = "draft"',
    ]);

    const sql = await readFile(join(directory, second.file as string), "utf8");
    expect(sql).toContain("WHERE \"collection\" = 'posts'");
    await cleanup();
  });

  test("MongoDB gets the steps instead of SQL, numbered the same way", async () => {
    const { directory, store, cleanup } = await workspace();
    const adapter = mongodb(memoryMongo());

    const result = await generateMigration({
      adapter,
      store,
      target: schemaOf({
        title: text({}),
        handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
      } as never),
    });
    expect(result.file?.endsWith(".json")).toBe(true);

    const content = JSON.parse(
      await readFile(join(directory, result.file as string), "utf8"),
    ) as { summary: string[]; steps: { kind: string }[] };
    expect(content.summary[0]).toBe("create table activity");
    expect(content.steps.some((step) => step.kind === "create_index")).toBe(
      true,
    );
    await cleanup();
  });
});

describe("migrate", () => {
  test("applies pending migrations once and remembers them", async () => {
    const { store, cleanup } = await workspace();
    const database = new Database(":memory:");
    const adapter = sqlite(database);
    const schema = schemaOf({ title: text({}) } as never);
    await generateMigration({ adapter, store, target: schema });

    const first = await runMigrations({ adapter, store });
    expect(first.applied).toHaveLength(1);

    const second = await runMigrations({ adapter, store });
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toBe(1);

    // The schema is really there, not merely recorded.
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((row) => row.name)).toContain("documents");
    await cleanup();
  });

  test("applies a MongoDB migration through the same runner", async () => {
    const { store, cleanup } = await workspace();
    const mongo = memoryMongo();
    const adapter = mongodb(mongo);
    await generateMigration({
      adapter,
      store,
      target: schemaOf({
        title: text({}),
        handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
      } as never),
    });

    await runMigrations({ adapter, store });
    const indexes = await mongo.collection("documents").listIndexes().toArray();
    expect(indexes.map((index) => index.name)).toContain(
      "uniq_documents_posts_handle",
    );
    await cleanup();
  });

  test("refuses to continue when an applied migration was edited", async () => {
    const { directory, store, cleanup } = await workspace();
    const adapter = sqlite(new Database(":memory:"));
    const result = await generateMigration({
      adapter,
      store,
      target: schemaOf({ title: text({}) } as never),
    });
    await runMigrations({ adapter, store });

    const path = join(directory, result.file as string);
    await writeFile(path, `${await readFile(path, "utf8")}\n-- edited\n`);

    // Editing an applied file puts every other environment on a different
    // schema; refusing is the only safe answer.
    await expect(runMigrations({ adapter, store })).rejects.toThrow(
      /modified after it was applied/,
    );
    await cleanup();
  });
});

describe("status", () => {
  test("reports pending files and unplanned configuration changes", async () => {
    const { store, cleanup } = await workspace();
    const adapter = sqlite(new Database(":memory:"));
    await generateMigration({
      adapter,
      store,
      target: schemaOf({ title: text({}) } as never),
    });

    const pending = await migrationStatus({ adapter, store });
    expect(pending.pending).toHaveLength(1);
    expect(pending.applied).toHaveLength(0);

    await runMigrations({ adapter, store });

    const current = await migrationStatus({
      adapter,
      store,
      target: schemaOf({
        title: text({}),
        handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
      } as never),
    });
    expect(current.applied).toHaveLength(1);
    expect(current.pending).toHaveLength(0);
    // The configuration moved on; `generate` has not run yet.
    expect(current.unplanned).toHaveLength(1);
    await cleanup();
  });
});
