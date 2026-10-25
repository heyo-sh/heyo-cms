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
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { SQL } from "bun";

import { scaffoldProject } from "../packages/create-heyo-cms/src/scaffold";
import type {
  Database,
  Deployment,
  Storage,
  Template,
} from "../packages/create-heyo-cms/src/types";
import type { Actor } from "../packages/heyo-cms/src/types/actor";
import type { CmsInstance } from "../packages/heyo-cms/src/types/instance";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

type DatabaseKind = "postgres" | "d1" | "mongodb";

interface Example {
  readonly name: string;
  /**
   * `config` examples are a configuration module, its migrations and the
   * handler served directly; `app` examples add a framework and its dev
   * server.
   *
   * The six deployment variants are `app`, and none of them is checked in:
   * each one is written by `create-heyo-cms` on first use (stage 10). That is
   * the point — a committed copy of a template is a copy that drifts from it,
   * and what smoke then proves is the copy rather than what `bun create`
   * hands a reader.
   */
  readonly kind: "config" | "app";
  /** Framework binary in the example's own node_modules/.bin. */
  readonly bin?: string;
  readonly database: DatabaseKind;
  /** Fixed port so two examples never fight and links stay memorable. */
  readonly port: number;
  /** What the generator is asked for, when the example has to be written. */
  readonly generate?: {
    template: Template;
    deployment: Deployment;
    database: Database;
    storage: Storage;
  };
}

const examples: readonly Example[] = [
  { name: "next", kind: "config", database: "postgres", port: 4320 }, // prettier-ignore
  { name: "next-vercel", kind: "app", bin: "next", database: "postgres", port: 4321, generate: { template: "next", deployment: "vercel", database: "postgres", storage: "local" } }, // prettier-ignore
  { name: "next-cloudflare", kind: "app", bin: "next", database: "d1", port: 4322, generate: { template: "next", deployment: "cloudflare", database: "d1", storage: "r2" } }, // prettier-ignore
  { name: "astro-vercel", kind: "app", bin: "astro", database: "postgres", port: 4323, generate: { template: "astro", deployment: "vercel", database: "postgres", storage: "local" } }, // prettier-ignore
  { name: "astro-cloudflare", kind: "app", bin: "astro", database: "d1", port: 4324, generate: { template: "astro", deployment: "cloudflare", database: "d1", storage: "r2" } }, // prettier-ignore
  { name: "react-router-vercel", kind: "app", bin: "react-router", database: "postgres", port: 4325, generate: { template: "react-router", deployment: "vercel", database: "postgres", storage: "local" } }, // prettier-ignore
  { name: "react-router-cloudflare", kind: "app", bin: "react-router", database: "d1", port: 4326, generate: { template: "react-router", deployment: "cloudflare", database: "d1", storage: "r2" } }, // prettier-ignore
];

const repositoryRoot = join(import.meta.dirname, "..");
const examplesRoot = join(repositoryRoot, "examples");
const logDirectory = join(repositoryRoot, ".heyo-playground");

/**
 * The secret the cron routes check. A dev server is handed it in the
 * project's `.env` (`devEnvFile`), the way the README tells a reader to.
 *
 * The write half of the API is not exercised with an injected token: an API
 * key is a row in the database, so a credential is created and signed in with
 * like a person's would be (`httpCredentials`).
 */
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

    if (command === "build") return await buildExamples(selected);

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
      "  bun run example build [name...]      production-build the framework examples",
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
    const state = isScaffolded(example)
      ? `http://localhost:${example.port}`
      : "written by create-heyo-cms on first use";
    console.log(`  ${example.name.padEnd(24)} ${database.padEnd(12)} ${state}`);
  }
  printUsage();
}

function isScaffolded(example: Example): boolean {
  return existsSync(join(examplesRoot, example.name, "package.json"));
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
  await ensureScaffolded(example);
  const environment = await prepareDatabase(example);

  if (example.kind === "config") {
    // A configuration example has no framework, but it does have a handler,
    // and a handler is a server: `Bun.serve` mounts the same `cms.handler` a
    // framework adapter would wrap, so `up` leaves a live API and a live
    // panel rather than a migrated database and a promise.
    return await serveConfigExample(example, environment);
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
    const startedAt = Date.now();
    console.log(`\n▸ ${example.name} (${example.database})`);
    let failures = 0;
    try {
      await ensureScaffolded(example);
      const environment = await prepareDatabase(example);
      if (example.kind === "config") {
        const result = await checkConfigExample(example, environment);
        console.log(`  ✓ configuration builds (${result.collections} collection(s))`); // prettier-ignore
        console.log(`  ✓ migrations apply (${result.tables} tables)`);
        console.log(`  ✓ engine round-trip (${result.events.join(", ")})`);
        console.log(`  ✓ auth round-trip (${result.auth})`);
        console.log(`  ✓ media round-trip (${result.media})`);
        console.log(`  ✓ webhook delivery (${result.webhooks})`);
        console.log(`  ✓ extensibility (${result.extensibility})`);
        console.log(`  ✓ handler over a socket (${result.http})`);
      } else {
        const logPath = join(logDirectory, `${example.name}.log`);
        const server = await startDevServer(example, environment, logPath);
        try {
          failures = await runHttpChecks(example, environment);
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

/**
 * `bun run example build`: the production build of every framework example.
 *
 * Separate from `smoke` because it answers a different question. Smoke proves
 * the handler behaves; this proves the template survives its framework's
 * optimiser — which is where a route export that cannot be tree-shaken, or an
 * optional peer dependency a bundler decided to resolve, actually shows up.
 * Both failures are invisible to a dev server.
 */
async function buildExamples(selected: Example[]): Promise<number> {
  let failures = 0;

  for (const example of selected) {
    if (example.kind !== "app") continue;
    console.log(`\n▸ ${example.name}`);
    const startedAt = Date.now();
    try {
      await ensureScaffolded(example);
      const result = await execute(
        "bun",
        ["run", example.name === "next-cloudflare" ? "build:worker" : "build"],
        {
          cwd: join(examplesRoot, example.name),
          // A build must not need a database. Naming one that does not exist is
          // how that claim gets checked rather than assumed.
          env: {
            DATABASE_URL: "postgres://build:build@127.0.0.1:1/unreachable",
            MONGODB_URL: "mongodb://127.0.0.1:1/unreachable",
          },
        },
      );
      if (result.code !== 0) {
        failures += 1;
        console.log(`  ✗ build failed\n${result.output.split("\n").slice(0, 60).join("\n")}`); // prettier-ignore
      } else {
        console.log(`  ✓ built in ${Math.round((Date.now() - startedAt) / 1000)}s`); // prettier-ignore
      }
    } catch (error) {
      failures += 1;
      console.log(`  ✗ ${errorMessage(error)}`);
    }
  }

  console.log("");
  return failures > 0 ? 1 : 0;
}

/**
 * `bun run example up <config example>`: the handler, on the example's port.
 *
 * Seeded first, so the panel and the API are not empty when the URLs are
 * printed — the same reason `up` seeds before handing over for an `app`
 * example (section 13).
 */
async function serveConfigExample(
  example: Example,
  environment: Record<string, string>,
): Promise<number> {
  const busy = await portListeners(example.port);
  if (busy.length > 0) {
    console.error(
      `  port ${example.port} is already in use by pid ${busy.join(", ")}; run "bun run example stop".`,
    );
    return 1;
  }

  const loaded = await loadExample(example, environment);
  const { cms } = loaded;
  try {
    const { tables } = await migrateExample(loaded);
    const seeded = await seedExample(cms);

    const server = Bun.serve({
      port: example.port,
      fetch: (request) => {
        const url = new URL(request.url);
        // The handler owns `basePath` and nothing else, so the root is a
        // redirect rather than a 404 somebody has to interpret.
        if (url.pathname === "/") {
          return new Response(null, {
            status: 302,
            headers: { location: `${cms._config.basePath}/admin` },
          });
        }
        return cms.handler(request);
      },
    });

    // After the server is listening, because it signs in through the route.
    const base = `http://localhost:${example.port}${cms._config.basePath}`;
    const credentials = await httpCredentials(cms, base);

    console.log(
      [
        "",
        `  ${example.name} is ready`,
        `    database   ${redact(environment.DATABASE_URL ?? "(local D1)")}`,
        `    schema     ${tables} tables, ${seeded} seeded document(s)`,
        `    api        ${base}/posts`,
        `    openapi    ${base}/openapi.json`,
        `    panel      ${base}/admin`,
        "",
        `  curl -H "authorization: Bearer ${credentials.token}" ${base}/posts`,
        "",
        "  Ctrl-C to stop.",
        "",
      ].join("\n"),
    );

    await waitForInterrupt();
    await server.stop(true);
    await cms.auth.users.remove(credentials.user);
    await cms.drainEvents();
    return 0;
  } finally {
    await loaded.dispose();
  }
}

/**
 * One document and one saved global, so a first look is not an empty table.
 *
 * Idempotent: `up` runs against a database a previous `up` may have seeded,
 * and a seed that duplicated itself on every boot would be its own bug report.
 */
async function seedExample(cms: CmsInstance): Promise<number> {
  const posts = cms.api.posts;
  if (!posts) return 0;

  const existing = await posts.find({ actor: smokeActor, limit: 1 });
  if (existing.docs.length > 0) return existing.totalDocs ?? existing.docs.length; // prettier-ignore

  await posts.create({
    data: {
      title: "Welcome to Heyo CMS",
      status: "published",
      excerpt: "Seeded by `bun run example up`.",
    },
    actor: smokeActor,
    source: "cli",
  });
  const settings = cms.globals.settings;
  if (settings) {
    await settings.update({
      data: { siteName: "Heyo CMS playground" },
      actor: smokeActor,
      source: "cli",
    });
  }
  await cms.drainEvents();
  return 1;
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
  /** Event types the round-trip produced and the outbox delivered. */
  events: string[];
  /** What the sign-in round-trip produced: the actor, spelled out. */
  auth: string;
  /** What the media round-trip observed: the lifecycle, spelled out. */
  media: string;
  /** What the delivery round-trip observed: signing, retry, replay. */
  webhooks: string;
  /** What the installed plugin contributed, checked end to end. */
  extensibility: string;
  /** What the HTTP round-trip exercised, over a real socket. */
  http: string;
}

/**
 * The actor the smoke test writes as.
 *
 * Spelled out rather than taken from `systemActor()`: the example's `access`
 * rules read `actor.permissions`, and a smoke test that granted itself `*`
 * would pass without ever exercising them.
 */
const smokeActor: Actor = {
  id: "usr_smoke",
  source: "session",
  roles: ["admin"],
  // `posts:publish` is a field-level grant, not an operation: the example
  // gates the `status` field with it, so a smoke run without it would get as
  // far as the publish and stop. The `settings` grants are the ordinary RBAC
  // default — the global declares no `access`, so it needs the permission.
  permissions: [
    "posts:create",
    "posts:update",
    "posts:publish",
    "settings:read",
    "settings:update",
    // Writing to the media library is governed; reading it is not.
    "media:create",
    "media:update",
    "media:delete",
    // The collection the installed plugin brought. Granting it explicitly is
    // the point: a plugin's collection is governed by the same RBAC as
    // every other, so installing one means granting its permissions.
    "reviews:create",
    "reviews:read",
    "reviews:update",
    "reviews:delete",
    "reviews:purge",
    "posts:delete",
    "posts:purge",
    // Managing where this CMS sends its content is administrative.
    "webhooks:read",
    "webhooks:create",
    "webhooks:update",
    "webhooks:delete",
  ],
};

/**
 * An example's configuration module, loaded with its environment in place.
 *
 * The temporary media directory is created before the import, because the
 * example reads `MEDIA_DIR` while it is loading — needing a bucket is not
 * something a smoke run or a `bun run example up` is allowed to do.
 */
interface LoadedExample {
  cms: CmsInstance;
  /** Where `local()` storage put the files; asserted by the media check. */
  mediaDirectory: string;
  /** Where the generated migration was written. */
  directory: string;
  dispose: () => Promise<void>;
}

async function loadExample(
  example: Example,
  environment: Record<string, string>,
): Promise<LoadedExample> {
  const previous = { ...process.env };
  const previousCwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), `heyo-cms-${example.name}-`));
  const mediaDirectory = join(directory, "media");

  Object.assign(process.env, environment, {
    CRON_SECRET: cronSecret,
    MEDIA_DIR: mediaDirectory,
  });
  // From inside the project, because that is where its own CLI would run
  // from: a D1 example finds Wrangler's local database under `.wrangler`,
  // relative paths in the configuration mean what the README says they mean.
  process.chdir(join(examplesRoot, example.name));

  const restore = async (): Promise<void> => {
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  };

  try {
    const module = (await import(
      pathToFileURL(join(examplesRoot, example.name, "heyo-cms.config.ts")).href
    )) as { cms?: CmsInstance };
    const cms = module.cms;
    if (!cms) throw new Error("the example does not export `cms`");

    return {
      cms,
      mediaDirectory,
      directory,
      dispose: async () => {
        await cms.close();
        await restore();
      },
    };
  } catch (error) {
    await restore();
    throw error;
  }
}

/**
 * Generates and applies the example's migration, then checks the result.
 *
 * Twice, because a migration that is not idempotent across runs breaks the
 * second deployment rather than the first.
 */
async function migrateExample(
  loaded: LoadedExample,
): Promise<{ tables: number }> {
  const { MigrationStore, generateMigration, runMigrations } = (await import(
    join(repositoryRoot, "packages/heyo-cms/src/migrations.ts")
  )) as typeof import("../packages/heyo-cms/src/migrations");

  const store = new MigrationStore(loaded.directory);
  const adapter = await loaded.cms.database();
  const generated = await generateMigration({
    adapter,
    store,
    target: loaded.cms.schema,
    // The installed plugins' own steps, written as files before the schema
    // diff: a plugin that backfills has to see its table exist first.
    plugins: loaded.cms._config.plugins.flatMap((plugin) =>
      (plugin.migrations ?? []).map((migration) => ({
        plugin: plugin.id,
        id: migration.id,
        steps: migration.steps,
      })),
    ),
  });
  if (!generated.created) throw new Error("nothing was generated");

  await runMigrations({ adapter, store });
  await runMigrations({ adapter, store });

  const live = await adapter.introspect();
  if (!live.tables.some((table) => table.name === "documents")) {
    throw new Error("the migration did not create the documents table");
  }
  return { tables: live.tables.length };
}

/**
 * The contract a configuration example has to satisfy.
 *
 * The whole pipeline, against a real engine: the configuration builds, the
 * schema it implies becomes a migration, the migration applies, the engine,
 * auth and media round-trip on it — and then the same operations go through
 * `cms.handler` over a socket, which is what a framework adapter will be
 * wrapping in a template (stage 10).
 */
async function checkConfigExample(
  example: Example,
  environment: Record<string, string>,
): Promise<ConfigCheckResult> {
  const loaded = await loadExample(example, environment);
  const { cms } = loaded;

  try {
    const inspection = cms.inspect();
    if (inspection.collections.length === 0) {
      throw new Error("the configuration declares no collections");
    }
    if (inspection.routes.length === 0) {
      throw new Error("the configuration registers no routes");
    }

    const { tables } = await migrateExample(loaded);
    const events = await checkEngineRoundTrip(cms);
    const auth = await checkAuthRoundTrip(cms);
    const media = await checkMediaRoundTrip(cms, loaded.mediaDirectory);
    const webhooks = await checkWebhookRoundTrip(cms);
    const extensibility = await checkExtensibility(cms);
    const http = await checkHttpRoundTrip(cms);

    return {
      collections: inspection.collections.length,
      tables,
      events,
      auth,
      media,
      webhooks,
      extensibility,
      http,
    };
  } finally {
    await loaded.dispose();
  }
}

/**
 * The engine against a real database, not a test double.
 *
 * Create, read, update, delete and the outbox, through the example's own
 * access rules and hooks. The unit suite proves the engine on PGlite and an
 * in-process MongoDB; this proves it on the Postgres a reader would actually
 * deploy, which is where a `jsonb` cast or a `RETURNING` clause gets to
 * behave differently.
 */
async function checkEngineRoundTrip(cms: CmsInstance): Promise<string[]> {
  const delivered: string[] = [];
  cms.on("*", (event) => {
    delivered.push(event.type);
  });

  const posts = cms.api.posts;
  if (!posts) throw new Error("the example declares no `posts` collection");

  const created = await posts.create({
    data: { title: "Smoke test", status: "draft" },
    actor: smokeActor,
    source: "cli",
  });
  if (!created) throw new Error("create returned nothing");

  const id = String(created.id);
  const published = await posts.update({
    id,
    data: { status: "published" },
    actor: smokeActor,
    source: "cli",
  });
  if (published?.status !== "published") {
    throw new Error("the update did not take");
  }

  const read = await posts.findById(id, { actor: smokeActor });
  if (read?.title !== "Smoke test") throw new Error("the read came back wrong");

  await cms.drainEvents();
  await checkLifecycle(cms, id);

  // Leaves nothing behind, so the next run starts from the same place. The
  // example's `delete` rule wants an admin, which the smoke actor is.
  await posts.delete({ id, actor: smokeActor, source: "cli" });
  await posts.purge({ id, actor: smokeActor, source: "cli" });
  await cms.drainEvents();

  const expected = [
    "document.created",
    "document.updated",
    "document.field.changed",
    "document.scheduled",
    "document.schedule.applied",
    "document.trashed",
    "document.restored",
    "document.purged",
  ];
  const missing = expected.filter((type) => !delivered.includes(type));
  if (missing.length > 0) {
    throw new Error(`the outbox never delivered ${missing.join(", ")}`);
  }
  return expected;
}

/**
 * The media lifecycle, against a real database and a real filesystem.
 *
 * This is the claim stage 6 makes, checked end to end: removing a picture from
 * an article marks it unused and leaves the bytes exactly where they were,
 * using it again reclaims it, and only a collector running after the deadline
 * deletes anything. The unit suite proves it against an in-memory bucket; this
 * proves it against a storage adapter that has to touch a disk, through the
 * example's own RBAC.
 *
 * The file is an SVG deliberately: the example declares `sharpImages()`, and
 * nothing here is allowed to need a native module. An SVG already scales, so
 * no processor is asked for a pixel and the branch that serves the original
 * for a size it cannot render gets exercised at the same time.
 */
async function checkMediaRoundTrip(
  cms: CmsInstance,
  mediaDirectory: string,
): Promise<string> {
  const posts = cms.api.posts;
  if (!posts) throw new Error("the example declares no `posts` collection");

  const file = await cms.media.upload({
    file: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="256"><rect width="100%" height="100%"/></svg>',
    ),
    filename: "smoke-logo.svg",
    contentType: "image/svg+xml",
    alt: "The smoke test logo",
    actor: smokeActor,
    source: "cli",
  });
  if (file.width !== 512 || file.height !== 256) {
    throw new Error("the dimensions were not read from the file");
  }
  const onDisk = join(mediaDirectory, file.storageKey);
  if (!existsSync(onDisk)) throw new Error("the bytes never reached the disk");

  const variant = await cms.media.variant({ id: file.id, variant: "thumb" });
  if (variant?.key !== file.storageKey) {
    throw new Error("a file nothing can resize should be served as it is");
  }
  await variant.body.cancel();

  const post = await posts.create({
    data: { title: "Illustrated", status: "draft", cover: file.id },
    actor: smokeActor,
    source: "cli",
  });
  if (!post) throw new Error("create returned nothing");
  const id = String(post.id);
  if ((await cms.media.usages(file.id)).length !== 1) {
    throw new Error("the reference was not counted");
  }

  const detach = async (): Promise<void> => {
    await posts.update({ id, data: { cover: null }, actor: smokeActor, source: "cli" }); // prettier-ignore
  };

  await detach();
  const orphan = await cms.media.get(file.id);
  if (orphan?.status !== "orphaned" || orphan.purgeAfter === null) {
    throw new Error("losing the last reference did not orphan the file");
  }
  if (!existsSync(onDisk)) {
    throw new Error("an unused file must keep serving, not disappear");
  }

  await posts.update({
    id,
    data: { cover: file.id },
    actor: smokeActor,
    source: "cli",
  });
  if ((await cms.media.get(file.id))?.status !== "active") {
    throw new Error("using the file again did not reclaim it");
  }

  await detach();
  // Thirty days ahead rather than thirty days of waiting. The deadline is the
  // point of the feature and a bad length for a smoke test.
  const report = await cms.media.collect({
    now: new Date(Date.now() + 31 * 86_400_000),
  });
  if (report.purged !== 1) {
    throw new Error(`the collector purged ${report.purged} file(s), expected 1`); // prettier-ignore
  }
  if (existsSync(onDisk))
    throw new Error("the collector left the bytes behind");
  if (await cms.media.get(file.id)) {
    throw new Error("the collector left the record behind");
  }

  await posts.delete({ id, actor: smokeActor, source: "cli" });
  await posts.purge({ id, actor: smokeActor, source: "cli" });
  await cms.drainEvents();
  return "uploaded, referenced, orphaned, reclaimed, collected";
}

/**
 * Scheduled changes, the trash and a global, against a real Postgres.
 *
 * The sweeps are the one part of stage 5 whose correctness depends on the
 * database rather than on the engine: "has a value and is in the past" is a
 * different query on every adapter, and a timestamp that does not survive the
 * round trip would make a publication fire a year early or never.
 */
async function checkLifecycle(cms: CmsInstance, id: string): Promise<void> {
  const posts = cms.api.posts;
  if (!posts) throw new Error("the example declares no `posts` collection");

  await posts.update({
    id,
    data: { status: "draft" },
    actor: smokeActor,
    source: "cli",
  });
  await posts.schedule({
    id,
    at: new Date(Date.now() - 60_000),
    data: { status: "published" },
    actor: smokeActor,
    source: "cli",
  });

  const report = await cms.jobs.run();
  if (report.failed > 0) {
    const failure = (await cms.jobs.failures({ limit: 1 }))[0];
    throw new Error(`a job failed: ${failure?.error ?? "unknown"}`);
  }
  const published = await posts.findById(id, { actor: smokeActor });
  if (published?.status !== "published") {
    throw new Error("the scheduled change never applied");
  }

  await posts.delete({ id, actor: smokeActor, source: "cli" });
  const trashed = await cms.trash.list({ collection: "posts" });
  if (!trashed.entries.some((entry) => entry.id === id)) {
    throw new Error("the deleted document is not in the trash");
  }
  await cms.trash.restore({ collection: "posts", id, actor: smokeActor });
  if (!(await posts.findById(id, { actor: smokeActor }))) {
    throw new Error("the restore did not bring the document back");
  }

  const settings = cms.globals.settings;
  if (settings) {
    // Readable before it was ever saved, then saved, then read back: the
    // lazy row is the part a real database gets to disagree about.
    const before = await settings.get({ actor: smokeActor });
    if (typeof before.siteName !== "string") {
      throw new Error("the global did not fall back to its defaults");
    }
    const saved = await settings.update({
      data: { siteName: "Smoke" },
      actor: smokeActor,
      source: "cli",
    });
    if (saved?.siteName !== "Smoke") throw new Error("the global did not save");
  }
  await cms.drainEvents();
}

/**
 * Editor authentication against a real database.
 *
 * The unit suite covers the logic; this covers the storage, which is where
 * the differences live: a `jsonb` array of roles, a unique index over a
 * lowercased email, a timestamp that has to survive the round trip. It writes
 * to `cms_users`, `cms_sessions` and `cms_api_keys` and removes everything it
 * created, so the next run starts from the same place.
 */
async function checkAuthRoundTrip(cms: CmsInstance): Promise<string> {
  const email = "smoke@heyo.local";
  const password = "smoke-playground-password";

  const existing = await cms.auth.users.byEmail(email);
  if (existing) await cms.auth.users.remove(existing.id);

  const user = await cms.auth.users.create({
    email,
    password,
    roles: ["editor"],
  });
  try {
    const signedIn = await cms.auth.password.signIn({ email, password });
    if (signedIn.status !== "signed-in") {
      throw new Error("sign-in asked for a second factor nobody enrolled");
    }

    const actor = await cms.auth.actorFromRequest(
      new Request("https://smoke.local/", {
        headers: { authorization: `Bearer ${signedIn.token}` },
      }),
    );
    if (actor?.id !== user.id) throw new Error("the session did not resolve");
    if (!actor.permissions.includes("posts:*")) {
      throw new Error("the role did not expand into permissions");
    }

    const key = await cms.auth.apiKeys.create({
      name: "smoke",
      userId: user.id,
      scopes: ["read"],
    });
    const machine = await cms.auth.actorFromToken(key.key);
    // The owner is an editor; a read-only key keeps the reads and loses
    // everything else, whatever the role happened to grant.
    const writable = (machine?.permissions ?? []).filter(
      (permission) => !permission.endsWith(":read"),
    );
    if (!machine?.permissions.includes("posts:read") || writable.length > 0) {
      throw new Error(`the key was not narrowed: ${machine?.permissions.join(", ")}`); // prettier-ignore
    }
    await cms.auth.apiKeys.revoke(key.id);
    if (await cms.auth.actorFromToken(key.key)) {
      throw new Error("a revoked key still authenticates");
    }

    await cms.drainEvents();
    return `${actor.roles.join(", ")} → ${actor.permissions.join(", ")}`;
  } finally {
    await cms.auth.users.remove(user.id);
    await cms.drainEvents();
  }
}

/**
 * Delivery, against a receiver that really answers over a socket.
 *
 * The unit suite injects `fetch`; this does not. What is being checked here
 * is the half that only a real deployment has: that an event committed to a
 * real Postgres reaches a real HTTP server, signed, and that a receiver
 * which refuses parks the delivery for replay instead of losing it
 * (section 7).
 */
async function checkWebhookRoundTrip(cms: CmsInstance): Promise<string> {
  if (!cms.webhooks.enabled) return "disabled in this configuration";

  const received: { signature: string | null; type: string | null }[] = [];
  let accept = true;
  const receiver = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push({
        signature: request.headers.get("x-heyo-signature"),
        type: request.headers.get("x-heyo-event-type"),
      });
      await request.text();
      return new Response(accept ? "ok" : "no", { status: accept ? 200 : 500 });
    },
  });

  const subscription = await cms.webhooks.create({
    url: `http://127.0.0.1:${receiver.port}/hooks`,
    events: ["document.*"],
    filters: { collections: ["posts"] },
    actor: smokeActor,
  });

  const posts = cms.api.posts;
  if (!posts) throw new Error("the example declares no `posts` collection");

  try {
    const created = await posts.create({
      data: { title: "Webhook smoke", status: "draft" },
      actor: smokeActor,
      source: "cli",
    });
    await cms.drainEvents();

    if (received.length === 0) throw new Error("nothing was delivered");
    if (!received[0]?.signature?.startsWith("t=")) {
      throw new Error("the delivery was not signed");
    }
    const delivered = await cms.webhooks.deliveries({
      webhookId: subscription.id,
    });
    if (delivered.entries[0]?.status !== "delivered") {
      throw new Error(`the delivery is ${delivered.entries[0]?.status}`);
    }

    // And a receiver that refuses: parked, with the response recorded, and
    // replayable once it recovers.
    accept = false;
    await posts.update({
      id: String(created?.id),
      data: { status: "published" },
      actor: smokeActor,
      source: "cli",
    });
    await cms.drainEvents();
    const failed = (
      await cms.webhooks.deliveries({ webhookId: subscription.id })
    ).entries[0];
    if (failed?.status !== "pending" || failed.responseStatus !== 500) {
      throw new Error("a refused delivery was not parked for retry");
    }

    accept = true;
    const replayed = await cms.webhooks.retry({ id: failed.id });
    if (
      replayed.status !== "delivered" ||
      replayed.eventId !== failed.eventId
    ) {
      throw new Error("the replay did not carry the same event");
    }

    await posts.delete({ id: String(created?.id), actor: smokeActor, source: "cli" }); // prettier-ignore
    await posts.purge({ id: String(created?.id), actor: smokeActor, source: "cli" }); // prettier-ignore
    await cms.drainEvents();
    return `signed, delivered, parked on 500, replayed (${received.length} requests)`; // prettier-ignore
  } finally {
    await cms.webhooks.remove({ id: subscription.id, actor: smokeActor });
    await receiver.stop(true);
  }
}

/**
 * What the installed plugin actually contributed.
 *
 * Stage 9 is finished when a plugin can add a collection, a field, an editor
 * node, a route and a migration without a change in the core. The example
 * installs one (`examples/next/plugin.ts`), so the smoke run is where that
 * claim is checked against a real database rather than against a fixture.
 */
async function checkExtensibility(cms: CmsInstance): Promise<string> {
  // From the built package, not from source: the example's plugin registered
  // its node against `@heyo-sh/heyo-cms/editor`, and the registry is
  // module-level. Importing the source here would be a second registry that
  // has never heard of the node — and the check would fail for a reason that
  // has nothing to do with the plugin.
  const { renderRichText } = (await import(
    join(repositoryRoot, "packages/heyo-cms/dist/editor.js")
  )) as typeof import("../packages/heyo-cms/src/editor/index");

  const inspection = cms.inspect();
  const plugin = inspection.plugins[0];
  if (!plugin) return "no plugins installed";

  const reviews = cms.api.reviews;
  if (!reviews) throw new Error("the plugin's collection has no local API");

  const created = await reviews.create({
    data: {
      summary: "Smoke review",
      score: 4,
      body: {
        type: "doc",
        content: [
          {
            type: "pullQuote",
            attrs: { attribution: "A reader" },
            content: [{ type: "text", text: "It works." }],
          },
        ],
      },
    },
    actor: smokeActor,
    source: "cli",
  });
  if (!created) throw new Error("the plugin's collection refused a write");

  // The plugin's node, serialised by the core: this is the promise that a
  // custom node is readable without the panel.
  const html = renderRichText(created.body, { format: "html" });
  if (!html.includes("pull-quote") || !html.includes("It works.")) {
    throw new Error(`the plugin's node did not serialise: ${html}`);
  }

  // The plugin's field, on a collection it does not own.
  const posts = cms.api.posts;
  const patched = await posts?.create({
    data: { title: "Plugin field", editorsPick: 2 },
    actor: smokeActor,
    source: "cli",
  });
  if (patched?.editorsPick !== 2) {
    throw new Error("the field the plugin added did not store a value");
  }

  await posts?.delete({ id: String(patched.id), actor: smokeActor, source: "cli" }); // prettier-ignore
  await posts?.purge({ id: String(patched.id), actor: smokeActor, source: "cli" }); // prettier-ignore
  await reviews.delete({ id: String(created.id), actor: smokeActor, source: "cli" }); // prettier-ignore
  await reviews.purge({ id: String(created.id), actor: smokeActor, source: "cli" }); // prettier-ignore
  await cms.drainEvents();

  return `${plugin.id}: collection, field, node, ${plugin.routes} route(s), ${plugin.migrations.length} migration(s)`; // prettier-ignore
}

/**
 * The handler, over a real socket.
 *
 * `cms.handler` is already covered by the unit suite against an in-process
 * `Request`. What a socket adds is everything a runtime does in between:
 * multipart parsing by a real HTTP server, a streamed variant response,
 * `set-cookie` as a header rather than as a string somebody asserted, and a
 * bearer token resolved against a real Postgres. That is the half a framework
 * adapter will sit in front of, so it is the half that has to be checked per
 * deployment (section 13).
 */
async function checkHttpRoundTrip(cms: CmsInstance): Promise<string> {
  const server = Bun.serve({
    // Ephemeral: a smoke run must not fight the port `up` uses.
    port: 0,
    fetch: (request) => cms.handler(request),
  });

  try {
    const base = `http://127.0.0.1:${server.port}/api/heyo-cms`;
    const { user, token, checks: signIn } = await httpCredentials(cms, base);
    try {
      const checks = await assertHttpContract(base, token);
      return [...signIn, ...checks].join(", ");
    } finally {
      await cms.auth.users.remove(user);
      await cms.drainEvents();
    }
  } finally {
    await server.stop(true);
  }
}

/**
 * An editor, signed in through the sign-in route.
 *
 * A session rather than an API key, and for a reason the example itself
 * dictates: it declares `apiKeys.scopes: ["read", "write"]`, and `write` means
 * create and update — not the field-level `posts:publish` the example requires
 * to set `status`. A key narrowed to the scopes it was issued with therefore
 * cannot publish, which is the feature working. The panel signs people in, so
 * the smoke test does too, and gets the sign-in route checked for free.
 */
async function httpCredentials(
  cms: CmsInstance,
  base: string,
): Promise<{ user: string; token: string; checks: string[] }> {
  const email = "smoke-http@heyo.local";
  const password = "smoke-playground-password";
  const existing = await cms.auth.users.byEmail(email);
  if (existing) await cms.auth.users.remove(existing.id);

  const user = await cms.auth.users.create({
    email,
    password,
    roles: ["admin"],
  });
  await cms.drainEvents();

  const response = await fetch(`${base}/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await response.json()) as { status?: string; token?: string };
  if (response.status !== 200 || body.status !== "signed-in" || !body.token) {
    throw new Error(`sign-in over HTTP answered ${response.status}`);
  }
  const cookie = response.headers.get("set-cookie") ?? "";
  if (!cookie.includes("HttpOnly") || !cookie.includes("heyo_cms_session")) {
    throw new Error(`the session cookie is missing or readable: "${cookie}"`);
  }

  const session = await fetch(`${base}/auth/session`, {
    headers: { cookie: cookie.split(";")[0] ?? "" },
  });
  const resolved = (await session.json()) as { user?: { email?: string } };
  if (resolved.user?.email !== email) {
    throw new Error("the session cookie did not authenticate");
  }

  return {
    user: user.id,
    token: body.token,
    checks: ["sign-in", "session cookie"],
  };
}

/**
 * The assertions every deployment has to satisfy, whatever is in front of the
 * handler. Shared by the in-process server above and by the framework
 * examples the generator produces in stage 10.
 */
async function assertHttpContract(
  base: string,
  token: string,
): Promise<string[]> {
  const authorized = { authorization: `Bearer ${token}` };

  const call = async (
    path: string,
    init: RequestInit = {},
  ): Promise<{
    status: number;
    body: Record<string, unknown>;
    text: string;
  }> => {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return {
      status: response.status,
      text,
      body: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : {}, // prettier-ignore
    };
  };

  const spec = await call("/openapi.json");
  if (
    spec.status !== 200 ||
    !(spec.body.paths as Record<string, unknown>)?.["/posts"]
  ) {
    // prettier-ignore
    throw new Error(`openapi.json answered ${spec.status} without /posts`);
  }

  // Anonymous reads are the example's `read: () => true`; anonymous writes
  // are refused by the same rules the local API applies.
  const anonymous = await call("/posts");
  if (anonymous.status !== 200) {
    throw new Error(`GET /posts answered ${anonymous.status}`);
  }
  const refused = await call("/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: { title: "Nope" } }),
  });
  if (refused.status !== 403 && refused.status !== 401) {
    throw new Error(`an anonymous write answered ${refused.status}`);
  }

  const created = await call("/posts", {
    method: "POST",
    headers: { ...authorized, "content-type": "application/json" },
    body: JSON.stringify({ data: { title: "Over HTTP", status: "draft" } }),
  });
  if (created.status !== 201) {
    throw new Error(`POST /posts answered ${created.status}: ${created.text}`);
  }
  const id = String(created.body.id);

  const published = await call(`/posts/${id}`, {
    method: "PATCH",
    headers: { ...authorized, "content-type": "application/json" },
    body: JSON.stringify({ data: { status: "published" } }),
  });
  if (published.body.status !== "published") {
    throw new Error(`the publish answered ${published.status}: ${published.text}`); // prettier-ignore
  }

  const filtered = await call("/posts?status=published&count=true");
  if ((filtered.body.totalDocs as number) < 1) {
    throw new Error("the filter found nothing it had just written");
  }

  // A file, through multipart parsed by a real server.
  const form = new FormData();
  form.set(
    "file",
    new Blob(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="100%" height="100%"/></svg>',
      ],
      { type: "image/svg+xml" },
    ),
    "over-http.svg",
  );
  const uploaded = await call("/media/upload", {
    method: "POST",
    headers: authorized,
    body: form,
  });
  if (uploaded.status !== 201 || uploaded.body.width !== 320) {
    throw new Error(`the upload answered ${uploaded.status}: ${uploaded.text}`);
  }
  const mediaId = String(uploaded.body.id);

  const bytes = await fetch(`${base}/media/${mediaId}/thumb`);
  const body = await bytes.arrayBuffer();
  if (!bytes.ok || body.byteLength === 0) {
    throw new Error(`serving a variant answered ${bytes.status}`);
  }

  const trashed = await call(`/posts/${id}`, {
    method: "DELETE",
    headers: authorized,
  });
  if (trashed.status !== 200 || trashed.body.deletedAt === null) {
    throw new Error(`the delete answered ${trashed.status}`);
  }
  const bin = await call("/trash", { headers: authorized });
  const entries = (bin.body.entries ?? []) as { id: string }[];
  if (!entries.some((entry) => entry.id === id)) {
    throw new Error("the deleted document is not in the trash over HTTP");
  }

  const purged = await call(`/trash/posts/${id}`, {
    method: "DELETE",
    headers: authorized,
  });
  if (purged.status !== 200) {
    throw new Error(`the purge answered ${purged.status}: ${purged.text}`);
  }
  await call(`/media/${mediaId}?force=true`, {
    method: "DELETE",
    headers: authorized,
  });

  // The panel: the shell, what it is told about this deployment, and the
  // bundle it actually asks for. Serving HTML that references a script the
  // handler cannot produce is the one failure mode that looks fine in a
  // status code.
  const panel = await call("/admin");
  const script = /<script type="module" src="([^"]+)"/.exec(panel.text)?.[1];
  if (panel.status !== 200 || !panel.text.includes('id="heyo-cms-panel"')) {
    throw new Error(`the panel route answered ${panel.status}`);
  }
  if (!script) throw new Error("the panel shell references no bundle");

  // The shell writes absolute paths, so the origin comes from `base`.
  const bundle = await fetch(new URL(script, base));
  if (
    bundle.status !== 200 ||
    !(bundle.headers.get("content-type") ?? "").includes("javascript")
  ) {
    throw new Error(`the panel bundle answered ${bundle.status}`);
  }

  const described = await call("/panel");
  const collections = (described.body.collections ?? []) as unknown[];
  if (described.status !== 200 || collections.length === 0) {
    throw new Error(`GET /panel answered ${described.status}`);
  }

  // The first-account door, from the outside. An account exists by now — the
  // credential these checks run as — so both halves are decided: the panel
  // must not draw the claim form, and the route must refuse to claim. A build
  // too old to know the question answers `undefined` here, which is how this
  // also catches an example running yesterday's package.
  const auth = (described.body.auth ?? {}) as { setupRequired?: unknown };
  if (typeof auth.setupRequired !== "boolean") {
    throw new Error(
      "GET /panel does not describe auth.setupRequired; the example is running an older @heyo-sh/heyo-cms",
    );
  }
  if (auth.setupRequired) {
    throw new Error("the panel offers to claim a CMS that already has an account"); // prettier-ignore
  }
  const claim = await call("/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "squatter@heyo.local",
      password: "smoke-playground-password",
    }),
  });
  if (claim.status !== 409) {
    throw new Error(`POST /auth/setup answered ${claim.status}, not 409`);
  }

  const missing = await call("/not-a-route");
  if (missing.status !== 404 || !missing.text.includes("not_found")) {
    throw new Error(`an unknown route answered ${missing.status}`);
  }

  return [
    "openapi",
    "anonymous read refused a write",
    "first account closed",
    "create",
    "publish",
    "filter",
    "upload",
    "variant",
    "trash",
    "purge",
    "panel shell, bundle and /panel",
  ];
}

/**
 * HTTP checks for `app` examples: the same contract, through a framework.
 *
 * The credential is made the way a person would make one — an editor account
 * through the local API, signed in over the dev server's own sign-in route —
 * rather than injected as a magic environment variable. That is also the only
 * honest way to do it: an API key is a row, so a token the database has never
 * seen authenticates nobody.
 */
async function runHttpChecks(
  example: Example,
  environment: Record<string, string>,
): Promise<number> {
  const base = `${baseUrl(example)}/api/heyo-cms`;

  // First, while the dev server is the only process with the database open:
  // a Cloudflare example's local D1 is one SQLite file, and the sweeps need its
  // write lock, which the connection `loadExample` opens below would contend for.
  try {
    const cron = await assertCronRoute(baseUrl(example));
    console.log(`  ✓ the cron route runs the sweeps (${cron.join(", ")})`);
  } catch (error) {
    console.log(`  ✗ ${errorMessage(error)}`);
    return 1;
  }

  const loaded = await loadExample(example, environment);
  try {
    const { user, token } = await httpCredentials(loaded.cms, base);
    try {
      const checks = await assertHttpContract(base, token);
      console.log(`  ✓ the CMS handler answers (${checks.join(", ")})`);
      const cached = await assertCachedViews(baseUrl(example), base, token);
      console.log(`  ✓ the post views invalidate (${cached.join(", ")})`);
      return 0;
    } finally {
      await loaded.cms.auth.users.remove(user);
      await loaded.cms.drainEvents();
    }
  } catch (error) {
    console.log(`  ✗ ${errorMessage(error)}`);
    return 1;
  } finally {
    await loaded.dispose();
  }
}

/**
 * `/api/cron`, the route a platform's cron calls: only with `CRON_SECRET`, and
 * then it runs the sweeps.
 *
 * The secret reaches the dev server in `.env` (`devEnvFile`), so this is also
 * the check that each template reads it at request time, from where a reader
 * puts it. A route that read it at build time instead — Astro's
 * `import.meta.env.CRON_SECRET` — passes in dev and breaks in production,
 * which the scaffold test guards against.
 */
async function assertCronRoute(site: string): Promise<string[]> {
  const cron = (authorization?: string) =>
    fetch(`${site}/api/cron`, {
      headers: authorization ? { authorization } : {},
      signal: AbortSignal.timeout(30_000),
    });

  const anonymous = await cron();
  await anonymous.arrayBuffer();
  if (anonymous.status !== 401) {
    throw new Error(`/api/cron without a secret answered ${anonymous.status}, not 401`); // prettier-ignore
  }
  const wrong = await cron("Bearer not-the-secret");
  await wrong.arrayBuffer();
  if (wrong.status !== 401) {
    throw new Error(`/api/cron with the wrong secret answered ${wrong.status}, not 401`); // prettier-ignore
  }
  const authorized = await cron(`Bearer ${cronSecret}`);
  const text = await authorized.text();
  if (authorized.status !== 200 || !text.includes('"ranAt"')) {
    throw new Error(`/api/cron with CRON_SECRET answered ${authorized.status}: ${text.slice(0, 200)}`); // prettier-ignore
  }
  return ["401 without", "401 wrong", "200 with"];
}

/**
 * The two views a generated project ships, and the promise they make.
 *
 * The templates cache the post list and the post page and purge them from a
 * write hook, which is the one feature in a generated project that cannot
 * fail loudly: a stale page is a correct-looking page with yesterday's words
 * in it. A build check cannot see it and a unit test cannot either — it needs
 * a real server, a real write over HTTP and a second read.
 *
 * "By the second read" rather than "immediately" because that is what the
 * contract says. Next.js serves the stale copy to the request that triggers
 * the revalidation, which is the behaviour the templates ask for: nobody
 * waits for a database round trip because somebody else pressed save.
 */
async function assertCachedViews(
  site: string,
  base: string,
  token: string,
): Promise<string[]> {
  const authorized = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const handle = `cache-check-${Date.now().toString(36)}`;
  const read = async (path: string): Promise<string> => {
    const response = await fetch(`${site}${path}`);
    if (!response.ok)
      throw new Error(`GET ${path} answered ${response.status}`);
    return response.text();
  };
  /**
   * Twice, because once is not what the templates promise.
   *
   * Purging marks an entry stale: the request that finds it stale is served
   * the old copy and starts the re-read behind it, so the new words are there
   * on the next one. Asserting on the first read would be asserting a
   * blocking invalidation nobody asked for.
   */
  const readUntil = async (path: string, needle: string): Promise<boolean> => {
    if ((await read(path)).includes(needle)) return true;
    return (await read(path)).includes(needle);
  };

  const created = await fetch(`${base}/posts`, {
    method: "POST",
    headers: authorized,
    body: JSON.stringify({
      data: { title: "Before the edit", handle, status: "published" },
    }),
  });
  if (created.status !== 201) {
    throw new Error(`creating the cached post answered ${created.status}`);
  }
  const id = String(((await created.json()) as { id: unknown }).id);

  try {
    // Read both views first: whatever holds them is now holding this.
    if (!(await readUntil(`/posts/${handle}`, "Before the edit"))) {
      throw new Error(`/posts/${handle} does not render the post it was given`);
    }
    if (!(await readUntil("/", "Before the edit"))) {
      throw new Error("the front page does not list a published post");
    }

    const edited = await fetch(`${base}/posts/${id}`, {
      method: "PATCH",
      headers: authorized,
      body: JSON.stringify({ data: { title: "After the edit" } }),
    });
    if (edited.status !== 200) {
      throw new Error(`editing the cached post answered ${edited.status}`);
    }

    for (const path of [`/posts/${handle}`, "/"]) {
      if (!(await readUntil(path, "After the edit"))) {
        throw new Error(
          `${path} still serves the old title after the write that purged it`,
        );
      }
    }
    return ["list", "detail", "purged on write"];
  } finally {
    await fetch(`${base}/posts/${id}`, { method: "DELETE", headers: authorized }); // prettier-ignore
    await fetch(`${base}/trash/posts/${id}`, { method: "DELETE", headers: authorized }); // prettier-ignore
  }
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/**
 * Writes the example with the generator, the first time it is needed.
 *
 * None of the six framework examples is checked in. They are what
 * `bun create @heyo-sh/heyo-cms` produces, with local release tarballs instead
 * of registry versions. They are deliberately not workspaces: installing an
 * ignored example must not change the repository's frozen lockfile. Packaging
 * also catches missing published assets and unresolved workspace protocols.
 * Existing examples are reused; move them away to regenerate changed templates.
 *
 * What is *not* reused is the installed copy of the two packages. They arrive
 * as tarballs, so `node_modules` holds a snapshot of a `dist` rather than a
 * link to it, and an example booted against last hour's snapshot is the worst
 * kind of green: the feature is in the repository, the panel does not have
 * it, and nothing says so. A `dist` newer than the installed copy is
 * therefore repacked and reinstalled before the example boots.
 */
async function ensureScaffolded(example: Example): Promise<void> {
  if (example.kind !== "app" || !example.generate) return;
  const directory = join(examplesRoot, example.name);
  const installed = existsSync(join(directory, "node_modules"));
  if (
    isScaffolded(example) &&
    installed &&
    !(await packagesAreStale(directory))
  ) {
    // prettier-ignore
    return;
  }

  if (!isScaffolded(example)) {
    console.log(`  scaffolding ${example.name} with create-heyo-cms…`);
    await rm(directory, { recursive: true, force: true });
    await scaffoldProject({
      ...example.generate,
      projectName: example.name,
      packageManager: "bun",
      install: false,
      cwd: examplesRoot,
    });
  } else if (installed) {
    console.log(`  ${example.name} has an older @heyo-sh build installed; refreshing…`); // prettier-ignore
  }

  const manifestPath = join(directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  await mkdir(logDirectory, { recursive: true });
  for (const name of ["heyo-cms", "heyo-cms-admin"]) {
    const packed = await execute(
      "npm",
      ["pack", "--json", "--pack-destination", logDirectory],
      {
        cwd: join(repositoryRoot, "packages", name),
      },
    );
    if (packed.code !== 0) throw new Error(packed.output);
    const [{ filename }] = JSON.parse(packed.output) as [{ filename: string }];
    manifest.dependencies[`@heyo-sh/${name}`] =
      `file:${await stampTarball(name, join(logDirectory, filename))}`;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  installing ${example.name}… (this takes a minute the first time)`); // prettier-ignore
  const result = await execute(
    "npm",
    ["install", "--workspaces=false", "--no-audit", "--no-fund"],
    { cwd: directory },
  );
  if (result.code !== 0) {
    throw new Error(
      `npm install failed for ${example.name}:\n${result.output}`,
    );
  }
}

/**
 * Gives the tarball a name no cache has seen, and sweeps the ones it replaces.
 *
 * `npm pack` names its output after the package and its version, neither of
 * which moves while a feature is being written. npm keys both its content
 * cache and the example's lockfile by the specifier, so reinstalling the same
 * path with different bytes quietly restores the *old* copy — the failure
 * this is here to prevent, and an invisible one: the example boots, serves a
 * month-old panel, and says nothing. A digest in the filename makes new bytes
 * a new dependency, which is the one thing npm cannot shortcut.
 */
async function stampTarball(name: string, packed: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(packed).arrayBuffer());
  const digest = Bun.hash(bytes).toString(16).padStart(16, "0");
  const stamped = join(logDirectory, `heyo-sh-${name}-${digest}.tgz`);
  await rename(packed, stamped);

  // Every earlier digest of this package, which is every tarball nothing can
  // reach any more: the manifest is about to name this one.
  // Digests, and the version-named files packed before this function existed.
  const stale = new RegExp(
    `^heyo-sh-${name}-(?:[0-9a-f]{16}|\\d+\\.\\d+\\.\\d+)\\.tgz$`,
  );
  for (const entry of await readdir(logDirectory)) {
    if (!stale.test(entry) || join(logDirectory, entry) === stamped) continue;
    await rm(join(logDirectory, entry), { force: true });
  }
  return stamped;
}

/**
 * Whether the example is running an older build than the repository has.
 *
 * Modification times rather than versions: the version in `package.json` is
 * the published one and does not move while a feature is being written, which
 * is exactly the window in which this question is asked. The newest file in
 * each `dist` against the installed copy's own timestamp answers it without
 * hashing a bundle on every boot.
 */
async function packagesAreStale(directory: string): Promise<boolean> {
  for (const name of ["heyo-cms", "heyo-cms-admin"]) {
    const built = await newestFileTime(
      join(repositoryRoot, "packages", name, "dist"),
    );
    const present = await newestFileTime(
      join(directory, "node_modules", "@heyo-sh", name, "package.json"),
    );
    // No `dist` means `--no-build` on a checkout that was never built, which
    // the boot itself will complain about more clearly than this would.
    if (built === 0) continue;
    if (present === 0 || built > present) return true;
  }
  return false;
}

/** The most recent mtime under a path, or `0` if it is not there. */
async function newestFileTime(path: string): Promise<number> {
  let newest = 0;
  const visit = async (entry: string): Promise<void> => {
    const info = await stat(entry).catch(() => null);
    if (!info) return;
    newest = Math.max(newest, info.mtimeMs);
    if (!info.isDirectory()) return;
    for (const child of await readdir(entry)) await visit(join(entry, child));
  };
  await visit(path);
  return newest;
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

  const environment: Record<string, string> =
    example.database === "mongodb"
      ? { MONGODB_URL: await resolveMongo(example) }
      : { DATABASE_URL: await preparePostgres(example) };

  // A generated project migrates itself, with its own script and its own
  // copy of the CLI. Doing it in-process here would check a path no reader
  // has.
  if (example.kind === "app")
    await applyProjectMigrations(example, environment);
  return environment;
}

/**
 * Applies the bundled migrations to the Miniflare state directory every
 * Cloudflare dev proxy reads, so `next|astro|react-router dev` sees the same
 * D1 the deployed Worker would, without `wrangler dev`.
 */
async function applyD1Migrations(example: Example): Promise<void> {
  const directory = join(examplesRoot, example.name);
  const result = await execute(
    binaryPath(directory, "wrangler"),
    ["d1", "migrations", "apply", "DB", "--local"],
    { cwd: directory, input: "y\n" },
  );
  if (result.code !== 0) {
    throw new Error(`wrangler d1 migrations apply failed:\n${result.output}`);
  }
  console.log("  database: local D1 migrated");
}

/** `bun run db:migrate`, in the example, exactly as the README says. */
async function applyProjectMigrations(
  example: Example,
  environment: Record<string, string>,
): Promise<void> {
  const directory = join(examplesRoot, example.name);
  const result = await execute("bun", ["run", "db:migrate"], {
    cwd: directory,
    env: environment,
  });
  if (result.code !== 0) {
    throw new Error(`db:migrate failed in ${example.name}:\n${result.output}`);
  }
  console.log("  database: migrated");
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

  const restoreEnvFile = await devEnvFile(directory, { CRON_SECRET: cronSecret }); // prettier-ignore
  const { CRON_SECRET: _inherited, ...inherited } = process.env;
  const child = spawn(
    binaryPath(directory, example.bin as string),
    ["dev", "--port", String(example.port)],
    {
      cwd: directory,
      detached: true,
      stdio: logFile === undefined ? "inherit" : ["ignore", logFile, logFile],
      env: {
        ...inherited,
        ...environment,
        HEYO_TELEMETRY_DISABLED: "1",
        NODE_ENV: "development",
        BROWSER: "none",
      },
    },
  );

  const server: RunningServer = {
    stop: async () => {
      await stopDevServer(child, example.port);
      await restoreEnvFile();
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
 * Writes `values` into the project's `.env` for the life of a dev server, and
 * returns what puts the file back.
 *
 * In the file rather than in the server's environment, because the file is
 * what a reader has. Every framework sees a variable of the process; not every
 * one hands `.env` to the code that reads it — Astro gives it to
 * `import.meta.env` only, and a Worker sees neither unless its plugin loads
 * the file — so a variable passed the easy way checks a path nobody uses. A
 * `.env` of the reader's own is kept: the lines are added to it, and the file
 * is restored byte for byte.
 */
async function devEnvFile(
  directory: string,
  values: Record<string, string>,
): Promise<() => Promise<void>> {
  const path = join(directory, ".env");
  const previous = await readFile(path, "utf8").catch(() => null);
  const names = new Set(Object.keys(values));
  const kept = (previous ?? "")
    .split("\n")
    .filter((line) => !names.has(/^\s*(?:export\s+)?([\w.]+)\s*=/.exec(line)?.[1] ?? "")); // prettier-ignore
  const added = Object.entries(values).map(
    ([name, value]) => `${name}=${value}`,
  );
  await writeFile(path, `${[...kept.filter((line) => line !== ""), ...added].join("\n")}\n`); // prettier-ignore
  return async () => {
    if (previous === null) await rm(path, { force: true });
    else await writeFile(path, previous);
  };
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
/**
 * The packages the examples import.
 *
 * Both, because an example configuration mounts the panel
 * (`assets: adminAssets()`) and that package resolves to its `dist`: the
 * bundle is the artefact, and a stale one would be served without saying so.
 */
async function buildPackage(): Promise<void> {
  for (const name of ["@heyo-sh/heyo-cms", "@heyo-sh/heyo-cms-admin"]) {
    console.log(`  building ${name}…`);
    const result = await execute("bun", ["run", "--filter", name, "build"], {
      cwd: repositoryRoot,
    });
    if (result.code !== 0) {
      throw new Error(`${name} failed to build:\n${result.output}`);
    }
  }
}

function binaryPath(directory: string, bin: string): string {
  const local = join(directory, "node_modules", ".bin", bin);
  return existsSync(local) ? local : bin;
}

async function execute(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; output: string }> {
  try {
    const child = Bun.spawn([command, ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: {
        ...process.env,
        HEYO_TELEMETRY_DISABLED: "1",
        NEXT_TELEMETRY_DISABLED: "1",
        ASTRO_TELEMETRY_DISABLED: "1",
        WRANGLER_SEND_METRICS: "false",
        ...options.env,
      },
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
