import type { DatabaseAdapter } from "../types/database";
import { SqlDatabaseAdapter } from "./sql/adapter";
import { sqliteDialect } from "./sql/dialect";
import { splitStatements, type SqlDriver } from "./sql/driver";

/** The Cloudflare D1 binding, typed structurally so no SDK is imported. */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  exec?(sql: string): Promise<unknown>;
  batch?(statements: D1PreparedStatement[]): Promise<unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

class D1Driver implements SqlDriver {
  readonly id = "d1";

  constructor(private readonly binding: D1Database) {}

  async all(
    sql: string,
    values: unknown[],
  ): Promise<Record<string, unknown>[]> {
    const result = await this.bind(sql, values).all();
    return result.results ?? [];
  }

  async run(sql: string, values: unknown[]): Promise<{ rowsAffected: number }> {
    const result = await this.bind(sql, values).run();
    return { rowsAffected: result.meta?.changes ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    // D1's own `exec` rejects multi-statement input in some runtimes, so the
    // file is split here and sent statement by statement.
    for (const statement of splitStatements(sql)) {
      await this.binding.prepare(statement).run();
    }
  }

  private bind(sql: string, values: unknown[]): D1PreparedStatement {
    const prepared = this.binding.prepare(sql);
    return values.length > 0 ? prepared.bind(...values) : prepared;
  }
}

/**
 * Creates the D1 adapter.
 *
 * D1 has no interactive transactions — only batches — so the adapter declares
 * `transactions: false` and the engine switches to the compensating path:
 * the outbox row is written with the document in one statement, and the
 * worker that delivers it is idempotent (section 12). Pretending otherwise
 * would mean a rollback that silently did not roll back.
 */
export function d1(binding: D1Database): DatabaseAdapter {
  return new SqlDatabaseAdapter(new D1Driver(binding), sqliteDialect, {
    capabilities: { transactions: false },
  });
}
