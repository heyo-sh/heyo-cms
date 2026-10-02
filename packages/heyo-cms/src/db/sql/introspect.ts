import type {
  ColumnSnapshot,
  ColumnType,
  IndexSnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "../../types/schema";
import { migrationsTable } from "../../schema/system";
import type { SqlDriver } from "./driver";

/**
 * Reads the physical schema back out of a live database.
 *
 * Only tables and indexes: a database cannot tell which collection a document
 * belongs to any more than a filesystem can tell which project a file belongs
 * to. The logical layer lives in the committed snapshot, and `generate` diffs
 * against that. This is for drift detection — "the database is not what the
 * migrations say it should be" — which is a different question from "what
 * changed in the configuration".
 */
export async function introspectPostgres(
  driver: SqlDriver,
): Promise<SchemaSnapshot> {
  const columns = await driver.all(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema()
      ORDER BY table_name, column_name`,
    [],
  );
  const indexes = await driver.all(
    `SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
       FROM pg_indexes
      WHERE schemaname = current_schema()
      ORDER BY tablename, indexname`,
    [],
  );
  const primaryKeys = await driver.all(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = current_schema()
      ORDER BY tc.table_name, kcu.ordinal_position`,
    [],
  );

  const tables = new Map<string, TableSnapshot>();
  for (const row of columns) {
    const table = ensureTable(tables, String(row.table_name));
    table.columns.push({
      name: String(row.column_name),
      type: postgresColumnType(String(row.data_type)),
      nullable: row.is_nullable === "YES",
      storage: "column",
    });
  }
  for (const row of primaryKeys) {
    const table = tables.get(String(row.table_name));
    if (table) table.primaryKey.push(String(row.column_name));
  }
  for (const row of indexes) {
    const table = tables.get(String(row.table_name));
    if (!table) continue;
    const definition = String(row.definition);
    table.indexes.push({
      name: String(row.index_name),
      table: table.name,
      targets: [],
      unique: definition.startsWith("CREATE UNIQUE"),
    });
  }

  return finish(tables);
}

export async function introspectSqlite(
  driver: SqlDriver,
): Promise<SchemaSnapshot> {
  const tableRows = await driver.all(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    [],
  );

  const tables = new Map<string, TableSnapshot>();
  for (const row of tableRows) {
    const name = String(row.name);
    const table = ensureTable(tables, name);
    const columns = await driver.all(`PRAGMA table_info(${quote(name)})`, []);
    for (const column of columns) {
      table.columns.push({
        name: String(column.name),
        type: sqliteColumnType(String(column.type)),
        nullable: Number(column.notnull) === 0,
        storage: "column",
      });
      if (Number(column.pk) > 0) table.primaryKey.push(String(column.name));
    }
    const indexes = await driver.all(`PRAGMA index_list(${quote(name)})`, []);
    for (const index of indexes) {
      const indexName = String(index.name);
      if (indexName.startsWith("sqlite_autoindex")) continue;
      table.indexes.push({
        name: indexName,
        table: name,
        targets: [],
        unique: Number(index.unique) === 1,
      });
    }
  }

  return finish(tables);
}

function ensureTable(
  tables: Map<string, TableSnapshot>,
  name: string,
): TableSnapshot {
  const existing = tables.get(name);
  if (existing) return existing;
  const created: TableSnapshot = {
    name,
    columns: [],
    primaryKey: [],
    indexes: [],
  };
  tables.set(name, created);
  return created;
}

function finish(tables: Map<string, TableSnapshot>): SchemaSnapshot {
  const sorted = [...tables.values()]
    // The journal is the adapter's own bookkeeping and predates every
    // migration, so a diff must never see it.
    .filter((table) => table.name !== migrationsTable)
    .map((table) => ({
      ...table,
      columns: sortByName(table.columns),
      indexes: sortByName(table.indexes),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { version: 1, tables: sorted, collections: [] };
}

function sortByName<T extends ColumnSnapshot | IndexSnapshot>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function postgresColumnType(dataType: string): ColumnType {
  switch (dataType) {
    case "integer":
      return "integer";
    case "bigint":
      return "bigint";
    case "double precision":
    case "numeric":
    case "real":
      return "real";
    case "boolean":
      return "boolean";
    case "timestamp with time zone":
    case "timestamp without time zone":
      return "timestamp";
    case "jsonb":
    case "json":
      return "json";
    case "bytea":
      return "blob";
    default:
      return "text";
  }
}

/**
 * SQLite keeps storage classes, not declared types.
 *
 * A `timestamp` and a `boolean` are both INTEGER once stored, so the mapping
 * back is lossy. That is acceptable for drift detection — a missing table or
 * column is what matters — and is the reason this result is never used as the
 * `from` side of a migration diff.
 */
function sqliteColumnType(declared: string): ColumnType {
  const normalised = declared.toUpperCase();
  if (normalised.includes("INT")) return "integer";
  if (normalised.includes("REAL") || normalised.includes("DOUB")) return "real";
  if (normalised.includes("BLOB")) return "blob";
  return "text";
}

function quote(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
