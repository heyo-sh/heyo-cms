import type { Mutation, MutationResult, Query, Row, Tx } from "./query";
import type {
  MigrationArtifact,
  MigrationStep,
  SchemaSnapshot,
} from "./schema";

/**
 * What an engine can and cannot do, stated rather than hidden.
 *
 * The engine reads these flags instead of assuming Postgres. A `false` here
 * must have a designed answer in the engine (compensating writes, no SQL
 * artefacts), not a runtime surprise.
 */
export interface DatabaseCapabilities {
  /** MongoDB only has transactions on a replica set. */
  transactions: boolean;
  /** MongoDB has no DDL: its migrations are indexes and backfills. */
  sqlMigrations: boolean;
  /** Filtering and sorting on paths inside the document body. */
  jsonQuery: boolean;
}

/** A migration that has been applied, as recorded in the journal table. */
export interface AppliedMigration {
  id: string;
  appliedAt: Date;
  /** Hash of the artifact, so an edited migration is detected, not replayed. */
  checksum: string;
}

export interface DatabaseAdapter {
  /** `postgres`, `sqlite`, `d1`, `mongodb`. Printed by `cms.inspect()`. */
  readonly id: string;
  readonly capabilities: DatabaseCapabilities;

  /**
   * Tells the adapter what the rows look like.
   *
   * Encoding is engine-specific — a timestamp is `timestamptz` on Postgres,
   * epoch milliseconds on SQLite and a native `Date` on MongoDB — so the
   * adapter needs the schema to translate values in both directions. The
   * engine hands it over once, right after building the adapter.
   */
  useSchema(schema: SchemaSnapshot): void;

  /**
   * Reads the live schema.
   *
   * Used to detect drift, not to diff: `generate` compares the configuration
   * against the snapshot committed next to the migrations, so it works
   * offline and can never propose dropping a table it does not own.
   */
  introspect(): Promise<SchemaSnapshot>;

  /**
   * Deterministic diff. Called with two snapshots and nothing else: the same
   * pair must always produce the same steps in the same order, or `generate`
   * would write a migration for a schema that did not change.
   */
  plan(from: SchemaSnapshot, to: SchemaSnapshot): MigrationStep[];

  /** Serialises steps into the file that lands in the repository. */
  render(steps: MigrationStep[], id: string): MigrationArtifact;

  /** Applies a rendered migration. The CLI never constructs SQL itself. */
  applyMigration(artifact: MigrationArtifact): Promise<void>;

  /** Journal access, so `migrate` and `status` share one source of truth. */
  listAppliedMigrations(): Promise<AppliedMigration[]>;
  recordMigration(id: string, checksum: string): Promise<void>;

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  query(tx: Tx, query: Query): Promise<Row[]>;
  mutate(tx: Tx, mutation: Mutation): Promise<MutationResult>;

  /** Releases pooled connections. Long-running servers never call it. */
  close?(): Promise<void>;
}

/**
 * How a database is configured in `heyoCms({ database })`.
 *
 * Adapters are built lazily: a Cloudflare D1 binding only exists inside a
 * request, and a `DATABASE_URL` only exists in a deployment, so constructing
 * the adapter while the config module is being imported would turn a missing
 * secret into an unhandled module error.
 */
export type DatabaseAdapterFactory = () =>
  DatabaseAdapter | Promise<DatabaseAdapter>;

export type DatabaseConfig = DatabaseAdapter | DatabaseAdapterFactory;
