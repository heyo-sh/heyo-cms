import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { main } from "../src/cli";

/**
 * The CLI from the outside.
 *
 * `generate`, `migrate` and `status` are the schema commands, and the absence
 * of a `push` is the point: a schema that can change without leaving a file in
 * the repository is the Payload-on-Postgres complaint the plan is answering.
 *
 * The rest are the commands a project needs on its first day and on the day it
 * moves — an administrator, a seed, and content that can leave as easily as it
 * arrived.
 */
describe("heyo-cms CLI", () => {
  let directory: string;
  let logs: string[];
  let errors: string[];
  const log = console.log;
  const error = console.error;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "heyo-cms-cli-"));
    logs = [];
    errors = [];
    console.log = (...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    };
    console.error = (...parts: unknown[]) => {
      errors.push(parts.map(String).join(" "));
    };
  });

  afterEach(async () => {
    console.log = log;
    console.error = error;
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
import { select, text } from ${JSON.stringify(join(source, "fields.ts"))};
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
import { text } from ${JSON.stringify(join(source, "fields.ts"))};
import { sqlite } from ${JSON.stringify(join(source, "db/sqlite.ts"))};

const database = new Database(${JSON.stringify(join(directory, "cms.sqlite"))});

export const cms = heyoCms({
  database: () => sqlite(database),
  migrations: { directory: ${JSON.stringify(join(directory, "migrations"))} },
  collections: {
    posts: defineCollection({
      fields: { title: text({ required: true }), handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }) },
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

  // -------------------------------------------------------------------------
  // The first account, the seed, and content
  // -------------------------------------------------------------------------

  /**
   * A project as the generator produces one: collections, a global, editor
   * authentication and a seed module, all on a file-backed SQLite so two
   * commands in a row see the same database.
   */
  const writeProject = async (name: string): Promise<string> => {
    const source = resolve(import.meta.dirname, "..", "src");
    const file = join(directory, `${name}.config.ts`);
    await writeFile(
      file,
      `
import { Database } from "bun:sqlite";
import { defineCollection, defineGlobal, heyoCms } from ${JSON.stringify(join(source, "config.ts"))};
import { cmsUsers } from ${JSON.stringify(join(source, "auth.ts"))};
import { select, text } from ${JSON.stringify(join(source, "fields.ts"))};
import { sqlite } from ${JSON.stringify(join(source, "db/sqlite.ts"))};

const database = new Database(${JSON.stringify(join(directory, `${name}.sqlite`))});

export const cms = heyoCms({
  database: () => sqlite(database),
  migrations: { directory: ${JSON.stringify(join(directory, name))} },
  admin: { auth: cmsUsers({ methods: ["password"] }) },
  telemetry: { enabled: false },
  collections: {
    posts: defineCollection({
      fields: {
        title: text({ required: true, localized: true }),
        handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
        status: select({ options: ["draft", "published"], default: "draft" }),
      },
    }),
  },
  globals: {
    settings: defineGlobal({ fields: { siteName: text({ default: "Acme" }) } }),
  },
});
`,
      "utf8",
    );
    expect(await main(["generate", "--config", file])).toBe(0);
    expect(await main(["migrate", "--config", file])).toBe(0);
    logs.length = 0;
    return file;
  };

  test("create-admin makes an account and prints its password once", async () => {
    const config = await writeProject("admin");

    expect(
      await main(["create-admin", "--config", config, "--email", "ada@example.com"]), // prettier-ignore
    ).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Created ada@example.com");
    expect(output).toContain("Password:");
    expect(output).toContain("/api/heyo-cms/admin");

    // The second attempt refuses rather than resetting a credential: this is
    // the one command that runs with the database's full authority.
    logs.length = 0;
    expect(
      await main(["create-admin", "--config", config, "--email", "ada@example.com"]), // prettier-ignore
    ).toBe(1);
    expect(errors.join("\n")).toContain("already has an account");
  });

  test("create-admin needs an address", async () => {
    const config = await writeProject("admin-email");
    expect(await main(["create-admin", "--config", config])).toBe(1);
    expect(errors.join("\n")).toContain("An address is required");
  });

  test("seed runs the project's own module", async () => {
    const config = await writeProject("seed");
    const seed = join(directory, "heyo-cms.seed.ts");
    await writeFile(
      seed,
      `
export async function seed(cms) {
  await cms.api.posts.create({
    data: { title: "Seeded", handle: "seeded", status: "published" },
    actor: { id: "seed", source: "session", roles: ["admin"], permissions: ["*"] },
    source: "cli",
  });
}
`,
      "utf8",
    );

    expect(await main(["seed", "--config", config, "--file", seed])).toBe(0);
    expect(logs.join("\n")).toContain("Seeded from");

    // And the document is really there, which `export` is the cheapest way to
    // assert from outside the process.
    const dump = join(directory, "seeded.ndjson");
    expect(await main(["export", "--config", config, "--out", dump])).toBe(0);
    expect(await readFile(dump, "utf8")).toContain("Seeded");
  });

  test("seed explains a module that exports nothing runnable", async () => {
    const config = await writeProject("seed-empty");
    const seed = join(directory, "empty.seed.ts");
    await writeFile(seed, "export const nothing = 1;\n", "utf8");
    expect(await main(["seed", "--config", config, "--file", seed])).toBe(1);
    expect(errors.join("\n")).toContain("does not export a seed");
  });

  test("export and import move content between two databases", async () => {
    const from = await writeProject("from");
    const seed = join(directory, "move.seed.ts");
    await writeFile(
      seed,
      `
const actor = { id: "seed", source: "session", roles: ["admin"], permissions: ["*"] };
export async function seed(cms) {
  const post = await cms.api.posts.create({
    data: { title: "Travelling", handle: "travelling", status: "published" },
    actor,
  });
  await cms.api.posts.update({ id: post.id, data: { title: "W podróży" }, locale: "pl", actor });
  await cms.globals.settings.update({ data: { siteName: "Moved" }, actor });
}
`,
      "utf8",
    );
    expect(await main(["seed", "--config", from, "--file", seed])).toBe(0);

    const dump = join(directory, "content.ndjson");
    expect(await main(["export", "--config", from, "--out", dump])).toBe(0);
    expect(errors.join("\n")).toContain("Exported 1 document(s)");

    const text = await readFile(dump, "utf8");
    const header = JSON.parse(text.split("\n")[0] as string) as {
      format: string;
    };
    expect(header.format).toBe("heyo-cms/export");
    // Both languages are in the file, which is the whole reason the export
    // reads rows rather than documents.
    expect(text).toContain("W podróży");

    const to = await writeProject("to");
    logs.length = 0;
    expect(await main(["import", dump, "--config", to])).toBe(0);
    expect(logs.join("\n")).toContain("Imported 1 new");

    // Importing the same file again changes nothing: the default is to skip
    // what is already there, because an import is usually a restore.
    logs.length = 0;
    expect(await main(["import", dump, "--config", to])).toBe(0);
    expect(logs.join("\n")).toContain("Skipped 1 document(s)");
  });

  test("import refuses a missing file and an unknown conflict mode", async () => {
    const config = await writeProject("import-args");
    expect(await main(["import", "--config", config])).toBe(1);
    expect(errors.join("\n")).toContain("A file is required");

    errors.length = 0;
    expect(
      await main(["import", "x.ndjson", "--config", config, "--on-conflict", "merge"]), // prettier-ignore
    ).toBe(1);
    expect(errors.join("\n")).toContain("--on-conflict takes");
  });

  test("telemetry prints the exact body it would send", async () => {
    const config = await writeProject("telemetry");
    expect(await main(["telemetry", "--config", config])).toBe(0);

    const output = logs.join("\n");
    expect(output).toContain("Telemetry: off");
    expect(output).toContain("HEYO_TELEMETRY_DISABLED=1");

    const body = /^\{\n {2}"event"[\s\S]*?\n\}$/m.exec(output)?.[0] ?? "";
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload.event).toBe("telemetry");
    expect(payload.usage).toMatchObject({ collections: 1, globals: 1 });
    // The claim the command exists to make: nothing a project named is in it.
    expect(body).not.toContain("posts");
    expect(body).not.toContain(directory);
  });
});
