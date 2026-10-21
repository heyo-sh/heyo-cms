import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CmsConfigError } from "./errors";
import { checksum } from "./ids";
import { migrationName } from "./schema/describe";
import { emptySnapshot } from "./schema/snapshot";
import { stableStringify } from "./schema/plan";
import type { DatabaseAdapter } from "./types/database";
import type {
  MigrationArtifact,
  MigrationStep,
  SchemaSnapshot,
} from "./types/schema";

/** The file that records what the last `generate` believed the schema to be. */
const snapshotFile = "meta/snapshot.json";
/** Which plugin migrations have already been written into this directory. */
const pluginLogFile = "meta/plugins.json";

export interface StoredMigration {
  id: string;
  file: string;
  artifact: MigrationArtifact;
  checksum: string;
}

/**
 * The migrations directory.
 *
 * Two things live here: numbered migration files, and one snapshot of the
 * schema they add up to. `generate` diffs the configuration against that
 * snapshot — never against a live database — so it works offline, produces
 * the same file on every machine, and can never propose dropping a table it
 * does not own.
 */
export class MigrationStore {
  constructor(private readonly directory: string) {}

  async readSnapshot(): Promise<SchemaSnapshot> {
    try {
      const content = await readFile(
        join(this.directory, snapshotFile),
        "utf8",
      );
      return JSON.parse(content) as SchemaSnapshot;
    } catch {
      // No snapshot means no migration has ever been generated, which is a
      // first run rather than an error.
      return emptySnapshot();
    }
  }

  async writeSnapshot(snapshot: SchemaSnapshot): Promise<void> {
    await mkdir(join(this.directory, "meta"), { recursive: true });
    await writeFile(
      join(this.directory, snapshotFile),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
  }

  /**
   * Plugin migrations already turned into files.
   *
   * A separate log from the schema snapshot because they are a different
   * kind of fact: the snapshot says what the schema looked like, this says
   * which hand-written step lists have been emitted. Keyed `plugin:id`, so
   * two plugins may use the same migration id without colliding.
   */
  async readPluginLog(): Promise<string[]> {
    try {
      const content = await readFile(
        join(this.directory, pluginLogFile),
        "utf8",
      );
      const parsed: unknown = JSON.parse(content);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  }

  async writePluginLog(entries: string[]): Promise<void> {
    await mkdir(join(this.directory, "meta"), { recursive: true });
    await writeFile(
      join(this.directory, pluginLogFile),
      `${JSON.stringify(entries, null, 2)}\n`,
      "utf8",
    );
  }

  async list(): Promise<StoredMigration[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return [];
    }

    const migrations: StoredMigration[] = [];
    for (const entry of entries.sort()) {
      const match = /^(\d{4}_[a-z0-9_]+)\.(sql|json)$/.exec(entry);
      if (!match) continue;
      const content = await readFile(join(this.directory, entry), "utf8");
      const id = match[1] as string;
      const extension = match[2] as "sql" | "json";
      migrations.push({
        id,
        file: entry,
        checksum: checksum(content),
        artifact: {
          id,
          extension,
          content,
          summary: summaryOf(content, extension),
        },
      });
    }
    return migrations;
  }

  async write(artifact: MigrationArtifact): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const file = `${artifact.id}.${artifact.extension}`;
    await writeFile(join(this.directory, file), artifact.content, "utf8");
    return file;
  }

  async nextSequence(): Promise<string> {
    const migrations = await this.list();
    const last = migrations.at(-1);
    const next = last ? Number(last.id.slice(0, 4)) + 1 : 0;
    return String(next).padStart(4, "0");
  }
}

function summaryOf(content: string, extension: "sql" | "json"): string[] {
  if (extension === "json") {
    const parsed = JSON.parse(content) as { summary?: string[] };
    return parsed.summary ?? [];
  }
  return content
    .split("\n")
    .filter((line) => line.startsWith("-- ") && !/^-- \d{4}_/.test(line))
    .map((line) => line.slice(3));
}

export interface GenerateResult {
  created: boolean;
  id?: string;
  file?: string;
  summary: string[];
  /** Plugin migrations written by this run, newest last. */
  plugins?: { id: string; file: string }[];
}

/** A plugin's migration, with the plugin it came from. */
export interface PluginMigrationInput {
  plugin: string;
  id: string;
  steps: MigrationStep[];
}

/**
 * Plugin migrations, written as ordinary files.
 *
 * A plugin ships neutral steps rather than SQL (section 2), and this is
 * where they become something a human can review in a pull request and a
 * `migrate` can apply in order. They are written *after* the schema diff of
 * the same run, because that is the only order that works: a plugin's steps
 * talk about tables — its own, from `schema.tables`, or `documents` — and
 * those tables are created by the diff.
 *
 * The log is what makes it idempotent. Running `generate` twice must not
 * write the same backfill twice, and the plugin cannot know whether it
 * already has.
 */
export async function generatePluginMigrations(options: {
  adapter: DatabaseAdapter;
  store: MigrationStore;
  plugins: PluginMigrationInput[];
}): Promise<{ id: string; file: string }[]> {
  const { adapter, store } = options;
  if (options.plugins.length === 0) return [];

  const log = await store.readPluginLog();
  const written: { id: string; file: string }[] = [];
  const seen = new Set(log);

  for (const migration of options.plugins) {
    const key = `${migration.plugin}:${migration.id}`;
    if (seen.has(key)) continue;
    if (migration.steps.length === 0) {
      seen.add(key);
      continue;
    }

    const sequence = await store.nextSequence();
    const id = `${sequence}_${slug(migration.plugin)}_${slug(migration.id)}`;
    const artifact = adapter.render(migration.steps, id);
    const file = await store.write(artifact);
    seen.add(key);
    written.push({ id, file });
  }

  if (written.length > 0) await store.writePluginLog([...seen]);
  return written;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Writes a migration for whatever changed since the last one.
 *
 * Returns `created: false` when nothing changed. That is the property the
 * plan asks for by name: running `generate` twice on an unchanged
 * configuration must produce nothing, or nobody can tell a real migration
 * from noise in a pull request.
 */
export async function generateMigration(options: {
  adapter: DatabaseAdapter;
  store: MigrationStore;
  target: SchemaSnapshot;
  name?: string;
  /** Steps the installed plugins ship, written before the schema diff. */
  plugins?: PluginMigrationInput[];
}): Promise<GenerateResult> {
  const { adapter, store, target } = options;
  const previous = await store.readSnapshot();
  const steps = adapter.plan(previous, target);

  let created: { id: string; file: string; summary: string[] } | undefined;
  if (steps.length > 0) {
    const sequence = await store.nextSequence();
    const id = `${sequence}_${options.name ?? migrationName(steps)}`;
    const artifact = adapter.render(steps, id);
    const file = await store.write(artifact);
    await store.writeSnapshot(target);
    created = { id, file, summary: artifact.summary };
  }

  const plugins = await generatePluginMigrations({
    adapter,
    store,
    plugins: options.plugins ?? [],
  });

  if (!created) {
    return {
      created: false,
      summary: [],
      ...(plugins.length === 0 ? {} : { plugins }),
    };
  }

  return {
    created: true,
    id: created.id,
    file: created.file,
    summary: created.summary,
    ...(plugins.length === 0 ? {} : { plugins }),
  };
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

/** Applies every migration the journal has not seen yet, in order. */
export async function runMigrations(options: {
  adapter: DatabaseAdapter;
  store: MigrationStore;
}): Promise<MigrateResult> {
  const { adapter, store } = options;
  const [migrations, applied] = await Promise.all([
    store.list(),
    adapter.listAppliedMigrations(),
  ]);
  const journal = new Map(applied.map((entry) => [entry.id, entry]));

  const result: MigrateResult = { applied: [], alreadyApplied: 0 };
  for (const migration of migrations) {
    const record = journal.get(migration.id);
    if (record) {
      assertUnchanged(migration, record.checksum);
      result.alreadyApplied += 1;
      continue;
    }
    await adapter.applyMigration(migration.artifact);
    await adapter.recordMigration(migration.id, migration.checksum);
    result.applied.push(migration.id);
  }
  return result;
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  /** Files that changed after they were applied. */
  modified: string[];
  /** Steps the configuration needs that no migration covers yet. */
  unplanned: string[];
}

/** Answers "is this database up to date, and is this repository?". */
export async function migrationStatus(options: {
  adapter: DatabaseAdapter;
  store: MigrationStore;
  target?: SchemaSnapshot;
}): Promise<MigrationStatus> {
  const { adapter, store } = options;
  const [migrations, applied] = await Promise.all([
    store.list(),
    adapter.listAppliedMigrations(),
  ]);
  const journal = new Map(applied.map((entry) => [entry.id, entry]));

  const status: MigrationStatus = {
    applied: [],
    pending: [],
    modified: [],
    unplanned: [],
  };

  for (const migration of migrations) {
    const record = journal.get(migration.id);
    if (!record) {
      status.pending.push(migration.id);
      continue;
    }
    status.applied.push(migration.id);
    if (record.checksum !== migration.checksum) {
      status.modified.push(migration.id);
    }
  }

  if (options.target) {
    const previous = await store.readSnapshot();
    status.unplanned = adapter
      .plan(previous, options.target)
      .map((step) => stableStringify(step));
  }

  return status;
}

/**
 * A migration that changed after it ran is not a migration any more.
 *
 * Editing an applied file silently puts every other environment on a
 * different schema from this one, and the mismatch surfaces weeks later as a
 * missing column. Refusing is the only safe answer.
 */
function assertUnchanged(migration: StoredMigration, recorded: string): void {
  if (migration.checksum === recorded) return;
  throw new CmsConfigError(
    migration.file,
    "was modified after it was applied; revert it and write a new migration instead",
  );
}
