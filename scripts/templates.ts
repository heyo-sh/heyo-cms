#!/usr/bin/env bun
/**
 * The initial migration that ships with every database layer of the
 * generator.
 *
 *   bun run templates            # rewrite them from the template config
 *   bun run templates --check    # fail if they have drifted
 *
 * A generated project has to be able to run `db:migrate` before it can run
 * anything else, so `databases/<database>/migrations/` is checked in. The
 * file is a function of two things — the collections in the template's
 * `heyo-cms.config.ts` and the database's dialect — and both of them live in
 * this repository, so a hand-written copy would drift the first time somebody
 * added a field to the template. This writes it instead, and `--check` is
 * part of the test suite.
 *
 * Nothing here touches a network or a database: `plan()` diffs two snapshots
 * and `render()` turns steps into a file, so the adapters are built over
 * drivers that answer nothing.
 */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scaffoldProject } from "../packages/create-heyo-cms/src/scaffold";
import type { Database } from "../packages/create-heyo-cms/src/types";
import { d1 } from "../packages/heyo-cms/src/db/d1";
import { mongodb } from "../packages/heyo-cms/src/db/mongodb";
import { postgres } from "../packages/heyo-cms/src/db/postgres";
import {
  generateMigration,
  MigrationStore,
} from "../packages/heyo-cms/src/migrations";
import type { DatabaseAdapter } from "../packages/heyo-cms/src/types/database";
import type { CmsInstance } from "../packages/heyo-cms/src/types/instance";

const repositoryRoot = join(import.meta.dirname, "..");
const generatorRoot = join(repositoryRoot, "packages", "create-heyo-cms");

/** The framework is irrelevant to the schema; one of them stands for all. */
const template = "next" as const;

export interface TemplateMigration {
  database: Database;
  /** `0000_init.sql`, `0000_init.json`, or `meta/snapshot.json`. */
  file: string;
  contents: string;
}

/**
 * Builds the migration each database layer should ship.
 *
 * The configuration is read from a real scaffold rather than from the
 * template directory directly: the template is a file with `{{DATABASE_CONFIG}}`
 * in it, and only a scaffold has the layers substituted in. Checking the
 * assembled project is also the point — this is the file a reader will have.
 */
export async function buildTemplateMigrations(): Promise<TemplateMigration[]> {
  const workspace = await mkdtemp(join(tmpdir(), "heyo-cms-templates-"));
  await linkWorkspacePackages(workspace);

  try {
    const results: TemplateMigration[] = [];
    for (const [database, adapter] of Object.entries(adapters())) {
      const { projectPath } = await scaffoldProject({
        projectName: `template-${database}`,
        template,
        // D1 only exists on Cloudflare; the others are the same schema either
        // way, so the deployment is chosen to be the legal one.
        deployment: database === "d1" ? "cloudflare" : "vercel",
        database: database as Database,
        storage: database === "d1" ? "r2" : "local",
        packageManager: "bun",
        install: false,
        cwd: workspace,
        heyoCmsVersion: "workspace:*",
      });

      const cms = await loadConfig(projectPath);
      const directory = join(projectPath, "migrations");
      // The scaffold just copied the committed migrations in. They are what
      // is being rebuilt, so the generator has to start from nothing — not
      // from its own previous answer.
      await rm(directory, { recursive: true, force: true });
      const store = new MigrationStore(directory);
      const result = await generateMigration({
        adapter,
        store,
        target: cms.schema,
        name: "init",
      });
      if (!result.created || !result.file) {
        throw new Error(`the ${database} template produced no migration`);
      }

      // `meta/snapshot.json` ships with them, and it is not an implementation
      // detail: `generate` diffs the configuration against that file, so a
      // project without one would be told to create every table again the
      // first time it added a field.
      for (const file of [
        ...(await readdir(directory)).filter((name) => name !== "meta"),
        join("meta", "snapshot.json"),
      ]) {
        results.push({
          database: database as Database,
          file,
          contents: await readFile(join(directory, file), "utf8"),
        });
      }
    }
    return results;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Writes them into the generator package. Returns what it wrote. */
export async function writeTemplateMigrations(): Promise<TemplateMigration[]> {
  const migrations = await buildTemplateMigrations();
  for (const database of new Set(migrations.map((entry) => entry.database))) {
    await rm(join(generatorRoot, "databases", database, "migrations"), {
      recursive: true,
      force: true,
    });
  }
  for (const migration of migrations) {
    await Bun.write(
      join(
        generatorRoot,
        "databases",
        migration.database,
        "migrations",
        migration.file,
      ),
      migration.contents,
    );
  }
  return migrations;
}

/** What has drifted, in sentences. Empty means the checked-in files are right. */
export async function checkTemplateMigrations(): Promise<string[]> {
  const problems: string[] = [];
  for (const migration of await buildTemplateMigrations()) {
    const path = join(
      generatorRoot,
      "databases",
      migration.database,
      "migrations",
      migration.file,
    );
    const committed = await readFile(path, "utf8").catch(() => undefined);
    if (committed === undefined) {
      problems.push(`${migration.database}: ${migration.file} is missing`);
      continue;
    }
    if (committed !== migration.contents) {
      problems.push(
        `${migration.database}: ${migration.file} no longer matches the template configuration`,
      );
    }
  }
  return problems;
}

/**
 * Adapters that can plan and render, and do nothing else.
 *
 * `plan()` compares two snapshots and `render()` serialises steps; neither
 * reads a row. The drivers below exist only because the constructors want
 * one, which is also why they are unreachable: if a future `render()` ever
 * needed to ask the database something, this would throw rather than
 * silently writing a migration against an empty answer.
 */
function adapters(): Record<string, DatabaseAdapter> {
  const unreachable = (): never => {
    throw new Error("rendering a migration must not touch the database");
  };

  return {
    postgres: postgres({ query: unreachable }),
    d1: d1({ prepare: unreachable }),
    mongodb: mongodb({
      collection: unreachable,
      listCollections: unreachable,
      createCollection: unreachable,
      dropCollection: unreachable,
    }),
  };
}

/**
 * Makes `@heyo-sh/*` resolve to this repository's sources.
 *
 * A scaffolded project in a temporary directory has no `node_modules`, and
 * installing one would make this script take a minute and need a network. So
 * it gets a `node_modules` holding two shim packages, each one re-exporting
 * the real `src` through the same subpaths the published package offers —
 * read from its own `exports` map, so an entry point added there is
 * resolvable here without a change.
 *
 * Pointing at `src` rather than `dist` is deliberate: this must also work in
 * a checkout nobody has built yet, which is the state a test runs in.
 */
async function linkWorkspacePackages(workspace: string): Promise<void> {
  for (const name of ["heyo-cms", "heyo-cms-admin"]) {
    const root = join(repositoryRoot, "packages", name);
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { name: string; exports: Record<string, { default: string }> };

    const shim = join(workspace, "node_modules", "@heyo-sh", name);
    await mkdir(shim, { recursive: true });
    const exports: Record<string, string> = {};

    for (const [subpath, entry] of Object.entries(manifest.exports)) {
      const source = join(
        root,
        entry.default.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"),
      );
      const file = `${subpath === "." ? "index" : subpath.slice(2).replaceAll("/", "__")}.ts`; // prettier-ignore
      await Bun.write(
        join(shim, file),
        `export * from ${JSON.stringify(source)};\n`,
      );
      exports[subpath] = `./${file}`;
    }

    await Bun.write(
      join(shim, "package.json"),
      `${JSON.stringify({ name: manifest.name, type: "module", exports }, null, 2)}\n`,
    );
  }
}

async function loadConfig(projectPath: string): Promise<CmsInstance> {
  const module = (await import(join(projectPath, "heyo-cms.config.ts"))) as {
    cms: CmsInstance;
  };
  return module.cms;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  if (check) {
    const problems = await checkTemplateMigrations();
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    if (problems.length > 0) {
      console.error('\n  Run "bun run templates" to rewrite them.\n');
      process.exitCode = 1;
    } else {
      console.log("  ✓ the shipped migrations match the template configuration"); // prettier-ignore
    }
  } else {
    for (const migration of await writeTemplateMigrations()) {
      console.log(`  wrote databases/${migration.database}/migrations/${migration.file}`); // prettier-ignore
    }
  }
}
