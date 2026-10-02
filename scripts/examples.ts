#!/usr/bin/env bun
/**
 * Local harness for the deployment examples.
 *
 * The examples are the projects people copy, but none of them renders a row
 * without a database first: the Vercel variants want a Postgres connection
 * string plus migrations, the Cloudflare variants want local D1 state.
 * Checking one by hand is a different setup every time, so nobody checks them
 * and they drift. This script makes one command boot an example with its
 * database ready, and one command walk all of them asserting the same
 * contract.
 *
 *   bun run example list
 *   bun run example up next
 *   bun run example smoke
 *   bun run example reset
 *   bun run example stop
 *
 * Nothing survives the command: dev servers are killed with their process
 * group, and a Postgres container this script started is removed on the way
 * out, so a check never leaves a daemon running on the machine.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { SQL } from "bun";

import type { CmsInstance } from "../packages/heyo-cms/src/types/instance";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

type DatabaseKind = "postgres" | "d1" | "mongodb";

interface Example {
  readonly name: string;
  /**
   * `config` examples are a configuration module and its migrations;
   * `app` examples add a framework and a dev server. The six deployment
   * variants become `app` in stage 7, when the HTTP handler exists.
   */
  readonly kind: "config" | "app";
  /** Framework binary in the example's own node_modules/.bin. */
  readonly bin?: string;
  readonly database: DatabaseKind;
  /** Fixed port so two examples never fight and links stay memorable. */
  readonly port: number;
  /** False until the example is scaffolded; `list` says so out loud. */
  readonly scaffolded: boolean;
}

const examples: readonly Example[] = [
  { name: "next", kind: "config", database: "postgres", port: 4320, scaffolded: true }, // prettier-ignore
  { name: "next-vercel", kind: "app", bin: "next", database: "postgres", port: 4321, scaffolded: false }, // prettier-ignore
  { name: "next-cloudflare", kind: "app", bin: "next", database: "d1", port: 4322, scaffolded: false }, // prettier-ignore
  { name: "astro-vercel", kind: "app", bin: "astro", database: "postgres", port: 4323, scaffolded: false }, // prettier-ignore
  { name: "astro-cloudflare", kind: "app", bin: "astro", database: "d1", port: 4324, scaffolded: false }, // prettier-ignore
  { name: "react-router-vercel", kind: "app", bin: "react-router", database: "postgres", port: 4325, scaffolded: false }, // prettier-ignore
  { name: "react-router-cloudflare", kind: "app", bin: "react-router", database: "d1", port: 4326, scaffolded: false }, // prettier-ignore
];

const repositoryRoot = join(import.meta.dirname, "..");
const examplesRoot = join(repositoryRoot, "examples");
const logDirectory = join(repositoryRoot, ".heyo-playground");

/** Secrets the harness injects, so smoke exercises the write half of the API. */
const adminToken = "local-playground-token";
const cronSecret = "local-playground-cron";

/** Container used only when no Postgres is already listening locally. */
const dockerContainer = "heyo-cms-playground-postgres";
const dockerPort = 55432;
const dockerPassword = "heyo-cms";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((argument) => argument.startsWith("--")));
  const positionals = argv.filter((argument) => !argument.startsWith("--"));
  const [command = "list", ...names] = positionals;

  if (command === "list") {
    printList();
    return 0;
  }

  const selected = selectExamples(names);
  if (selected.length === 0) {
    console.error(
      `Unknown example(s): ${names.join(", ")}. Run "bun run example list".`,
    );
    return 1;
  }

  try {
    if (command === "stop") {
      for (const example of selected) {
        const killed = await killPortListeners(example.port);
        console.log(
          killed.length === 0
            ? `  ${example.name}: nothing on port ${example.port}`
            : `  ${example.name}: killed ${killed.join(", ")} on port ${example.port}`,
        );
      }
      await removeDockerPostgres();
      return 0;
    }

    if (command === "reset") {
      for (const example of selected) await resetExample(example);
      await removeDockerPostgres();
      return 0;
    }

    if (!flags.has("--no-build")) await buildPackage();

    if (command === "up") {
      if (names.length !== 1) {
        console.error('"up" takes exactly one example name.');
        return 1;
      }
      return await runExample(selected[0] as Example);
    }

    if (command === "smoke") return await smokeExamples(selected);

    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
  } finally {
    // A container this script started is this script's to clean up; a
    // Postgres that was already running belongs to the machine.
    if (startedDockerPostgres && !flags.has("--keep-db")) {
      await removeDockerPostgres();
    }
  }
}

function printUsage(): void {
  console.log(
    [
      "",
      "  bun run example list                 show every example and its database",
      "  bun run example up <name>            boot one example with its database ready",
      "  bun run example smoke [name...]      walk the examples and assert the contract",
      "  bun run example reset [name...]      drop the local databases and D1 state",
      "  bun run example stop [name...]       kill anything left on the example ports",
      "",
      "  --no-build   skip rebuilding @heyo-sh/heyo-cms first",
      "  --keep-db    leave a Postgres container this script started running",
      "",
    ].join("\n"),
  );
}

function printList(): void {
  console.log("\n  Examples\n");
  for (const example of examples) {
    const database = { postgres: "Postgres", d1: "D1 (local)", mongodb: "MongoDB" }[example.database]; // prettier-ignore
    const state = example.scaffolded
      ? example.kind === "app"
        ? `http://localhost:${example.port}`
        : "configuration and migrations"
      : "not scaffolded yet (stage 7)";
    console.log(`  ${example.name.padEnd(24)} ${database.padEnd(12)} ${state}`);
  }
  printUsage();
}

function selectExamples(names: string[]): Example[] {
  if (names.length === 0) return [...examples];
  return names
    .map((name) => examples.find((example) => example.name === name))
    .filter((example): example is Example => example !== undefined);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runExample(example: Example): Promise<number> {
  if (!example.scaffolded) {
    console.error(
      `  ${example.name} is not scaffolded yet; it arrives with the HTTP handler in stage 7.`,
    );
    return 1;
  }

  const environment = await prepareDatabase(example);

  if (example.kind === "config") {
    // There is no server to hand over to yet, so "up" does the useful half:
    // it leaves a migrated database and prints how to reach it.
    const result = await checkConfigExample(example, environment);
    console.log(
      [
        "",
        `  ${example.name} is ready`,
        `    database   ${redact(environment.DATABASE_URL ?? "(local D1)")}`,
        `    schema     ${result.tables} tables, ${result.collections} collection(s)`,
        "",
        "  The dev server arrives with the HTTP handler in stage 7.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const server = await startDevServer(example, environment, "inherit");
  try {
    const base = `http://localhost:${example.port}`;
    console.log(
      [
        "",
        `  ${example.name} is ready`,
        `    app       ${base}/`,
        `    api       ${base}/api/heyo-cms/posts`,
        `    admin     ${base}/api/heyo-cms/admin/`,
        "",
        "  Ctrl-C to stop.",
        "",
      ].join("\n"),
    );
    await waitForInterrupt();
    return 0;
  } finally {
    await server.stop();
  }
}

async function smokeExamples(selected: Example[]): Promise<number> {
  const summaries: { name: string; failures: number; duration: number }[] = [];

  for (const example of selected) {
    if (!example.scaffolded) {
      console.log(`\n▸ ${example.name}: not scaffolded yet (stage 7)`);
      continue;
    }

    const startedAt = Date.now();
    console.log(`\n▸ ${example.name} (${example.database})`);
    let failures = 0;
    try {
      const environment = await prepareDatabase(example);
      if (example.kind === "config") {
        const result = await checkConfigExample(example, environment);
        console.log(`  ✓ configuration builds (${result.collections} collection(s))`); // prettier-ignore
        console.log(`  ✓ migrations apply (${result.tables} tables)`);
      } else {
        const logPath = join(logDirectory, `${example.name}.log`);
        const server = await startDevServer(example, environment, logPath);
        try {
          failures = await runHttpChecks(example);
        } finally {
          await server.stop();
        }
        if (failures > 0) console.log(`  server log: ${logPath}`);
      }
    } catch (error) {
      failures = 1;
      console.log(`  ✗ ${errorMessage(error)}`);
    }
    summaries.push({
      name: example.name,
      failures,
      duration: Date.now() - startedAt,
    });
  }

  console.log("\n  Summary\n");
  for (const summary of summaries) {
    const mark = summary.failures === 0 ? "✓" : "✗";
    const detail = summary.failures === 0 ? "ok" : `${summary.failures} failed check(s)`; // prettier-ignore
    console.log(
      `  ${mark} ${summary.name.padEnd(24)} ${detail.padEnd(20)} ${Math.round(summary.duration / 1000)}s`,
    );
  }
  console.log("");

  return summaries.some((summary) => summary.failures > 0) ? 1 : 0;
}

async function resetExample(example: Example): Promise<void> {
  if (example.database === "d1") {
    await rm(join(examplesRoot, example.name, ".wrangler", "state"), {
      recursive: true,
      force: true,
    });
    console.log(`  reset ${example.name}: local D1 state removed`);
    return;
  }
  if (example.database !== "postgres") return;

  if (process.env.DATABASE_URL) {
    console.log(`  reset ${example.name}: skipped, DATABASE_URL is yours`);
    return;
  }
  // Reset never starts a server: there is nothing to drop on one that is down.
  const server = await findRunningPostgresServer();
  if (!server) {
    console.log(`  reset ${example.name}: no Postgres running, nothing to drop`); // prettier-ignore
    return;
  }
  const sql = new SQL({ url: `${server}/postgres`, max: 1 });
  try {
    await sql.unsafe(
      `DROP DATABASE IF EXISTS "${postgresDatabaseName(example)}" WITH (FORCE)`,
    );
    console.log(`  reset ${example.name}: database dropped`);
  } finally {
    await sql.close();
  }
}

// ---------------------------------------------------------------------------
// Contract checks
// ---------------------------------------------------------------------------

interface ConfigCheckResult {
  collections: number;
  tables: number;
}

/**
 * The contract a configuration example has to satisfy.
 *
 * It is the whole pipeline of stages 1 and 2 against a real engine: the
 * configuration builds, the schema it implies becomes a migration, the
 * migration applies, and the database afterwards contains what the schema
 * said it would. The HTTP half of this file takes over in stage 7.
 */
async function checkConfigExample(
  example: Example,
  environment: Record<string, string>,
): Promise<ConfigCheckResult> {
  const previous = { ...process.env };
  Object.assign(process.env, environment, {
    HEYO_CMS_API_TOKEN: adminToken,
    CRON_SECRET: cronSecret,
  });

  const directory = await mkdtemp(join(tmpdir(), `heyo-cms-${example.name}-`));
  try {
    const module = (await import(
      pathToFileURL(join(examplesRoot, example.name, "heyo-cms.config.ts")).href
    )) as { cms?: CmsInstance };
    const cms = module.cms;
    if (!cms) throw new Error("the example does not export `cms`");

    const inspection = cms.inspect();
    if (inspection.collections.length === 0) {
      throw new Error("the configuration declares no collections");
    }

    const { MigrationStore, generateMigration, runMigrations } = (await import(
      join(repositoryRoot, "packages/heyo-cms/src/migrations.ts")
    )) as typeof import("../packages/heyo-cms/src/migrations");

    const store = new MigrationStore(directory);
    const adapter = await cms.database();
    const generated = await generateMigration({
      adapter,
      store,
      target: cms.schema,
    });
    if (!generated.created) throw new Error("nothing was generated");

    await runMigrations({ adapter, store });

    // Twice: a migration that is not idempotent across runs is a migration
    // that breaks the second deployment, not the first.
    await runMigrations({ adapter, store });

    const live = await adapter.introspect();
    if (!live.tables.some((table) => table.name === "documents")) {
      throw new Error("the migration did not create the documents table");
    }
    await adapter.close?.();

    return {
      collections: inspection.collections.length,
      tables: live.tables.length,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

/** HTTP checks for `app` examples. Filled in with the router in stage 7. */
async function runHttpChecks(example: Example): Promise<number> {
  const response = await fetch(`${baseUrl(example)}/api/heyo-cms/openapi.json`);
  await response.arrayBuffer();
  if (!response.ok) {
    console.log(`  ✗ the CMS handler answered ${response.status}`);
    return 1;
  }
  console.log("  ✓ the CMS handler answers");
  return 0;
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

async function prepareDatabase(
  example: Example,
): Promise<Record<string, string>> {
  if (example.database === "d1") {
    await applyD1Migrations(example);
    return {};
  }
  if (example.database === "mongodb") {
    return { MONGODB_URL: await resolveMongo(example) };
  }
  return { DATABASE_URL: await preparePostgres(example) };
}

/**
 * Applies the bundled migrations to the Miniflare state directory every
 * Cloudflare dev proxy reads, so `next|astro|react-router dev` sees a real D1
 * binding without `wrangler dev`.
 */
async function applyD1Migrations(example: Example): Promise<void> {
  const directory = join(examplesRoot, example.name);
  const result = await execute(
    binaryPath(directory, "wrangler"),
    ["d1", "migrations", "apply", "heyo-cms", "--local"],
    { cwd: directory, input: "y\n" },
  );
  if (result.code !== 0) {
    throw new Error(`wrangler d1 migrations apply failed:\n${result.output}`);
  }
  console.log("  database: local D1 migrated");
}

async function preparePostgres(example: Example): Promise<string> {
  const url =
    process.env.DATABASE_URL ?? (await createPostgresDatabase(example));
  console.log(`  database: ${redact(url)}`);
  return url;
}

function postgresDatabaseName(example: Example): string {
  return `heyo_cms_${example.name.replaceAll("-", "_")}`;
}

/** A database per example, so one smoke run never reads another's rows. */
async function createPostgresDatabase(example: Example): Promise<string> {
  const server = await resolvePostgresServer();
  const name = postgresDatabaseName(example);
  const sql = new SQL({ url: `${server}/postgres`, max: 1 });
  try {
    // Dropped first: a smoke run asserts what a migration creates, which is
    // only meaningful against a database that did not already have it.
    await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await sql.close();
  }
  return `${server}/${name}`;
}

/**
 * Prefers a Postgres that is already listening: starting a container for a
 * database the machine already runs is the slowest possible way to migrate a
 * schema, and a reused server is one this script must not stop afterwards.
 */
async function resolvePostgresServer(): Promise<string> {
  if (postgresServer) return postgresServer;

  const local = `postgres://${process.env.USER ?? "postgres"}@localhost:5432`;
  if (await canConnect(`${local}/postgres`)) {
    console.log("  database: reusing the Postgres already on localhost:5432");
    postgresServer = local;
    return local;
  }

  await startDockerPostgres();
  const container = `postgres://postgres:${dockerPassword}@localhost:${dockerPort}`;
  // The container accepts TCP before it finishes initialising the cluster.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await canConnect(`${container}/postgres`)) {
      postgresServer = container;
      return container;
    }
    await Bun.sleep(500);
  }
  throw new Error(
    "No Postgres available. Start one locally, start Docker, or set DATABASE_URL.",
  );
}

let startedDockerPostgres = false;
let postgresServer: string | undefined;

async function startDockerPostgres(): Promise<void> {
  const running = await execute("docker", [
    "ps",
    "--filter",
    `name=^/${dockerContainer}$`,
    "--format",
    "{{.Names}}",
  ]);
  if (running.code !== 0) {
    throw new Error(
      "No local Postgres and no Docker daemon. Set DATABASE_URL or start one of them.",
    );
  }
  if (running.output.includes(dockerContainer)) {
    console.log(`  database: reusing the ${dockerContainer} container`);
    return;
  }

  console.log("  database: starting a temporary Postgres container…");
  await execute("docker", ["rm", "-f", dockerContainer]);
  const started = await execute("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    dockerContainer,
    "--env",
    `POSTGRES_PASSWORD=${dockerPassword}`,
    "--publish",
    `${dockerPort}:5432`,
    "postgres:17-alpine",
  ]);
  if (started.code !== 0) {
    throw new Error(`Unable to start Docker Postgres:\n${started.output}`);
  }
  startedDockerPostgres = true;
}

async function findRunningPostgresServer(): Promise<string | undefined> {
  const candidates = [
    `postgres://${process.env.USER ?? "postgres"}@localhost:5432`,
    `postgres://postgres:${dockerPassword}@localhost:${dockerPort}`,
  ];
  for (const candidate of candidates) {
    if (await canConnect(`${candidate}/postgres`)) return candidate;
  }
  return undefined;
}

async function removeDockerPostgres(): Promise<void> {
  const removed = await execute("docker", ["rm", "--force", dockerContainer]);
  if (removed.code === 0 && removed.output.includes(dockerContainer)) {
    console.log(`  database: removed the ${dockerContainer} container`);
  }
  startedDockerPostgres = false;
}

async function canConnect(url: string): Promise<boolean> {
  const sql = new SQL({ url, max: 1, connectionTimeout: 2 });
  try {
    await sql.unsafe("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await sql.close().catch(() => undefined);
  }
}

/** MongoDB follows the Postgres pattern: reuse what is listening, else fail. */
async function resolveMongo(example: Example): Promise<string> {
  const url = process.env.MONGODB_URL ?? "mongodb://localhost:27017";
  console.log(`  database: ${redact(url)}/${postgresDatabaseName(example)}`);
  return `${url}/${postgresDatabaseName(example)}`;
}

function redact(url: string): string {
  return url.replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:***@");
}

// ---------------------------------------------------------------------------
// Dev server
// ---------------------------------------------------------------------------

interface RunningServer {
  stop(): Promise<void>;
}

const baseUrls = new Map<string, string>();

function baseUrl(example: Example): string {
  return baseUrls.get(example.name) ?? `http://127.0.0.1:${example.port}`;
}

/**
 * Starts the example's own dev command. The process gets its own group, so
 * stopping it also stops the compiler workers frameworks fork — which would
 * otherwise keep the port bound and fail the next example in the run.
 */
async function startDevServer(
  example: Example,
  environment: Record<string, string>,
  output: "inherit" | string,
): Promise<RunningServer> {
  const directory = join(examplesRoot, example.name);

  // A leftover server from an earlier run would answer every check with stale
  // code and report a pass, which is worse than any crash this could cause.
  const busy = await portListeners(example.port);
  if (busy.length > 0) {
    throw new Error(
      `port ${example.port} is already in use by pid ${busy.join(", ")}; run "bun run example stop".`,
    );
  }

  let logFile: number | undefined;
  if (output !== "inherit") {
    await mkdir(logDirectory, { recursive: true });
    logFile = openSync(output, "w");
  }

  const child = spawn(
    binaryPath(directory, example.bin as string),
    ["dev", "--port", String(example.port)],
    {
      cwd: directory,
      detached: true,
      stdio: logFile === undefined ? "inherit" : ["ignore", logFile, logFile],
      env: {
        ...process.env,
        ...environment,
        HEYO_CMS_API_TOKEN: adminToken,
        CRON_SECRET: cronSecret,
        HEYO_TELEMETRY_DISABLED: "1",
        NODE_ENV: "development",
        BROWSER: "none",
      },
    },
  );

  const server: RunningServer = {
    stop: async () => {
      await stopDevServer(child, example.port);
      if (logFile !== undefined) closeSync(logFile);
    },
  };

  try {
    await waitForServer(example, child);
  } catch (error) {
    await server.stop();
    const log = output === "inherit" ? "" : `\n${await tail(output, 25)}`;
    throw new Error(`${errorMessage(error)}${log}`);
  }
  return server;
}

/**
 * Waits for the first successful response and records the address that
 * produced it: Astro binds `localhost`, which on macOS is `::1` only, while
 * Next and Vite bind every interface.
 */
async function waitForServer(
  example: Example,
  child: ChildProcess,
): Promise<void> {
  const candidates = [
    `http://127.0.0.1:${example.port}`,
    `http://[::1]:${example.port}`,
  ];
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${example.name} dev server exited early.`);
    }
    for (const candidate of candidates) {
      try {
        const response = await fetch(`${candidate}/`, {
          signal: AbortSignal.timeout(5_000),
        });
        await response.arrayBuffer();
        if (response.ok) {
          baseUrls.set(example.name, candidate);
          return;
        }
      } catch {
        // Connection refused until the framework finishes its first compile.
      }
    }
    await Bun.sleep(400);
  }
  throw new Error(`${example.name} did not answer on port ${example.port}.`);
}

async function stopDevServer(child: ChildProcess, port: number): Promise<void> {
  if (child.pid !== undefined && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve())); // prettier-ignore
    signalGroup(child.pid, "SIGTERM");
    const timeout = Bun.sleep(5_000).then(() => "timeout" as const);
    if ((await Promise.race([exited, timeout])) === "timeout") {
      signalGroup(child.pid, "SIGKILL");
    }
  }
  await killPortListeners(port);
}

function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone, which is the outcome this asked for.
  }
}

async function portListeners(port: number): Promise<number[]> {
  const result = await execute("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  return result.output
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function killPortListeners(port: number): Promise<number[]> {
  const killed = new Set<number>();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const listeners = await portListeners(port);
    if (listeners.length === 0) return [...killed];
    for (const pid of listeners) {
      killed.add(pid);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Exited between the listing and the signal.
      }
    }
    await Bun.sleep(300);
  }
  const remaining = await portListeners(port);
  if (remaining.length > 0) {
    console.log(
      `  ! port ${port} is still held by pid ${remaining.join(", ")}`,
    );
  }
  return [...killed];
}

function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * The examples import the built package, not its sources, so a change that is
 * not built is a change the harness would silently fail to test.
 */
async function buildPackage(): Promise<void> {
  console.log("  building @heyo-sh/heyo-cms…");
  const result = await execute(
    "bun",
    ["run", "--filter", "@heyo-sh/heyo-cms", "build"],
    { cwd: repositoryRoot },
  );
  if (result.code !== 0) {
    throw new Error(`Package build failed:\n${result.output}`);
  }
}

function binaryPath(directory: string, bin: string): string {
  const local = join(directory, "node_modules", ".bin", bin);
  return existsSync(local) ? local : bin;
}

async function execute(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string } = {},
): Promise<{ code: number; output: string }> {
  try {
    const child = Bun.spawn([command, ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdin: options.input ? new TextEncoder().encode(options.input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, output: `${stdout}${stderr}` };
  } catch (error) {
    return { code: 1, output: errorMessage(error) };
  }
}

async function tail(path: string, lines: number): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

process.exitCode = await main(process.argv.slice(2));
