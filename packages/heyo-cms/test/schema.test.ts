import { describe, expect, test } from "bun:test";

import { defineCollection, heyoCms } from "../src/config";
import { boolean, number, select, text } from "../src/fields";
import { describeStep, migrationName } from "../src/schema/describe";
import { planMigration, stableStringify } from "../src/schema/plan";
import { emptySnapshot } from "../src/schema/snapshot";
import { systemTableNames } from "../src/schema/system";
import type { DatabaseAdapter } from "../src/types/database";
import type { SchemaSnapshot } from "../src/types/schema";

const database = { id: "fixture" } as unknown as DatabaseAdapter;

function schemaOf(fields: Record<string, never>): SchemaSnapshot {
  return heyoCms({
    database,
    collections: { posts: defineCollection({ fields }) },
  }).schema;
}

describe("schema snapshot", () => {
  test("declares every system collection the plan lists", () => {
    const names = systemTableNames();
    for (const table of [
      "documents",
      "cms_users",
      "cms_sessions",
      "cms_api_keys",
      "cms_roles",
      "media",
      "media_usages",
      "webhooks",
      "webhook_deliveries",
      "outbox",
      "activity",
      "jobs",
    ]) {
      expect(names).toContain(table);
    }
  });

  test("is deterministic: the same configuration produces the same bytes", () => {
    const first = schemaOf({
      title: text({}),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
    } as never);
    const second = schemaOf({
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
      title: text({}),
    } as never);
    // Field order in the configuration must not reach the snapshot, or a
    // reordered file would generate an empty migration.
    expect(stableStringify(first)).toBe(stableStringify(second));
  });

  test("records the logical fields behind the JSON body", () => {
    const schema = schemaOf({
      title: text({ required: true }),
      status: select({ options: ["draft", "published"], default: "draft" }),
    } as never);
    const posts = schema.collections.find((entry) => entry.name === "posts");

    expect(posts?.table).toBe("documents");
    expect(posts?.documentColumn).toBe("data");
    expect(posts?.fields.map((field) => field.name)).toEqual([
      "status",
      "title",
    ]);
    expect(
      posts?.fields.find((field) => field.name === "status")?.default,
    ).toBe("draft");
  });
});

describe("planMigration", () => {
  test("creates everything from an empty database", () => {
    const schema = schemaOf({ title: text({}) } as never);
    const steps = planMigration(emptySnapshot(), schema);

    const created = steps.filter((step) => step.kind === "create_table");
    expect(created).toHaveLength(schema.tables.length);
    // A table is never created before the table its foreign key points at.
    const order = created.map((step) =>
      step.kind === "create_table" ? step.table.name : "",
    );
    expect(order.indexOf("cms_users")).toBeLessThan(
      order.indexOf("cms_sessions"),
    );
    expect(order.indexOf("media")).toBeLessThan(order.indexOf("media_usages"));
  });

  test("an unchanged configuration plans nothing", () => {
    const schema = schemaOf({
      title: text({}),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
    } as never);
    expect(planMigration(schema, schema)).toEqual([]);
  });

  test("adding an indexed field is one readable index step", () => {
    const before = schemaOf({ title: text({}) } as never);
    const after = schemaOf({
      title: text({}),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
    } as never);

    const steps = planMigration(before, after);
    expect(steps.map(describeStep)).toEqual([
      "create unique index uniq_documents_posts_handle",
    ]);
    // Content lives in the document body, so no table changed at all.
    expect(steps.some((step) => step.kind === "add_column")).toBe(false);
  });

  test("adding a field with a default backfills existing documents", () => {
    const before = schemaOf({ title: text({}) } as never);
    const after = schemaOf({
      title: text({}),
      status: select({ options: ["draft", "published"], default: "draft" }),
    } as never);

    const steps = planMigration(before, after);
    expect(steps.map(describeStep)).toEqual([
      'backfill posts.status = "draft"',
    ]);
    expect(steps[0]).toMatchObject({
      kind: "set_document_field",
      table: "documents",
      collection: "posts",
      documentColumn: "data",
      path: ["status"],
      value: "draft",
    });
  });

  test("removing a field removes it from stored documents", () => {
    const before = schemaOf({ title: text({}), draft: boolean({}) } as never);
    const after = schemaOf({ title: text({}) } as never);

    expect(planMigration(before, after).map(describeStep)).toEqual([
      "remove posts.draft from stored documents",
    ]);
  });

  test("changing a default re-backfills, changing nothing else does not", () => {
    const before = schemaOf({
      status: select({ options: ["draft", "published"], default: "draft" }),
    } as never);
    const after = schemaOf({
      status: select({ options: ["draft", "published"], default: "published" }),
    } as never);

    expect(planMigration(before, after).map(describeStep)).toEqual([
      'backfill posts.status = "published"',
    ]);
  });

  test("a new collection reuses the documents table and adds its indexes", () => {
    const before = heyoCms({
      database,
      collections: { posts: defineCollection({ fields: { title: text({}) } }) },
    }).schema;
    const after = heyoCms({
      database,
      collections: {
        posts: defineCollection({ fields: { title: text({}) } }),
        pages: defineCollection({
          fields: {
            title: text({}),
            handle: text({
              unique: true,
              index: true,
              pattern: "^[a-z0-9-]+$",
            }),
          },
        }),
      },
    }).schema;

    const steps = planMigration(before, after);
    expect(steps.map(describeStep)).toEqual([
      "create unique index uniq_documents_pages_handle",
    ]);
  });

  test("steps are grouped into phases, not emitted in discovery order", () => {
    const before = schemaOf({
      title: text({}),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
      legacy: number({}),
    } as never);
    const after = schemaOf({
      title: text({}),
      views: number({ index: true }),
      status: select({ options: ["draft"], default: "draft" }),
    } as never);

    const kinds = planMigration(before, after).map((step) => step.kind);
    // Indexes are dropped before new ones are created, and backfills run last.
    expect(kinds).toEqual([
      "drop_index",
      "create_index",
      "set_document_field",
      "unset_document_field",
      "unset_document_field",
    ]);
  });

  test("a dropped collection never deletes its documents", () => {
    const before = heyoCms({
      database,
      collections: {
        posts: defineCollection({ fields: { title: text({}) } }),
        pages: defineCollection({ fields: { title: text({}) } }),
      },
    }).schema;
    const after = heyoCms({
      database,
      collections: { posts: defineCollection({ fields: { title: text({}) } }) },
    }).schema;

    // Commenting out a block of configuration is not a request to delete data.
    expect(planMigration(before, after)).toEqual([]);
  });
});

describe("migrationName", () => {
  test("names a migration after what it does", () => {
    const schema = schemaOf({ title: text({}) } as never);
    expect(migrationName(planMigration(emptySnapshot(), schema))).toMatch(
      /^create_schema_and_\d+_more$/,
    );

    const before = schemaOf({ title: text({}) } as never);
    const after = schemaOf({
      title: text({}),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
    } as never);
    expect(migrationName(planMigration(before, after))).toBe(
      "index_documents_posts_handle",
    );
  });
});
