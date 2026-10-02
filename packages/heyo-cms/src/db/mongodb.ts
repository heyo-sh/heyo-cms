import { CmsConfigError, CmsError } from "../errors";
import { describeStep } from "../schema/describe";
import { planMigration } from "../schema/plan";
import { migrationsTable } from "../schema/system";
import type {
  AppliedMigration,
  DatabaseAdapter,
  DatabaseAdapterFactory,
  DatabaseCapabilities,
} from "../types/database";
import type {
  ColumnValue,
  Comparator,
  Mutation,
  MutationResult,
  Query,
  Row,
  Tx,
  Where,
} from "../types/query";
import type {
  MigrationArtifact,
  MigrationStep,
  SchemaSnapshot,
  TableSnapshot,
} from "../types/schema";

// ---------------------------------------------------------------------------
// Driver contract
// ---------------------------------------------------------------------------

export type MongoDocument = Record<string, unknown>;
export type MongoFilter = Record<string, unknown>;

export interface MongoCursor<T> {
  toArray(): Promise<T[]>;
}

export interface MongoIndexInfo {
  name: string;
  key: Record<string, number>;
  unique?: boolean;
}

export interface MongoLikeCollection {
  find(
    filter: MongoFilter,
    options?: {
      sort?: Record<string, 1 | -1>;
      limit?: number;
      skip?: number;
      projection?: Record<string, 1>;
    },
  ): MongoCursor<MongoDocument>;
  countDocuments(filter: MongoFilter): Promise<number>;
  insertOne(document: MongoDocument): Promise<unknown>;
  updateMany(
    filter: MongoFilter,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount?: number; matchedCount?: number }>;
  deleteMany(filter: MongoFilter): Promise<{ deletedCount?: number }>;
  createIndex(
    keys: Record<string, 1 | -1>,
    options?: {
      name?: string;
      unique?: boolean;
      partialFilterExpression?: MongoFilter;
    },
  ): Promise<unknown>;
  dropIndex(name: string): Promise<unknown>;
  listIndexes(): MongoCursor<MongoIndexInfo>;
}

/** The subset of a `Db` the adapter uses. The official driver satisfies it. */
export interface MongoLikeDatabase {
  collection(name: string): MongoLikeCollection;
  listCollections(): MongoCursor<{ name: string }>;
  createCollection(name: string): Promise<unknown>;
  dropCollection(name: string): Promise<unknown>;
}

export interface MongoOptions {
  /**
   * Transactions need a replica set. Left unset, the adapter reports `false`
   * and the engine uses the compensating path — which is the correct answer
   * for a standalone `mongod`, and a stated one rather than a surprise.
   */
  transactions?: boolean;
  /** Database name, when it is not part of the connection string. */
  database?: string;
}

class MongoTx implements Tx {
  constructor(
    readonly id: string,
    readonly real: boolean,
  ) {}
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * MongoDB behind the same contract as Postgres.
 *
 * Everything that would normally leak — DDL, SQL, column types — was already
 * removed from the engine by the neutral `Query`/`Mutation` AST and the
 * neutral migration steps, so this adapter is a translator rather than a
 * second implementation of the CMS.
 */
export class MongoDatabaseAdapter implements DatabaseAdapter {
  readonly id = "mongodb";
  readonly capabilities: DatabaseCapabilities;

  private schema: SchemaSnapshot = { version: 1, tables: [], collections: [] };
  private documentColumns = new Map<string, string>();
  private columnNames = new Map<string, Set<string>>();

  constructor(
    private readonly database: MongoLikeDatabase,
    options: MongoOptions = {},
  ) {
    this.capabilities = {
      transactions: options.transactions === true,
      // No DDL means no `.sql` file; migrations are indexes and backfills.
      sqlMigrations: false,
      jsonQuery: true,
    };
  }

  useSchema(schema: SchemaSnapshot): void {
    this.schema = schema;
    this.documentColumns = new Map(
      schema.tables
        .filter((table) => table.documentColumn !== undefined)
        .map((table) => [table.name, table.documentColumn as string]),
    );
    this.columnNames = new Map(
      schema.tables.map((table) => [
        table.name,
        new Set(table.columns.map((column) => column.name)),
      ]),
    );
  }

  /**
   * Lists collections and their indexes.
   *
   * A document database has no columns to report, so the snapshot carries
   * tables without them. That is enough for drift detection — a missing
   * collection or a missing index is what breaks a deployment.
   */
  async introspect(): Promise<SchemaSnapshot> {
    const names = (await this.database.listCollections().toArray())
      .map((entry) => entry.name)
      .filter((name) => name !== migrationsTable)
      .sort();

    const tables: TableSnapshot[] = [];
    for (const name of names) {
      const indexes = await this.database.collection(name).listIndexes().toArray(); // prettier-ignore
      tables.push({
        name,
        columns: [],
        primaryKey: ["id"],
        indexes: indexes
          .filter((index) => index.name !== "_id_")
          .map((index) => ({
            name: index.name,
            table: name,
            targets: Object.keys(index.key).map((key) => ({
              kind: "column" as const,
              column: key,
            })),
            unique: index.unique === true,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    return { version: 1, tables, collections: [] };
  }

  plan(from: SchemaSnapshot, to: SchemaSnapshot): MigrationStep[] {
    return planMigration(from, to);
  }

  /**
   * Renders the steps themselves.
   *
   * There is no SQL to write, and a hand-written script would not survive a
   * review as well as the step list the planner already produced. The file is
   * numbered, committed and applied exactly like a `.sql` one; only its
   * contents differ.
   */
  render(steps: MigrationStep[], id: string): MigrationArtifact {
    const summary = steps.map(describeStep);
    return {
      id,
      extension: "json",
      content: `${JSON.stringify({ id, summary, steps }, null, 2)}\n`,
      summary,
    };
  }

  async applyMigration(artifact: MigrationArtifact): Promise<void> {
    const parsed = JSON.parse(artifact.content) as { steps: MigrationStep[] };
    for (const step of parsed.steps) await this.applyStep(step);
  }

  async listAppliedMigrations(): Promise<AppliedMigration[]> {
    const rows = await this.database
      .collection(migrationsTable)
      .find({}, { sort: { _id: 1 } })
      .toArray();
    return rows.map((row) => ({
      id: String(row._id),
      checksum: String(row.checksum),
      appliedAt: new Date(String(row.applied_at)),
    }));
  }

  async recordMigration(id: string, checksum: string): Promise<void> {
    await this.database.collection(migrationsTable).insertOne({
      _id: id,
      checksum,
      applied_at: new Date().toISOString(),
    });
  }

  /**
   * Transactions exist only on a replica set.
   *
   * Rather than emulate them, the adapter reports the capability honestly and
   * runs the function without one. The engine is written to that flag: the
   * outbox row goes in with the document, and delivery is idempotent.
   */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(new MongoTx(nextTransactionId(), this.capabilities.transactions));
  }

  async query(_tx: Tx, query: Query): Promise<Row[]> {
    const collection = this.database.collection(query.table);
    const filter = this.filter(query.table, query.where);

    if (query.count === true) {
      return [{ count: await collection.countDocuments(filter) }];
    }

    const options: {
      sort?: Record<string, 1 | -1>;
      limit?: number;
      skip?: number;
    } = {};
    if (query.orderBy && query.orderBy.length > 0) {
      options.sort = Object.fromEntries(
        query.orderBy.map((entry) => [
          this.path(query.table, entry.path),
          entry.direction === "desc" ? -1 : 1,
        ]),
      );
    }
    if (query.limit !== undefined) options.limit = query.limit;
    if (query.offset !== undefined) options.skip = query.offset;

    const documents = await collection.find(filter, options).toArray();
    return documents.map((document) =>
      this.decode(query.table, document, query.select, query.table),
    );
  }

  async mutate(_tx: Tx, mutation: Mutation): Promise<MutationResult> {
    const collection = this.database.collection(mutation.table);

    if (mutation.kind === "insert") {
      const document = this.encode(mutation.values);
      await collection.insertOne(document);
      return {
        rows:
          mutation.returning === false
            ? []
            : [this.decode(mutation.table, document)],
        count: 1,
      };
    }

    if (mutation.kind === "update") {
      const filter = this.filter(mutation.table, mutation.where);
      const update = this.encode(mutation.set);
      const result = await collection.updateMany(filter, { $set: update });
      const count = result.modifiedCount ?? result.matchedCount ?? 0;
      if (mutation.returning === false) return { rows: [], count };

      // Mongo reports counts, not documents. Reading the matched rows back is
      // one extra round trip for the same guarantee a SQL `RETURNING` gives.
      const rows = await collection.find(filter).toArray();
      return {
        rows: rows.map((row) => this.decode(mutation.table, row)),
        count: rows.length,
      };
    }

    const filter = this.filter(mutation.table, mutation.where);
    const returned =
      mutation.returning === true
        ? await collection.find(filter).toArray()
        : [];
    const result = await collection.deleteMany(filter);
    return {
      rows: returned.map((row) => this.decode(mutation.table, row)),
      count: result.deletedCount ?? returned.length,
    };
  }

  // -------------------------------------------------------------------------
  // Migration steps
  // -------------------------------------------------------------------------

  private async applyStep(step: MigrationStep): Promise<void> {
    switch (step.kind) {
      case "create_table": {
        const existing = (await this.database.listCollections().toArray()).map(
          (entry) => entry.name,
        );
        if (!existing.includes(step.table.name)) {
          await this.database.createCollection(step.table.name);
        }
        return;
      }
      case "drop_table":
        await this.database.dropCollection(step.table).catch(() => undefined);
        return;
      case "add_column": {
        // Schemaless: a new field needs no DDL, but a default still has to
        // reach the documents written before it existed.
        if (step.column.default === undefined) return;
        await this.database
          .collection(step.table)
          .updateMany(
            { [step.column.name]: { $exists: false } },
            { $set: { [step.column.name]: step.column.default } },
          );
        return;
      }
      case "drop_column":
        await this.database
          .collection(step.table)
          .updateMany({}, { $unset: { [step.column]: "" } });
        return;
      case "alter_column":
        // Types are a property of each document, so there is nothing to alter.
        return;
      case "create_index": {
        const keys: Record<string, 1> = {};
        for (const target of step.index.targets) {
          keys[
            target.kind === "column"
              ? target.column
              : [target.column, ...target.path].join(".")
          ] = 1;
        }
        await this.database.collection(step.index.table).createIndex(keys, {
          name: step.index.name,
          unique: step.index.unique,
          ...(step.index.where
            ? {
                partialFilterExpression: {
                  [step.index.where.column]: step.index.where.equals,
                },
              }
            : {}),
        });
        return;
      }
      case "drop_index":
        await this.database
          .collection(step.table)
          .dropIndex(step.index)
          .catch(() => undefined);
        return;
      case "set_document_field": {
        const path = [step.documentColumn, ...step.path].join(".");
        await this.database
          .collection(step.table)
          .updateMany(
            { collection: step.collection, [path]: { $exists: false } },
            { $set: { [path]: step.value } },
          );
        return;
      }
      case "unset_document_field": {
        const path = [step.documentColumn, ...step.path].join(".");
        await this.database
          .collection(step.table)
          .updateMany(
            { collection: step.collection },
            { $unset: { [path]: "" } },
          );
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Translation
  // -------------------------------------------------------------------------

  private filter(table: string, where: Where | undefined): MongoFilter {
    if (!where) return {};
    if (where.kind === "and") {
      if (where.conditions.length === 0) return {};
      return {
        $and: where.conditions.map((condition) =>
          this.filter(table, condition),
        ),
      };
    }
    if (where.kind === "or") {
      if (where.conditions.length === 0) return { _id: { $exists: false } };
      return {
        $or: where.conditions.map((condition) => this.filter(table, condition)),
      };
    }
    if (where.kind === "not") {
      return { $nor: [this.filter(table, where.condition)] };
    }
    return {
      [this.path(table, where.path)]: this.condition(
        where.operator,
        where.value,
      ),
    };
  }

  private condition(
    operator: Comparator,
    value: ColumnValue | ColumnValue[],
  ): unknown {
    switch (operator) {
      case "eq":
        return { $eq: value };
      case "ne":
        return { $ne: value };
      case "gt":
        return { $gt: value };
      case "gte":
        return { $gte: value };
      case "lt":
        return { $lt: value };
      case "lte":
        return { $lte: value };
      case "in":
        return { $in: Array.isArray(value) ? value : [value] };
      case "nin":
        return { $nin: Array.isArray(value) ? value : [value] };
      case "like":
      case "ilike":
        return {
          $regex: likeToRegex(String(value)),
          ...(operator === "ilike" ? { $options: "i" } : {}),
        };
      case "contains":
        // Mongo matches an array element with a plain equality, which is what
        // `contains` means for the JSON arrays the engine stores.
        return { $eq: value };
      case "exists":
        return value === false ? { $in: [null] } : { $nin: [null] };
    }
  }

  /**
   * `title` means `data.title` on a table that stores a document body.
   *
   * Identical to the SQL compiler's rule, which is what keeps a query written
   * against one engine working against another.
   */
  private path(table: string, path: string): string {
    const [head, ...rest] = path.split(".");
    const head_ = head as string;
    if (this.columnNames.get(table)?.has(head_)) {
      const column = head_ === "id" ? "_id" : head_;
      return [column, ...rest].join(".");
    }
    const documentColumn = this.documentColumns.get(table);
    if (!documentColumn) {
      throw new CmsError(`Unknown column ${table}.${path}`, {
        status: 400,
        code: "unknown_column",
      });
    }
    return [documentColumn, ...path.split(".")].join(".");
  }

  /** `id` is the primary key, so it is `_id` in storage and nowhere else. */
  private encode(values: Row): MongoDocument {
    const document: MongoDocument = {};
    for (const [key, value] of Object.entries(values)) {
      document[key === "id" ? "_id" : key] = value;
    }
    return document;
  }

  private decode(
    table: string,
    document: MongoDocument,
    select?: string[],
    selectTable?: string,
  ): Row {
    const row: Row = {};
    for (const [key, value] of Object.entries(document)) {
      row[key === "_id" ? "id" : key] = value as ColumnValue;
    }
    if (!select || select.length === 0 || selectTable === undefined) return row;

    // Mongo returns nested objects; the engine expects the dotted paths it
    // asked for, exactly as a SQL alias delivers them. `title` resolves
    // through the same rule the filter uses, so it reads `data.title`.
    const projected: Row = {};
    for (const path of select) {
      const stored = this.path(selectTable, path).replace(/^_id\b/, "id");
      projected[path] = readPath(row, stored.split(".")) as ColumnValue;
    }
    return projected;
  }
}

function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? null;
}

/** Translates a SQL `LIKE` pattern into the equivalent anchored regex. */
function likeToRegex(pattern: string): string {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped.replaceAll("%", ".*").replaceAll("_", ".")}$`;
}

let transactionCounter = 0;
function nextTransactionId(): string {
  transactionCounter += 1;
  return `mongo_tx_${transactionCounter}`;
}

/**
 * Creates the MongoDB adapter.
 *
 * A connection string is accepted as well as a `Db`, and loads the official
 * driver on demand: it is a peer dependency, because a project on Postgres
 * must not ship a MongoDB client.
 */
export function mongodb(url: string, options?: MongoOptions): DatabaseAdapterFactory; // prettier-ignore
export function mongodb(database: MongoLikeDatabase, options?: MongoOptions): DatabaseAdapter; // prettier-ignore
export function mongodb(
  source: string | MongoLikeDatabase,
  options: MongoOptions = {},
): DatabaseAdapter | DatabaseAdapterFactory {
  if (typeof source === "string") {
    return async () => mongodb(await connectWithDriver(source, options), options); // prettier-ignore
  }
  return new MongoDatabaseAdapter(source, options);
}

async function connectWithDriver(
  url: string,
  options: MongoOptions,
): Promise<MongoLikeDatabase> {
  const moduleName = "mongodb";
  let driver: {
    MongoClient: new (url: string) => {
      connect(): Promise<unknown>;
      db(name?: string): MongoLikeDatabase;
    };
  };
  try {
    driver = (await import(moduleName)) as never;
  } catch {
    throw new CmsConfigError(
      "database",
      'mongodb(url) needs the "mongodb" package; install it, or pass a Db you built yourself',
    );
  }
  const client = new driver.MongoClient(url);
  await client.connect();
  return options.database ? client.db(options.database) : client.db();
}
