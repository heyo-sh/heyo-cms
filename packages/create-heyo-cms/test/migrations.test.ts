import { describe, expect, test } from "bun:test";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkTemplateMigrations } from "../../../scripts/templates";
import { scaffoldProject } from "../src/scaffold";
import { databases } from "../src/types";

/**
 * The migration every generated project starts from.
 *
 * It is checked in so that `db:migrate` works before anything else does, and
 * it is a function of the template's collections and the database's dialect —
 * both of which live in this repository. So it is generated rather than
 * written, and this is the test that notices when somebody edits the template
 * configuration and forgets.
 */
describe("the shipped initial migration", () => {
  test("is what the template configuration implies, on every database", async () => {
    const problems = await checkTemplateMigrations();
    expect(problems).toEqual([]);
  }, 30_000);

  test("lands in the project, with the snapshot `generate` diffs against", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heyo-cms-migrations-"));
    try {
      for (const database of databases) {
        const { projectPath } = await scaffoldProject({
          projectName: `m-${database}`,
          template: "astro",
          deployment: database === "d1" ? "cloudflare" : "vercel",
          database,
          storage: database === "d1" ? "r2" : "local",
          packageManager: "bun",
          install: false,
          cwd: directory,
        });

        const migrations = join(projectPath, "migrations");
        const files = await readdir(migrations);
        expect(files).toContain(
          database === "mongodb" ? "0000_init.json" : "0000_init.sql",
        );

        // Without the snapshot, the first `heyo-cms generate` in a project
        // would propose creating every table a second time.
        const snapshot = JSON.parse(
          await readFile(join(migrations, "meta/snapshot.json"), "utf8"),
        ) as { tables: { name: string }[] };
        const tables = snapshot.tables.map((table) => table.name);
        expect(tables).toContain("documents");
        expect(tables).toContain("cms_users");
        expect(tables).toContain("media");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("says which engine wrote it: SQL for two, steps for Mongo", async () => {
    const postgres = await readFile(
      join(import.meta.dirname, "../databases/postgres/migrations/0000_init.sql"), // prettier-ignore
      "utf8",
    );
    expect(postgres).toContain("jsonb");
    expect(postgres).toContain("timestamptz");

    const d1 = await readFile(
      join(import.meta.dirname, "../databases/d1/migrations/0000_init.sql"),
      "utf8",
    );
    // SQLite has neither, which is the whole reason the adapter renders and
    // the engine does not.
    expect(d1).not.toContain("jsonb");
    expect(d1).not.toContain("timestamptz");

    const mongo = JSON.parse(
      await readFile(
        join(import.meta.dirname, "../databases/mongodb/migrations/0000_init.json"), // prettier-ignore
        "utf8",
      ),
    ) as { steps: { kind: string }[] };
    // No DDL in Mongo, but plenty to version: collections and indexes.
    expect(mongo.steps.some((step) => step.kind === "create_index")).toBe(true);
  });
});
