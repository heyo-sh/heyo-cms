import { CmsConfigError } from "../errors";
import type {
  DatabaseAdapter,
  DatabaseAdapterFactory,
} from "../types/database";
import { SqlDatabaseAdapter } from "./sql/adapter";
import { postgresDialect } from "./sql/dialect";
import type { SqlDriver } from "./sql/driver";

/**
 * The shape `pg`, Neon, Supabase and PGlite all already have.
 *
 * No driver is bundled: the dependency belongs to the application, which knows
 * whether it is deploying to a Node server with a pool, a serverless function
 * with an HTTP driver, or a test with Postgres compiled to WebAssembly.
 */
export interface PostgresClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  /** Pools expose this; a single connection does not. */
  connect?(): Promise<PostgresConnection>;
  end?(): Promise<void>;
}

export interface PostgresConnection extends PostgresClient {
  release?(): void;
}

export interface PostgresOptions {
  /** Overrides the adapter id reported by `cms.inspect()`. */
  id?: string;
}

class PostgresDriver implements SqlDriver {
  readonly id: string;

  constructor(
    private readonly client: PostgresClient,
    id = "postgres",
  ) {
    this.id = id;
  }

  async all(
    sql: string,
    values: unknown[],
  ): Promise<Record<string, unknown>[]> {
    const result = await this.client.query(sql, values);
    return result.rows;
  }

  async run(sql: string, values: unknown[]): Promise<{ rowsAffected: number }> {
    const result = await this.client.query(sql, values);
    return { rowsAffected: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  /**
   * Pins the transaction to one connection.
   *
   * A pool hands out a different connection per query, so `BEGIN` and the
   * write that follows it could land on different sessions — the transaction
   * would appear to work and commit nothing. When the client cannot check out
   * a connection it is a single session already, and the generic path in the
   * adapter is correct.
   */
  transaction?<T>(run: (driver: SqlDriver) => Promise<T>): Promise<T>;

  async close(): Promise<void> {
    await this.client.end?.();
  }
}

/**
 * Creates the Postgres adapter.
 *
 * A connection string is accepted as well as a client, because
 * `postgres(env.DATABASE_URL)` is what a developer wants to write. It returns
 * a factory in that case: the pool is built on first use, so a module that is
 * merely imported — by the CLI, by a page that never queries — does not open
 * a connection, and a missing secret surfaces as a request error rather than
 * an unhandled module error.
 */
export function postgres(url: string, options?: PostgresOptions): DatabaseAdapterFactory; // prettier-ignore
export function postgres(client: PostgresClient, options?: PostgresOptions): DatabaseAdapter; // prettier-ignore
export function postgres(
  source: string | PostgresClient,
  options: PostgresOptions = {},
): DatabaseAdapter | DatabaseAdapterFactory {
  if (typeof source === "string") {
    return async () => postgres(await connectWithPg(source), options);
  }
  const client = source;
  const driver = new PostgresDriver(client, options.id ?? "postgres");

  if (client.connect) {
    const checkout = client.connect.bind(client);
    driver.transaction = async <T>(
      run: (scoped: SqlDriver) => Promise<T>,
    ): Promise<T> => {
      const connection = await checkout();
      const scoped = new PostgresDriver(connection, driver.id);
      try {
        await scoped.exec("BEGIN");
        const result = await run(scoped);
        await scoped.exec("COMMIT");
        return result;
      } catch (error) {
        await scoped.exec("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        connection.release?.();
      }
    };
  }

  return new SqlDatabaseAdapter(driver, postgresDialect);
}

/**
 * Loads `pg` on demand.
 *
 * The driver is a peer dependency, not a bundled one: a Cloudflare deployment
 * uses D1 and must not ship a Node Postgres client it never calls.
 */
async function connectWithPg(url: string): Promise<PostgresClient> {
  const moduleName = "pg";
  let pg: { Pool: new (config: { connectionString: string }) => unknown };
  try {
    pg = (await import(moduleName)) as never;
  } catch {
    throw new CmsConfigError(
      "database",
      'postgres(url) needs the "pg" package; install it, or pass a client you built yourself',
    );
  }
  const pool = new pg.Pool({ connectionString: url });
  return pool as PostgresClient;
}
