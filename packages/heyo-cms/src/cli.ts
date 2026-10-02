#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  generateMigration,
  MigrationStore,
  migrationStatus,
  runMigrations,
} from "./migrations";
import type { CmsInstance } from "./types/instance";

/**
 * `heyo-cms generate | migrate | status`.
 *
 * There is no `push`. A schema that can be changed without leaving a file
 * behind is a schema nobody can review, roll back or reproduce — and it is
 * the single loudest complaint about running Payload on Postgres (section 0).
 */
const usage = `
  heyo-cms generate [--name <name>]   write a migration for what changed
  heyo-cms migrate                    apply pending migrations
  heyo-cms status                     show applied, pending and unplanned changes

  --config <path>   configuration module (default: ./heyo-cms.config.ts)
  --dir <path>      migrations directory (default: the one in the config)
`;

export async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArguments(argv);

  if (!command || command === "help" || flags.has("--help")) {
    console.log(usage);
    return command && command !== "help" ? 1 : 0;
  }

  const cms = await loadConfig(flags.get("--config"));
  const directory = resolve(
    flags.get("--dir") ?? cms._config.migrationsDirectory,
  );
  const store = new MigrationStore(directory);
  const adapter = await cms.database();

  switch (command) {
    case "generate": {
      const result = await generateMigration({
        adapter,
        store,
        target: cms.schema,
        ...(flags.get("--name") ? { name: flags.get("--name") as string } : {}),
      });
      if (!result.created) {
        console.log("No schema changes. Nothing to generate.");
        return 0;
      }
      console.log(`Wrote ${result.file}`);
      for (const line of result.summary) console.log(`  ${line}`);
      return 0;
    }

    case "migrate": {
      const result = await runMigrations({ adapter, store });
      if (result.applied.length === 0) {
        console.log(
          `Up to date (${result.alreadyApplied} migration(s) already applied).`,
        );
        return 0;
      }
      for (const id of result.applied) console.log(`Applied ${id}`);
      return 0;
    }

    case "status": {
      const status = await migrationStatus({
        adapter,
        store,
        target: cms.schema,
      });
      console.log(`Applied:  ${status.applied.length}`);
      for (const id of status.pending) console.log(`  pending  ${id}`);
      for (const id of status.modified) {
        console.log(`  MODIFIED ${id} (applied, then edited)`);
      }
      if (status.unplanned.length > 0) {
        console.log(
          `  ${status.unplanned.length} change(s) in the configuration have no migration yet; run "heyo-cms generate".`,
        );
      }
      // A database behind the repository, or a file edited after it ran, is a
      // failed check — CI has to notice without reading the output.
      return status.pending.length > 0 ||
        status.modified.length > 0 ||
        status.unplanned.length > 0
        ? 1
        : 0;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(usage);
      return 1;
  }
}

function parseArguments(argv: string[]): {
  command: string | undefined;
  flags: Map<string, string>;
} {
  const flags = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(argument, next);
      index += 1;
    } else {
      flags.set(argument, "true");
    }
  }

  return { command: positionals[0], flags };
}

const candidates = [
  "heyo-cms.config.ts",
  "heyo-cms.config.js",
  "heyo-cms.config.mjs",
  "src/heyo-cms.config.ts",
  "app/heyo-cms.config.ts",
];

/**
 * Loads the configuration module.
 *
 * The export may be named `cms` or be the default: both read naturally at the
 * call site, and guessing wrong would make the CLI fail with a type error
 * instead of a sentence.
 */
async function loadConfig(path: string | undefined): Promise<CmsInstance> {
  const file = path ? resolve(path) : await findConfig();
  const module = (await import(
    isAbsolute(file) ? pathToFileURL(file).href : file
  )) as Record<string, unknown>;

  const candidate = module.cms ?? module.default;
  if (!isCmsInstance(candidate)) {
    throw new Error(
      `${file} does not export a CMS. Add \`export const cms = heyoCms({ ... })\`.`,
    );
  }
  return candidate;
}

async function findConfig(): Promise<string> {
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    try {
      await stat(absolute);
      return absolute;
    } catch {
      // Keep looking; a missing candidate is the normal case.
    }
  }
  throw new Error(
    `No configuration found. Looked for ${candidates.join(", ")}. Use --config.`,
  );
}

function isCmsInstance(value: unknown): value is CmsInstance {
  return (
    typeof value === "object" &&
    value !== null &&
    "_config" in value &&
    "schema" in value &&
    typeof (value as CmsInstance).database === "function"
  );
}

// `import.meta.main` is true only when this file is the entry point, so the
// module stays importable from tests without running the CLI.
if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
