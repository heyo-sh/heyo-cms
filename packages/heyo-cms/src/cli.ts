#!/usr/bin/env node
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

import { exportContent } from "./content/export";
import { importContent, type ImportOptions } from "./content/import";
import { readRecords, serializeRecord, toLines } from "./content/records";
import {
  generateMigration,
  MigrationStore,
  migrationStatus,
  runMigrations,
} from "./migrations";
import { reportTelemetry, telemetryDecision, telemetryPayload } from "./telemetry"; // prettier-ignore
import type { CmsInstance } from "./types/instance";

/**
 * `heyo-cms generate | migrate | status | create-admin | seed | export |
 * import | telemetry`.
 *
 * There is no `push`. A schema that can be changed without leaving a file
 * behind is a schema nobody can review, roll back or reproduce — and it is
 * the single loudest complaint about running Payload on Postgres (section 0).
 *
 * The commands after `status` are the ones a project needs on its first day
 * and on the day it moves: an administrator to sign in as, a seed to look at,
 * and content that can leave as easily as it arrived. Export and import being
 * first-class is a deliberate answer to the CMS they are migrating from, where
 * it is not.
 */
const usage = `
  heyo-cms generate [--name <name>]   write a migration for what changed
  heyo-cms migrate                    apply pending migrations
  heyo-cms status                     show applied, pending and unplanned changes

  heyo-cms create-admin               create an editor account from a shell
    --email <address>   required unless HEYO_CMS_ADMIN_EMAIL is set
    --password <value>  default: generated and printed once
    --name <name>       display name
    --roles <a,b>       default: admin

  heyo-cms seed [--file <path>]       run the project's seed module

  heyo-cms export [--out <file>]      write content as NDJSON (default: stdout)
    --collections <a,b>  default: every collection
    --globals <a,b>      default: every global
    --include-trashed    include documents in the trash

  heyo-cms import <file>              read an export back ("-" is stdin)
    --on-conflict <skip|update|fail>   default: skip
    --dry-run            parse and report without writing

  heyo-cms telemetry                  print exactly what would be reported

  --config <path>   configuration module (default: ./heyo-cms.config.ts)
  --dir <path>      migrations directory (default: the one in the config)
  --env <path>      environment file (default: ./.env, then ./.env.local)
`;

export async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArguments(argv);

  if (!command || command === "help" || flags.has("--help")) {
    console.log(usage);
    return command && command !== "help" ? 1 : 0;
  }

  await loadEnvFile(flags.get("--env"));
  const cms = await loadConfig(flags.get("--config"));

  switch (command) {
    case "generate":
    case "migrate":
    case "status":
      return await runMigrationCommand(command, cms, flags);
    case "create-admin":
      return await report(command, cms, await createAdmin(cms, flags));
    case "seed":
      return await report(command, cms, await runSeed(cms, flags));
    case "export":
      return await report(command, cms, await exportCommand(cms, flags));
    case "import":
      return await report(command, cms, await importCommand(cms, positionals[1], flags)); // prettier-ignore
    case "telemetry":
      return await telemetryCommand(cms);
    default:
      console.error(`Unknown command: ${command}`);
      console.log(usage);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function runMigrationCommand(
  command: "generate" | "migrate" | "status",
  cms: CmsInstance,
  flags: Map<string, string>,
): Promise<number> {
  const directory = resolve(
    flags.get("--dir") ?? cms._config.migrationsDirectory,
  );
  const store = new MigrationStore(directory);
  const adapter = await cms.database();

  if (command === "generate") {
    const result = await generateMigration({
      adapter,
      store,
      target: cms.schema,
      // A plugin ships steps rather than SQL, and they become files here
      // so they are reviewed in the pull request that installed the
      // plugin rather than applied invisibly at start-up. They are
      // numbered after the schema diff, because they talk about tables
      // the diff creates.
      plugins: cms._config.plugins.flatMap((plugin) =>
        (plugin.migrations ?? []).map((migration) => ({
          plugin: plugin.id,
          id: migration.id,
          steps: migration.steps,
        })),
      ),
      ...(flags.get("--name") ? { name: flags.get("--name") as string } : {}),
    });
    if (result.created) {
      console.log(`Wrote ${result.file}`);
      for (const line of result.summary) console.log(`  ${line}`);
    }
    for (const plugin of result.plugins ?? []) {
      console.log(`Wrote ${plugin.file} (plugin migration)`);
    }
    if (!result.created && (result.plugins ?? []).length === 0) {
      console.log("No schema changes. Nothing to generate.");
    }
    return await report(command, cms, 0);
  }

  if (command === "migrate") {
    const result = await runMigrations({ adapter, store });
    if (result.applied.length === 0) {
      console.log(
        `Up to date (${result.alreadyApplied} migration(s) already applied).`,
      );
      return await report(command, cms, 0);
    }
    for (const id of result.applied) console.log(`Applied ${id}`);
    return await report(command, cms, 0);
  }

  const status = await migrationStatus({ adapter, store, target: cms.schema });
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

// ---------------------------------------------------------------------------
// The first account
// ---------------------------------------------------------------------------

/**
 * Creates an editor who can sign in to the panel.
 *
 * The chicken-and-egg problem every CMS has: the panel is behind
 * authentication, and the only way to create an account through the panel is
 * to be signed in. There are two answers here and they do not conflict. A
 * browser opening a CMS with no accounts is offered the first one on the
 * sign-in screen (`admin.auth.firstUser`, on by default), which is a door
 * that closes itself the moment somebody walks through it. This command is
 * the other answer, for the deployments where that first browser is not
 * trusted to be the right one: a pipeline, a container entrypoint, a
 * configuration that set `firstUser: false`.
 *
 * Unlike the screen, it is not limited to the first account — somebody with
 * shell access to the deployment is already trusted with the database.
 *
 * A password that was not supplied is generated rather than prompted for:
 * prompting would mean reading from a terminal that may not exist (a release
 * pipeline, a container's entrypoint), and the generated one is both stronger
 * and printed exactly once.
 */
async function createAdmin(
  cms: CmsInstance,
  flags: Map<string, string>,
): Promise<number> {
  const email = flags.get("--email") ?? process.env.HEYO_CMS_ADMIN_EMAIL;
  if (!email) {
    console.error(
      "An address is required: heyo-cms create-admin --email you@example.com",
    );
    return 1;
  }

  const supplied =
    flags.get("--password") ?? process.env.HEYO_CMS_ADMIN_PASSWORD;
  const password = supplied ?? generatePassword();
  const roles = (flags.get("--roles") ?? "admin")
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0);

  const existing = await cms.auth.users.byEmail(email);
  if (existing) {
    // Resetting the password of an account that is already there is a
    // different command on purpose: a `create` that quietly overwrote a
    // credential would be the wrong default for the one command that runs
    // with the database's full authority.
    console.error(
      `${email} already has an account (${existing.status}). Use the panel, or cms.auth.users.setPassword().`,
    );
    return 1;
  }

  const user = await cms.auth.users.create({
    email,
    password,
    roles,
    status: "active",
    ...(flags.get("--name") ? { name: flags.get("--name") as string } : {}),
  });
  await cms.drainEvents();

  console.log(`Created ${user.email} with role(s) ${user.roles.join(", ")}.`);
  if (!supplied) {
    console.log(`Password: ${password}`);
    console.log("This is the only time it is shown.");
  }
  console.log(`Sign in at ${cms._config.basePath}${cms._config.admin.path}.`);
  return 0;
}

/**
 * A password nobody has to think about.
 *
 * Base64url of 24 random bytes: 192 bits, no ambiguous characters to read
 * aloud wrongly, and short enough to paste.
 */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const seedCandidates = [
  "heyo-cms.seed.ts",
  "heyo-cms.seed.js",
  "seed.ts",
  "src/heyo-cms.seed.ts",
];

/**
 * Runs the project's own seed module.
 *
 * The CMS ships no fixtures of its own: content that means something is
 * content somebody wrote for their collections, and a package that invented
 * "Lorem ipsum" rows would be inventing them for a schema it has never seen.
 * What it provides is the convention — a module exporting `seed(cms)`, which
 * the generator's templates ship filled in — so the command is the same in
 * every project.
 */
async function runSeed(
  cms: CmsInstance,
  flags: Map<string, string>,
): Promise<number> {
  const file = flags.get("--file")
    ? resolve(flags.get("--file") as string)
    : await findFile(seedCandidates, "seed module");

  const module = (await importModule(file)) as Record<string, unknown>;
  const seed = module.seed ?? module.default;
  if (typeof seed !== "function") {
    console.error(
      `${file} does not export a seed. Add \`export async function seed(cms) { ... }\`.`,
    );
    return 1;
  }

  await (seed as (instance: CmsInstance) => Promise<void> | void)(cms);
  // The seed wrote through the ordinary API, so it queued ordinary events.
  await cms.drainEvents();
  console.log(`Seeded from ${file}.`);
  return 0;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

async function exportCommand(
  cms: CmsInstance,
  flags: Map<string, string>,
): Promise<number> {
  const out = flags.get("--out");
  const write = out ? fileWriter(resolve(out)) : stdoutWriter();

  let documents = 0;
  let globals = 0;
  try {
    for await (const record of exportContent(cms, {
      ...list(flags, "--collections", "collections"),
      ...list(flags, "--globals", "globals"),
      ...(flags.has("--include-trashed") ? { includeTrashed: true } : {}),
    })) {
      if (record.kind === "document") documents += 1;
      if (record.kind === "global") globals += 1;
      await write.line(serializeRecord(record));
    }
  } finally {
    await write.close();
  }

  // On stderr, so `heyo-cms export > content.ndjson` stays a clean file.
  console.error(`Exported ${documents} document(s) and ${globals} global(s).`);
  return 0;
}

async function importCommand(
  cms: CmsInstance,
  file: string | undefined,
  flags: Map<string, string>,
): Promise<number> {
  if (!file) {
    console.error('A file is required: heyo-cms import content.ndjson (or "-").'); // prettier-ignore
    return 1;
  }

  const onConflict = flags.get("--on-conflict") ?? "skip";
  if (!["skip", "update", "fail"].includes(onConflict)) {
    console.error(`--on-conflict takes skip, update or fail; got ${onConflict}.`); // prettier-ignore
    return 1;
  }

  const options: ImportOptions = {
    onConflict: onConflict as ImportOptions["onConflict"],
    ...(flags.has("--dry-run") ? { dryRun: true } : {}),
  };

  const source = file === "-" ? stdinChunks() : fileChunks(resolve(file));
  const report = await importContent(
    cms,
    readRecords(toLines(source)),
    options,
  );

  const prefix = options.dryRun ? "Would import" : "Imported";
  console.log(
    `${prefix} ${report.documents.created} new and ${report.documents.updated} updated document(s), ${report.globals.updated} global(s).`,
  );
  if (report.documents.skipped > 0) {
    console.log(`Skipped ${report.documents.skipped} document(s).`);
  }
  for (const error of report.errors) console.error(`  ${error}`);
  return report.errors.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Prints the body, not a promise about the body.
 *
 * A telemetry policy nobody can verify is a policy nobody believes, so this
 * command renders exactly what would be sent, says whether it would be sent
 * at all, and names the switch that stops it.
 */
async function telemetryCommand(cms: CmsInstance): Promise<number> {
  const decision = telemetryDecision(cms._config.telemetry);
  const payload = telemetryPayload("telemetry", cms, await packageVersion());

  console.log(decision.enabled ? "Telemetry: on" : "Telemetry: off");
  console.log(`  ${decision.reason}`);
  console.log("");
  console.log("  What a command would send, in full:");
  console.log("");
  console.log(JSON.stringify(payload, null, 2));
  console.log("");
  console.log("  Turn it off with any of:");
  console.log("    HEYO_TELEMETRY_DISABLED=1");
  console.log("    DO_NOT_TRACK=1");
  console.log("    telemetry: { enabled: false } in heyo-cms.config.ts");
  console.log("");
  return 0;
}

/**
 * Reports a command that has finished, and gets out of the way.
 *
 * Returns the exit code it was given, whatever happens: a CLI whose status
 * depended on a telemetry endpoint would be a CLI nobody could script
 * against.
 */
async function report(
  event: string,
  cms: CmsInstance,
  code: number,
): Promise<number> {
  try {
    await reportTelemetry({
      event,
      cms,
      version: await packageVersion(),
      ...(cms._config.telemetry ? { config: cms._config.telemetry } : {}),
    });
  } catch {
    // Unreachable in practice — `sendTelemetry` swallows its own failures —
    // and silent on purpose if it ever is not.
  }
  return code;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function parseArguments(argv: string[]): {
  command: string | undefined;
  positionals: string[];
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

  return { command: positionals[0], positionals, flags };
}

/** `--collections a,b` as the option the export expects, or nothing at all. */
function list(
  flags: Map<string, string>,
  flag: string,
  key: "collections" | "globals",
): Record<string, string[]> {
  const value = flags.get(flag);
  if (!value || value === "true") return {};
  return {
    [key]: value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  };
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
  const file = path ? resolve(path) : await findFile(candidates, "configuration"); // prettier-ignore
  const module = (await importModule(file)) as Record<string, unknown>;

  const candidate = module.cms ?? module.default;
  if (!isCmsInstance(candidate)) {
    throw new Error(
      `${file} does not export a CMS. Add \`export const cms = heyoCms({ ... })\`.`,
    );
  }
  return candidate;
}

async function importModule(file: string): Promise<unknown> {
  return await import(isAbsolute(file) ? pathToFileURL(file).href : file);
}

async function findFile(names: string[], label: string): Promise<string> {
  for (const candidate of names) {
    const absolute = resolve(candidate);
    try {
      await stat(absolute);
      return absolute;
    } catch {
      // Keep looking; a missing candidate is the normal case.
    }
  }
  throw new Error(
    `No ${label} found. Looked for ${names.join(", ")}. Use --config or --file.`,
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

/**
 * Reads `.env`, for the half of the project a framework does not load it for.
 *
 * `next dev` and `vite` load it; a CLI run in the same directory does not,
 * and "the migration cannot find DATABASE_URL but the site can" is a
 * confusing enough half hour that the twenty lines are worth it.
 *
 * A variable already in the environment always wins. The file is a default
 * for a developer's machine, and silently overriding what a deployment
 * exported would be the kind of surprise that ends with a migration applied
 * to the wrong database.
 */
async function loadEnvFile(explicit: string | undefined): Promise<void> {
  const files = explicit ? [resolve(explicit)] : [resolve(".env"), resolve(".env.local")]; // prettier-ignore

  for (const file of files) {
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch {
      if (explicit) throw new Error(`No environment file at ${file}.`);
      continue;
    }

    for (const line of contents.split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line); // prettier-ignore
      if (!match) continue;
      const [, name, rawValue] = match as unknown as [string, string, string];
      if (process.env[name] !== undefined) continue;
      const value = rawValue.trim();
      const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
      process.env[name] = quoted
        ? (quoted[2] as string)
        : (value.split(" #")[0] as string).trim();
    }
  }
}

/** The version in `package.json`, next to this file in src and in dist alike. */
async function packageVersion(): Promise<string> {
  try {
    const manifest = await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    return (JSON.parse(manifest) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface Writer {
  line(text: string): Promise<void>;
  close(): Promise<void>;
}

/** Writes with backpressure, so a large export cannot outrun the disk. */
function fileWriter(path: string): Writer {
  const stream = createWriteStream(path, { encoding: "utf8" });
  return {
    line: (text) =>
      new Promise<void>((resolveWrite, rejectWrite) => {
        stream.write(text, (error) =>
          error ? rejectWrite(error) : resolveWrite(),
        );
      }),
    close: () =>
      new Promise<void>((resolveClose) => stream.end(() => resolveClose())),
  };
}

function stdoutWriter(): Writer {
  return {
    line: (text) =>
      new Promise<void>((resolveWrite, rejectWrite) => {
        process.stdout.write(text, (error) =>
          error ? rejectWrite(error) : resolveWrite(),
        );
      }),
    close: async () => {},
  };
}

async function* fileChunks(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  for await (const chunk of stream) yield chunk as string;
}

async function* stdinChunks(): AsyncGenerator<string> {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) yield chunk as string;
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
