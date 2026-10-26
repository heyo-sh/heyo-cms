import { planMigration } from "../../schema/plan";
import { describeStep } from "../../schema/describe";
import { migrationsTable } from "../../schema/system";
import type {
  AppliedMigration,
  DatabaseAdapter,
  DatabaseCapabilities,
} from "../../types/database";
import type {
  Mutation,
  MutationResult,
  Query,
  Row,
  Tx,
} from "../../types/query";
import type {
  MigrationArtifact,
  MigrationStep,
  SchemaSnapshot,
} from "../../types/schema";
import { uniqueConflict } from "../unique";
import { SchemaCatalog, SqlCompiler } from "./compile";
import { SqlDdlRenderer } from "./ddl";
import type { SqlDialect } from "./dialect";
import { splitStatements, type SqlDriver } from "./driver";
import { introspectPostgres, introspectSqlite } from "./introspect";

/** A transaction handle that also carries the connection it is pinned to. */
class SqlTx implements Tx {
  constructor(
    readonly id: string,
    readonly real: boolean,
    readonly driver: SqlDriver,
  ) {}
}

export interface SqlAdapterOptions {
  /** Overrides, for engines that are SQL but not fully featured (D1). */
  capabilities?: Partial<DatabaseCapabilities>;
  schema?: SchemaSnapshot;
}

/**
 * One adapter for every SQL engine.
 *
 * Postgres, SQLite and D1 differ in a dialect object and a driver, not in a
 * repository: a bug fixed for one is fixed for all three, and the contract
 * suite that proves it runs against each.
 */
export class SqlDatabaseAdapter implements DatabaseAdapter {
  readonly id: string;
  readonly capabilities: DatabaseCapabilities;

  private readonly catalog = new SchemaCatalog();
  private readonly compiler: SqlCompiler;
  private readonly renderer: SqlDdlRenderer;
  private schema: SchemaSnapshot = { version: 1, tables: [], collections: [] };
  private journalReady = false;
  private transactionDepth = 0;

  constructor(
    private readonly driver: SqlDriver,
    private readonly dialect: SqlDialect,
    options: SqlAdapterOptions = {},
  ) {
    this.id = driver.id;
    this.capabilities = {
      transactions: true,
      sqlMigrations: true,
      jsonQuery: true,
      ...options.capabilities,
    };
    this.compiler = new SqlCompiler(dialect, this.catalog);
    this.renderer = new SqlDdlRenderer(dialect, () => this.schema);
    if (options.schema) this.useSchema(options.schema);
  }

  useSchema(schema: SchemaSnapshot): void {
    this.schema = schema;
    this.catalog.use(schema);
  }

  introspect(): Promise<SchemaSnapshot> {
    return this.dialect.id === "postgres"
      ? introspectPostgres(this.driver)
      : introspectSqlite(this.driver);
  }

  plan(from: SchemaSnapshot, to: SchemaSnapshot): MigrationStep[] {
    return planMigration(from, to);
  }

  render(steps: MigrationStep[], id: string): MigrationArtifact {
    return {
      id,
      extension: "sql",
      content: `-- ${id}\n${this.renderer.render(steps)}`,
      summary: steps.map(describeStep),
    };
  }

  async applyMigration(artifact: MigrationArtifact): Promise<void> {
    await this.ensureJournal();
    for (const statement of splitStatements(artifact.content)) {
      await this.driver.exec(statement);
    }
  }

  async listAppliedMigrations(): Promise<AppliedMigration[]> {
    await this.ensureJournal();
    const rows = await this.driver.all(
      `SELECT id, checksum, applied_at FROM ${this.dialect.quote(migrationsTable)} ORDER BY id`,
      [],
    );
    return rows.map((row) => ({
      id: String(row.id),
      checksum: String(row.checksum),
      appliedAt: new Date(String(row.applied_at)),
    }));
  }

  async recordMigration(id: string, sum: string): Promise<void> {
    await this.ensureJournal();
    await this.driver.run(
      `INSERT INTO ${this.dialect.quote(migrationsTable)} (id, checksum, applied_at) VALUES (${this.dialect.placeholder(1)}, ${this.dialect.placeholder(2)}, ${this.dialect.placeholder(3)})`,
      [id, sum, new Date().toISOString()],
    );
  }

  /**
   * Runs a function inside a transaction, or inside nothing at all when the
   * engine has none.
   *
   * The nesting counter keeps a hook that calls back into the engine from
   * issuing a second `BEGIN`, which Postgres warns about and SQLite refuses.
   */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!this.capabilities.transactions) {
      return fn(new SqlTx(nextTransactionId(), false, this.driver));
    }
    if (this.transactionDepth > 0) {
      return fn(new SqlTx(nextTransactionId(), true, this.driver));
    }
    if (this.driver.transaction) {
      return this.driver.transaction((driver) =>
        fn(new SqlTx(nextTransactionId(), true, driver)),
      );
    }

    this.transactionDepth += 1;
    await this.driver.exec(this.dialect.beginTransaction ?? "BEGIN");
    try {
      const result = await fn(
        new SqlTx(nextTransactionId(), true, this.driver),
      );
      await this.driver.exec("COMMIT");
      return result;
    } catch (error) {
      await this.driver.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  async query(tx: Tx, query: Query): Promise<Row[]> {
    const statement = this.compiler.compileQuery(query);
    const rows = await driverOf(tx, this.driver).all(
      statement.text,
      statement.values,
    );
    if (query.count === true) {
      // Postgres returns `count(*)` as a bigint, which its driver hands over
      // as a string to avoid losing precision. The engine wants a number.
      return [{ count: Number(rows[0]?.count ?? 0) }];
    }
    return rows.map((row) => this.compiler.decodeRow(query.table, row));
  }

  async mutate(tx: Tx, mutation: Mutation): Promise<MutationResult> {
    const statement = this.compiler.compileMutation(mutation);
    const driver = driverOf(tx, this.driver);
    const returning = statement.text.includes(" RETURNING ");

    try {
      if (returning) {
        const rows = await driver.all(statement.text, statement.values);
        return {
          rows: rows.map((row) => this.compiler.decodeRow(mutation.table, row)), // prettier-ignore
          count: rows.length,
        };
      }

      const result = await driver.run(statement.text, statement.values);
      return { rows: [], count: result.rowsAffected };
    } catch (error) {
      // A duplicate is the caller's mistake, not the CMS's: the unique index
      // is the only check that cannot race, so its error is the answer.
      const violation = this.dialect.uniqueViolation(error);
      if (violation === null) throw error;
      throw uniqueConflict(
        this.schema,
        mutation.table,
        violation,
        mutation.kind === "insert" ? mutation.values : undefined,
        error,
      );
    }
  }

  async close(): Promise<void> {
    await this.driver.close?.();
  }

  /**
   * Creates the journal.
   *
   * It cannot be part of the generated schema: `migrate` has to know what has
   * already run before it runs anything, so the table that answers that
   * question must predate the first migration.
   */
  private async ensureJournal(): Promise<void> {
    if (this.journalReady) return;
    await this.driver.exec(
      `CREATE TABLE IF NOT EXISTS ${this.dialect.quote(migrationsTable)} (
  ${this.dialect.quote("id")} TEXT NOT NULL PRIMARY KEY,
  ${this.dialect.quote("checksum")} TEXT NOT NULL,
  ${this.dialect.quote("applied_at")} TEXT NOT NULL
)`,
    );
    this.journalReady = true;
  }
}

function driverOf(tx: Tx, fallback: SqlDriver): SqlDriver {
  return tx instanceof SqlTx ? tx.driver : fallback;
}

let transactionCounter = 0;
function nextTransactionId(): string {
  transactionCounter += 1;
  return `tx_${transactionCounter}`;
}
