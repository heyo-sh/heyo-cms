import type { ColumnValue } from "../../types/query";
import type { ColumnSnapshot, ColumnType } from "../../types/schema";

/**
 * Everything two SQL engines disagree about.
 *
 * The compiler and the DDL renderer are shared; only this table differs. A
 * third SQL engine is a new object here, not a new adapter.
 */
export interface SqlDialect {
  readonly id: "postgres" | "sqlite";
  /** `$1` on Postgres, `?` on SQLite. */
  placeholder(index: number): string;
  quote(identifier: string): string;
  columnType(column: Pick<ColumnSnapshot, "type" | "array">): string;
  /** Extracts a JSON path as a comparable value. */
  jsonExtract(column: string, path: string[], type: ColumnType): string;
  /** Extracts a JSON path as JSON, for array membership tests. */
  jsonArrayMembership(
    column: string,
    path: string[],
    placeholder: string,
  ): string;
  /** Case-insensitive LIKE, when the engine distinguishes the two. */
  likeOperator(caseInsensitive: boolean): string;
  encode(value: ColumnValue | undefined, type: ColumnType): unknown;
  decode(value: unknown, type: ColumnType): ColumnValue;
  /** True when `ALTER TABLE ... ALTER COLUMN` exists. */
  readonly supportsAlterColumn: boolean;
  /** The statement that opens a transaction; `BEGIN` when absent. */
  readonly beginTransaction?: string;
}

const identifier = (value: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    // Identifiers come from the configuration, which is code the developer
    // wrote — but a generated index name that slipped a quote into DDL would
    // be an injection with a very long fuse.
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value}"`;
};

function jsonLiteralPath(path: string[]): string {
  // `$."a"."b"` keeps keys with dots or spaces addressable, and is accepted by
  // SQLite's json_extract as well as Postgres' jsonpath.
  return `$${path.map((segment) => `."${segment.replaceAll('"', '\\"')}"`).join("")}`;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

const postgresTypes: Record<ColumnType, string> = {
  text: "text",
  integer: "integer",
  bigint: "bigint",
  real: "double precision",
  boolean: "boolean",
  timestamp: "timestamptz",
  json: "jsonb",
  blob: "bytea",
};

export const postgresDialect: SqlDialect = {
  id: "postgres",
  placeholder: (index) => `$${index}`,
  quote: identifier,
  columnType: (column) =>
    column.array === true ? "jsonb" : postgresTypes[column.type],
  jsonExtract(column, path, type) {
    const extracted = `${identifier(column)} #>> '{${path.map(escapeBracePath).join(",")}}'`;
    switch (type) {
      case "integer":
      case "bigint":
        return `(${extracted})::bigint`;
      case "real":
        return `(${extracted})::double precision`;
      case "boolean":
        return `(${extracted})::boolean`;
      case "timestamp":
        return `(${extracted})::timestamptz`;
      default:
        return `(${extracted})`;
    }
  },
  jsonArrayMembership(column, path, placeholder) {
    const container =
      path.length === 0
        ? identifier(column)
        : `${identifier(column)} #> '{${path.map(escapeBracePath).join(",")}}'`;
    // `jsonb_array_elements_text` refuses anything that is not an array, and
    // one document whose value is a JSON null or a lone string would fail the
    // whole query. A lone value is a list of one, as SQLite and MongoDB read
    // it; null, an object or no value at all are an empty list.
    const elements = `CASE WHEN jsonb_typeof(${container}) = 'array' THEN ${container} WHEN jsonb_typeof(${container}) IN ('string', 'number', 'boolean') THEN jsonb_build_array(${container}) ELSE '[]'::jsonb END`;
    return `EXISTS (SELECT 1 FROM jsonb_array_elements_text(${elements}) AS membership(value) WHERE membership.value = ${placeholder})`;
  },
  likeOperator: (caseInsensitive) => (caseInsensitive ? "ILIKE" : "LIKE"),
  encode(value, type) {
    if (value === undefined || value === null) return null;
    if (type === "json") return JSON.stringify(value);
    if (type === "timestamp") return toDate(value);
    return value;
  },
  decode(value, type) {
    if (value === null || value === undefined) return null;
    if (type === "timestamp") {
      return value instanceof Date ? value : new Date(String(value));
    }
    if (type === "json" && typeof value === "string") {
      return JSON.parse(value) as ColumnValue;
    }
    if (type === "bigint" && typeof value === "string") return Number(value);
    return value as ColumnValue;
  },
  supportsAlterColumn: true,
};

function escapeBracePath(segment: string): string {
  // Postgres path arrays are `{a,b}`; a key containing a comma or a brace has
  // to be quoted inside that literal.
  return /[,{}"\s]/.test(segment)
    ? `"${segment.replaceAll('"', '\\"')}"`
    : segment;
}

// ---------------------------------------------------------------------------
// SQLite / D1
// ---------------------------------------------------------------------------

const sqliteTypes: Record<ColumnType, string> = {
  text: "TEXT",
  integer: "INTEGER",
  bigint: "INTEGER",
  real: "REAL",
  boolean: "INTEGER",
  timestamp: "INTEGER",
  json: "TEXT",
  blob: "BLOB",
};

/**
 * SQLite stores timestamps as epoch milliseconds and JSON as text.
 *
 * Milliseconds rather than ISO strings: comparisons and ordering are then
 * plain integer work, and no row can carry a different time zone from its
 * neighbour.
 */
export const sqliteDialect: SqlDialect = {
  id: "sqlite",
  /**
   * The write lock is taken when the transaction opens, while the busy
   * timeout can still wait for it. A plain `BEGIN` reads first and asks for
   * the lock at its first write; if another process wrote in between, SQLite
   * answers "database is locked" at once, without waiting, because the reads
   * already made would be stale.
   */
  beginTransaction: "BEGIN IMMEDIATE",
  placeholder: () => "?",
  quote: identifier,
  columnType: (column) =>
    column.array === true ? "TEXT" : sqliteTypes[column.type],
  jsonExtract(column, path, type) {
    const extracted = `json_extract(${identifier(column)}, '${jsonLiteralPath(path)}')`;
    // Collection date fields are ISO strings inside the document JSON, while
    // a real SQLite timestamp is epoch milliseconds. A direct TEXT > INTEGER
    // comparison follows SQLite's storage-class ordering (and says every
    // string is greater), so date filters on a JSON field must normalise the
    // extracted ISO value at the comparison boundary.
    return type === "timestamp"
      ? `CAST(ROUND((julianday(${extracted}) - 2440587.5) * 86400000) AS INTEGER)`
      : extracted;
  },
  jsonArrayMembership(column, path, placeholder) {
    // `json_each(X, P)` walks the element at P inside the document. Walking
    // `json_extract(X, P)` instead would hand a lone string over unquoted —
    // which is not JSON, and fails the whole query — while the two-argument
    // form treats it as a list of one, and a null or a missing value as none.
    const target =
      path.length === 0
        ? identifier(column)
        : `${identifier(column)}, '${jsonLiteralPath(path)}'`;
    return `EXISTS (SELECT 1 FROM json_each(${target}) WHERE json_each.value = ${placeholder})`;
  },
  // SQLite's LIKE is already case-insensitive for ASCII, and making it
  // case-sensitive is a connection-wide pragma. Both operators map to the
  // same keyword rather than changing behaviour behind the caller's back.
  likeOperator: () => "LIKE",
  encode(value, type) {
    if (value === undefined || value === null) return null;
    if (type === "json") return JSON.stringify(value);
    if (type === "timestamp") return toDate(value).getTime();
    if (type === "boolean") return value === true ? 1 : 0;
    return value;
  },
  decode(value, type) {
    if (value === null || value === undefined) return null;
    if (type === "timestamp") {
      return new Date(typeof value === "number" ? value : Number(value));
    }
    if (type === "boolean") return value === 1 || value === true;
    if (type === "json") {
      if (typeof value !== "string") return value as ColumnValue;
      return JSON.parse(value) as ColumnValue;
    }
    return value as ColumnValue;
  },
  supportsAlterColumn: false,
};

function toDate(value: ColumnValue): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  return new Date(String(value));
}
