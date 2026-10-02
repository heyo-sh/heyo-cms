import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { main } from "../src/cli";

/**
 * The CLI from the outside.
 *
 * `generate`, `migrate` and `status` are the only commands, and the absence of
 * a fourth is the point: a `push` mode would let a schema change without
 * leaving a file in the repository, which is the Payload-on-Postgres
 * complaint the plan is answering.
 */
describe("heyo-cms CLI", () => {
  let directory: string;
  let logs: string[];
  const log = console.log;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "heyo-cms-cli-"));
    logs = [];
    console.log = (...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    };
  });

  afterEach(async () => {
    console.log = log;
    await rm(directory, { recursive: true, force: true });
  });

  const writeConfig = async (fields: string): Promise<string> => {
    const source = resolve(import.meta.dirname, "..", "src");
    const file = join(directory, "heyo-cms.config.ts");
    await writeFile(
      file,
      `
import { Database } from "bun:sqlite";
import { defineCollection, heyoCms } from ${JSON.stringify(join(source, "config.ts"))};
import { select, slug, text } from ${JSON.stringify(join(source, "fields.ts"))};
import { sqlite } from ${JSON.stringify(join(source, "db/sqlite.ts"))};

const database = new Database(${JSON.stringify(join(directory, "cms.sqlite"))});

export const cms = heyoCms({
  database: () => sqlite(database),
  migrations: { directory: ${JSON.stringify(join(directory, "migrations"))} },
  collections: {
    posts: defineCollection({ fields: { ${fields} } }),
  },
});
`,
      "utf8",
    );
    return file;
  };

  test("generate, migrate and status walk a schema change end to end", async () => {
    const config = await writeConfig("title: text({ required: true })");

    expect(await main(["generate", "--config", config])).toBe(0);
    expect(logs.join("\n")).toContain("create table documents");

    const files = await readdir(join(directory, "migrations"));
    expect(files.filter((file) => file.endsWith(".sql"))).toHaveLength(1);

    // Before migrating, the repository is ahead of the database.
    expect(await main(["status", "--config", config])).toBe(1);

    expect(await main(["migrate", "--config", config])).toBe(0);
    expect(logs.join("\n")).toMatch(/Applied 0000_/);

    expect(await main(["status", "--config", config])).toBe(0);
  });

  test("generate says so when there is nothing to generate", async () => {
    const config = await writeConfig("title: text({ required: true })");
    await main(["generate", "--config", config]);
    logs.length = 0;

    expect(await main(["generate", "--config", config])).toBe(0);
    expect(logs.join("\n")).toContain("No schema changes");
  });

  test("status fails when the configuration has no migration yet", async () => {
    const first = await writeConfig("title: text({ required: true })");
    await main(["generate", "--config", first]);
    await main(["migrate", "--config", first]);

    // Rewriting the module is not enough: the import cache would hand back the
    // first version, so the second configuration gets its own file.
    const second = join(directory, "heyo-cms.config.second.ts");
    const source = resolve(import.meta.dirname, "..", "src");
    await writeFile(
      second,
      `
import { Database } from "bun:sqlite";
import { defineCollection, heyoCms } from ${JSON.stringify(join(source, "config.ts"))};
import { slug, text } from ${JSON.stringify(join(source, "fields.ts"))};
import { sqlite } from ${JSON.stringify(join(source, "db/sqlite.ts"))};

const database = new Database(${JSON.stringify(join(directory, "cms.sqlite"))});

export const cms = heyoCms({
  database: () => sqlite(database),
  migrations: { directory: ${JSON.stringify(join(directory, "migrations"))} },
  collections: {
    posts: defineCollection({
      fields: { title: text({ required: true }), handle: slug({}) },
    }),
  },
});
`,
      "utf8",
    );

    logs.length = 0;
    expect(await main(["status", "--config", second])).toBe(1);
    expect(logs.join("\n")).toContain('run "heyo-cms generate"');
  });

  test("prints usage and refuses an unknown command", async () => {
    expect(await main([])).toBe(0);
    expect(logs.join("\n")).toContain("heyo-cms generate");

    const config = await writeConfig("title: text({ required: true })");
    expect(await main(["push", "--config", config])).toBe(1);
  });

  test("explains a configuration module that exports nothing usable", async () => {
    const file = join(directory, "not-a-config.ts");
    await writeFile(file, "export const other = 1;\n", "utf8");
    await expect(main(["status", "--config", file])).rejects.toThrow(
      /does not export a CMS/,
    );
  });
});
