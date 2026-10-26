import { describe, expect, test } from "bun:test";

import { heyoCms, defineCollection } from "../../src/config";
import { CmsError } from "../../src/errors";
import { date, media, number, select, text } from "../../src/fields";
import { and, eq, gt, orderBy } from "../../src/query";
import { planMigration } from "../../src/schema/plan";
import { emptySnapshot } from "../../src/schema/snapshot";
import type { DatabaseAdapter } from "../../src/types/database";
import type { Row, Tx } from "../../src/types/query";
import type { SchemaSnapshot } from "../../src/types/schema";

/**
 * The contract every database adapter has to satisfy.
 *
 * One suite, three engines. A feature that cannot be expressed here cannot be
 * expressed in the engine either, which is what keeps the fourth adapter a
 * translation job rather than a project (section 12). Written in stage 1,
 * before any adapter existed, so the adapters were built against it instead of
 * the other way round.
 */
export interface AdapterUnderTest {
  name: string;
  create(): Promise<DatabaseAdapter> | DatabaseAdapter;
  /** Skipped engines report why, instead of silently passing. */
  skip?: string;
}

/** The fixture schema: one content collection plus the system tables. */
export function contractSchema(): SchemaSnapshot {
  const cms = heyoCms({
    database: { id: "fixture" } as unknown as DatabaseAdapter,
    collections: {
      posts: defineCollection({
        fields: {
          title: text({ required: true }),
          handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
          status: select({
            options: ["draft", "review", "published"],
            default: "draft",
          }),
          views: number({ integer: true }),
          publishedAt: date({}),
          cover: media({}),
        },
      }),
      pages: defineCollection({
        fields: {
          title: text({ required: true }),
          handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
        },
      }),
    },
  });
  return cms.schema;
}

export function runDatabaseAdapterContract(entry: AdapterUnderTest): void {
  const suite = entry.skip ? describe.skip : describe;

  suite(`database adapter contract: ${entry.name}`, () => {
    const schema = contractSchema();

    const prepare = async (): Promise<DatabaseAdapter> => {
      const adapter = await entry.create();
      adapter.useSchema(schema);
      // The suite migrates the way a project does: plan from nothing to the
      // target, render, apply. A migration path that only the CLI exercises
      // is a migration path that breaks in the CLI.
      const steps = adapter.plan(emptySnapshot(), schema);
      await adapter.applyMigration(adapter.render(steps, "0000_contract"));
      return adapter;
    };

    const insertPost = async (
      adapter: DatabaseAdapter,
      tx: Tx,
      id: string,
      data: Record<string, unknown>,
      collection = "posts",
    ): Promise<Row> => {
      const now = new Date("2026-02-11T10:00:00.000Z");
      const result = await adapter.mutate(tx, {
        kind: "insert",
        table: "documents",
        values: {
          id,
          collection,
          data: data as Row["data"],
          created_at: now,
          updated_at: now,
          updated_by: null,
          deleted_at: null,
          purge_after: null,
          scheduled_at: null,
          scheduled_patch: null,
        },
      });
      return result.rows[0] as Row;
    };

    test("applies a generated migration and reports it as applied", async () => {
      const adapter = await prepare();
      await adapter.recordMigration("0000_contract", "abc");
      const applied = await adapter.listAppliedMigrations();
      expect(applied.map((entry) => entry.id)).toEqual(["0000_contract"]);
      expect(applied[0]?.checksum).toBe("abc");
      await adapter.close?.();
    });

    test("compares an ISO date in the document body to a timestamp", async () => {
      const adapter = await prepare();
      await adapter.transaction(async (tx) => {
        await insertPost(adapter, tx, "doc_date_before", {
          title: "Before",
          publishedAt: "2025-01-01T00:00:00.000Z",
        });
        await insertPost(adapter, tx, "doc_date_after", {
          title: "After",
          publishedAt: "2025-02-01T00:00:00.000Z",
        });

        const after = await adapter.query(tx, {
          table: "documents",
          where: and(
            eq("collection", "posts"),
            gt("publishedAt", new Date("2025-01-15T00:00:00.000Z")),
          ),
        });
        expect(after.map((row) => row.id)).toEqual(["doc_date_after"]);
      });
      await adapter.close?.();
    });

    test("round-trips a document with its JSON body and timestamps", async () => {
      const adapter = await prepare();
      await adapter.transaction(async (tx) => {
        const inserted = await insertPost(adapter, tx, "doc_1", {
          title: "Hello",
          handle: "hello",
          status: "draft",
          views: 3,
        });
        expect(inserted.id).toBe("doc_1");
        expect(inserted.data).toEqual({
          title: "Hello",
          handle: "hello",
          status: "draft",
          views: 3,
        });
        expect(inserted.created_at).toBeInstanceOf(Date);
        expect((inserted.created_at as Date).toISOString()).toBe(
          "2026-02-11T10:00:00.000Z",
        );
      });
      await adapter.close?.();
    });

    test("filters on a path inside the document body", async () => {
      const adapter = await prepare();
      await adapter.transaction(async (tx) => {
        await insertPost(adapter, tx, "doc_1", { title: "A", status: "draft", views: 1 }); // prettier-ignore
        await insertPost(adapter, tx, "doc_2", { title: "B", status: "published", views: 5 }); // prettier-ignore
        await insertPost(adapter, tx, "doc_3", { title: "C", status: "published", views: 9 }); // prettier-ignore

        const published = await adapter.query(tx, {
          table: "documents",
          where: and(eq("collection", "posts"), eq("status", "published")),
          orderBy: [orderBy("id")],
        });
        expect(published.map((row) => row.id)).toEqual(["doc_2", "doc_3"]);

        // Numbers inside an untyped body still compare as numbers.
        const popular = await adapter.query(tx, {
          table: "documents",
          where: and(eq("collection", "posts"), gt("views", 4)),
          orderBy: [orderBy("views", "desc")],
        });
        expect(popular.map((row) => row.id)).toEqual(["doc_3", "doc_2"]);
      });
      await adapter.close?.();
    });

    test("paginates, counts and projects", async () => {
      const adapter = await prepare();
      await adapter.transaction(async (tx) => {
        for (let index = 1; index <= 5; index += 1) {
          await insertPost(adapter, tx, `doc_${index}`, {
            title: `Post ${index}`,
            views: index,
          });
        }

        const page = await adapter.query(tx, {
          table: "documents",
          where: eq("collection", "posts"),
          orderBy: [orderBy("views", "asc")],
          limit: 2,
          offset: 2,
        });
        expect(page.map((row) => row.id)).toEqual(["doc_3", "doc_4"]);

        const counted = await adapter.query(tx, {
          table: "documents",
          where: eq("collection", "posts"),
          count: true,
        });
        expect(counted[0]?.count).toBe(5);

        const projected = await adapter.query(tx, {
          table: "documents",
          where: eq("id", "doc_2"),
          select: ["id", "title"],
        });
        expect(projected[0]).toEqual({ id: "doc_2", title: "Post 2" });
      });
      await adapter.close?.();
    });

    test("updates and deletes report what they touched", async () => {
      const adapter = await prepare();
      await adapter.transaction(async (tx) => {
        await insertPost(adapter, tx, "doc_1", { title: "A", status: "draft" });
        await insertPost(adapter, tx, "doc_2", { title: "B", status: "draft" });

        const updated = await adapter.mutate(tx, {
          kind: "update",
          table: "documents",
          where: eq("id", "doc_1"),
          set: {
            data: { title: "A", status: "published" },
            updated_at: new Date("2026-02-12T10:00:00.000Z"),
          },
        });
        expect(updated.count).toBe(1);
        expect(updated.rows[0]?.data).toEqual({
          title: "A",
          status: "published",
        });

        const deleted = await adapter.mutate(tx, {
          kind: "delete",
          table: "documents",
          where: eq("id", "doc_2"),
        });
        expect(deleted.count).toBe(1);

        const remaining = await adapter.query(tx, {
          table: "documents",
          where: eq("collection", "posts"),
          count: true,
        });
        expect(remaining[0]?.count).toBe(1);
      });
      await adapter.close?.();
    });

    test("enforces a unique content index per collection", async () => {
      const adapter = await prepare();
      await adapter.transaction(async (tx) => {
        await insertPost(adapter, tx, "doc_1", {
          title: "A",
          handle: "shared",
        });

        // The same handle in another collection is fine: the index is partial,
        // because every collection shares one table.
        await insertPost(
          adapter,
          tx,
          "doc_2",
          { title: "B", handle: "shared" },
          "pages",
        );

        // A 409 that names the field, not the driver's error: the index is
        // the only check that cannot race, so its answer is the response.
        const duplicate = await insertPost(adapter, tx, "doc_3", {
          title: "C",
          handle: "shared",
        }).catch((error: unknown) => error);
        expect(duplicate).toBeInstanceOf(CmsError);
        expect(duplicate).toMatchObject({
          status: 409,
          code: "conflict",
          details: {
            fields: { handle: "is already used by another document" },
          },
        });
        expect((duplicate as CmsError).message).toStartWith("posts: handle");
      });
      await adapter.close?.();
    });

    test("refuses a duplicate id with a conflict that names it", async () => {
      const adapter = await prepare();
      await adapter.transaction(async (tx) => {
        await insertPost(adapter, tx, "doc_taken", { title: "A" });
      });
      // Its own transaction: on Postgres a failed statement aborts the one
      // it ran in.
      const duplicate = await adapter
        .transaction((tx) =>
          insertPost(adapter, tx, "doc_taken", { title: "B" }),
        ) // prettier-ignore
        .catch((error: unknown) => error);
      expect(duplicate).toBeInstanceOf(CmsError);
      expect(duplicate).toMatchObject({ status: 409, code: "conflict" });
      expect((duplicate as CmsError).message).toBe(
        'A document with the id "doc_taken" already exists.',
      );
      await adapter.close?.();
    });

    test("reports its capabilities honestly", async () => {
      const adapter = await prepare();
      expect(typeof adapter.capabilities.transactions).toBe("boolean");
      expect(typeof adapter.capabilities.sqlMigrations).toBe("boolean");
      expect(adapter.capabilities.jsonQuery).toBe(true);
      await adapter.close?.();
    });

    test("rolls a transaction back, when it has transactions", async () => {
      const adapter = await prepare();
      if (!adapter.capabilities.transactions) {
        // Declaring the limitation is the contract; emulating it is not.
        await adapter.close?.();
        return;
      }

      await expect(
        adapter.transaction(async (tx) => {
          await insertPost(adapter, tx, "doc_rollback", { title: "Gone" });
          throw new Error("no");
        }),
      ).rejects.toThrow("no");

      await adapter.transaction(async (tx) => {
        const rows = await adapter.query(tx, {
          table: "documents",
          where: eq("id", "doc_rollback"),
        });
        expect(rows).toHaveLength(0);
      });
      await adapter.close?.();
    });

    test("introspection sees the tables the migration created", async () => {
      const adapter = await prepare();
      const live = await adapter.introspect();
      const names = live.tables.map((table) => table.name);
      expect(names).toContain("documents");
      expect(names).toContain("media");
      // The journal is the adapter's own bookkeeping and must never show up
      // in a diff.
      expect(names).not.toContain("cms_migrations");
      await adapter.close?.();
    });

    test("a second plan against the same schema is empty", async () => {
      const adapter = await prepare();
      expect(planMigration(schema, schema)).toEqual([]);
      await adapter.close?.();
    });
  });
}
