import { CmsConfigError } from "../errors";
import type {
  DatabaseAdapter,
  DatabaseAdapterFactory,
} from "../types/database";
import { SqlDatabaseAdapter } from "./sql/adapter";
import { sqliteDialect } from "./sql/dialect";
import type { SqlDriver } from "./sql/driver";

/**
 * What `bun:sqlite` and `node:sqlite` both already are.
 *
 * Synchronous, prepared-statement based, and identical enough in shape that
 * one driver covers both runtimes. Neither module is imported here: a Worker
 * bundle must not pull in a native SQLite it will never run.
 */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close?(): void;
}

export interface SqliteStatement {
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes?: number | bigint };
}

export interface SqliteOptions {
  id?: string;
  /**
   * How long a write waits for another connection's lock, in milliseconds,
   * before it fails with "database is locked". Defaults to 5000, the value
   * `better-sqlite3` uses; `bun:sqlite` and `node:sqlite` start at 0, which
   * fails the moment a second process — the CLI next to a dev server — is
   * writing. A timeout the database was already given is kept unless this
   * is set.
   */
  busyTimeout?: number;
}

const DEFAULT_BUSY_TIMEOUT = 5000;

export interface SqliteFileOptions extends SqliteOptions {
  /** Path on disk. `:memory:` is accepted and is what the tests use. */
  file: string;
}

class SqliteDriver implements SqlDriver {
  readonly id: string;

  constructor(
    private readonly database: SqliteDatabase,
    id = "sqlite",
  ) {
    this.id = id;
  }

  async all(
    sql: string,
    values: unknown[],
  ): Promise<Record<string, unknown>[]> {
    return this.database.prepare(sql).all(...values) as Record<
      string,
      unknown
    >[];
  }

  async run(sql: string, values: unknown[]): Promise<{ rowsAffected: number }> {
    const result = this.database.prepare(sql).run(...values);
    return { rowsAffected: Number(result.changes ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  async close(): Promise<void> {
    this.database.close?.();
  }
}

/**
 * Creates the SQLite adapter.
 *
 * Transactions use the generic `BEGIN`/`COMMIT` path in the adapter, opened
 * as `BEGIN IMMEDIATE` (see `sqliteDialect`): SQLite has exactly one writer,
 * so there is no pool to pin a transaction to, and the write lock is better
 * taken up front, where the busy timeout below can wait for it.
 *
 * Passing `{ file }` opens the database on first use through whichever SQLite
 * the runtime provides — `bun:sqlite` or `node:sqlite` — so a configuration
 * module stays importable in a runtime that has neither.
 */
export function sqlite(options: SqliteFileOptions): DatabaseAdapterFactory;
export function sqlite(
  database: SqliteDatabase,
  options?: SqliteOptions,
): DatabaseAdapter;
export function sqlite(
  source: SqliteDatabase | SqliteFileOptions,
  options: SqliteOptions = {},
): DatabaseAdapter | DatabaseAdapterFactory {
  if ("file" in source && typeof source.file === "string") {
    return async () => sqlite(await openFile(source.file), source);
  }
  const database = source as SqliteDatabase;
  applyBusyTimeout(database, options.busyTimeout);
  return new SqlDatabaseAdapter(
    new SqliteDriver(database, options.id ?? "sqlite"),
    sqliteDialect,
  );
}

/**
 * One file, one writer at a time: SQLite makes every other writer wait for
 * the lock, and this is how long. Without it, `heyo-cms seed` run while
 * `dev` is serving a Cloudflare project's local D1 fails at random.
 */
function applyBusyTimeout(
  database: SqliteDatabase,
  explicit: number | undefined,
): void {
  if (explicit === undefined) {
    const [current] = database.prepare("PRAGMA busy_timeout").all() as {
      timeout?: number;
    }[];
    if (Number(current?.timeout ?? 0) > 0) return;
  } else if (!Number.isFinite(explicit) || explicit < 0) {
    throw new CmsConfigError(
      "database",
      "busyTimeout must be a number of milliseconds, 0 or more",
    );
  }
  database.exec(
    `PRAGMA busy_timeout = ${Math.trunc(explicit ?? DEFAULT_BUSY_TIMEOUT)}`,
  );
}

async function openFile(file: string): Promise<SqliteDatabase> {
  for (const moduleName of ["bun:sqlite", "node:sqlite"]) {
    try {
      const module = (await import(moduleName)) as {
        Database?: new (path: string) => SqliteDatabase;
        DatabaseSync?: new (path: string) => SqliteDatabase;
      };
      const Constructor = module.Database ?? module.DatabaseSync;
      if (Constructor) return new Constructor(file);
    } catch {
      // Try the next runtime; neither being present is the real error.
    }
  }
  throw new CmsConfigError(
    "database",
    "no SQLite is available in this runtime; pass a database instance instead",
  );
}
