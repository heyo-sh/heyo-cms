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
}

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
 * Transactions use the generic `BEGIN`/`COMMIT` path in the adapter: SQLite
 * has exactly one writer, so there is no pool to pin a transaction to.
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
  return new SqlDatabaseAdapter(
    new SqliteDriver(source as SqliteDatabase, options.id ?? "sqlite"),
    sqliteDialect,
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
