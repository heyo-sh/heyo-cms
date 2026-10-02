import { CmsError } from "../../errors";
import type {
  ColumnValue,
  Comparator,
  Mutation,
  Query,
  Row,
  Where,
} from "../../types/query";
import type { ColumnType, SchemaSnapshot } from "../../types/schema";
import type { SqlDialect } from "./dialect";

export interface CompiledStatement {
  text: string;
  values: unknown[];
}

/**
 * Knows what every column holds.
 *
 * Built from the snapshot the engine hands the adapter. Without it a row
 * would come back with a JSON string where the caller expects an object, and
 * a timestamp as whatever the driver felt like returning.
 */
export class SchemaCatalog {
  private readonly columns = new Map<string, Map<string, ColumnType>>();
  private readonly documentColumns = new Map<string, string>();

  constructor(schema?: SchemaSnapshot) {
    if (schema) this.use(schema);
  }

  use(schema: SchemaSnapshot): void {
    this.columns.clear();
    this.documentColumns.clear();
    for (const table of schema.tables) {
      this.columns.set(
        table.name,
        new Map(table.columns.map((column) => [column.name, column.type])),
      );
      if (table.documentColumn) {
        this.documentColumns.set(table.name, table.documentColumn);
      }
    }
  }

  columnType(table: string, column: string): ColumnType | undefined {
    return this.columns.get(table)?.get(column);
  }

  /** The JSON column a table stores its document body in, if it has one. */
  documentColumn(table: string): string | undefined {
    return this.documentColumns.get(table);
  }

  tableColumns(table: string): string[] {
    return [...(this.columns.get(table)?.keys() ?? [])];
  }

  knows(table: string): boolean {
    return this.columns.has(table);
  }
}

/**
 * A resolved path: which column, which JSON path inside it.
 *
 * `title` on a table that has a document column means `data.title`, which is
 * what lets callers write a field name and never think about where content
 * physically lives.
 */
interface ResolvedPath {
  column: string;
  path: string[];
  type: ColumnType;
}

export class SqlCompiler {
  constructor(
    private readonly dialect: SqlDialect,
    private readonly catalog: SchemaCatalog,
  ) {}

  compileQuery(query: Query): CompiledStatement {
    const values: unknown[] = [];
    const table = this.dialect.quote(query.table);

    const projection = query.count
      ? "COUNT(*) AS count"
      : this.compileSelect(query);

    let text = `SELECT ${projection} FROM ${table}`;

    if (query.where) {
      text += ` WHERE ${this.compileWhere(query.table, query.where, values)}`;
    }
    if (!query.count && query.orderBy && query.orderBy.length > 0) {
      const order = query.orderBy
        .map((entry) => {
          const resolved = this.resolve(query.table, entry.path);
          const direction = entry.direction === "desc" ? "DESC" : "ASC";
          return `${this.expression(resolved)} ${direction}`;
        })
        .join(", ");
      text += ` ORDER BY ${order}`;
    }
    if (!query.count && query.limit !== undefined) {
      text += ` LIMIT ${integer(query.limit)}`;
    }
    if (!query.count && query.offset !== undefined) {
      text += ` OFFSET ${integer(query.offset)}`;
    }

    return { text, values };
  }

  compileMutation(mutation: Mutation): CompiledStatement {
    const values: unknown[] = [];
    const table = this.dialect.quote(mutation.table);

    if (mutation.kind === "insert") {
      const entries = Object.entries(mutation.values);
      if (entries.length === 0) {
        throw new CmsError("An insert needs at least one column.", {
          code: "empty_insert",
        });
      }
      const columns = entries
        .map(([name]) => this.dialect.quote(name))
        .join(", ");
      const placeholders = entries
        .map(([name, value]) => {
          values.push(this.encodeColumn(mutation.table, name, value));
          return this.dialect.placeholder(values.length);
        })
        .join(", ");
      const returning = mutation.returning === false ? "" : " RETURNING *";
      return {
        text: `INSERT INTO ${table} (${columns}) VALUES (${placeholders})${returning}`,
        values,
      };
    }

    if (mutation.kind === "update") {
      const entries = Object.entries(mutation.set);
      if (entries.length === 0) {
        throw new CmsError("An update needs at least one column.", {
          code: "empty_update",
        });
      }
      const assignments = entries
        .map(([name, value]) => {
          values.push(this.encodeColumn(mutation.table, name, value));
          return `${this.dialect.quote(name)} = ${this.dialect.placeholder(values.length)}`;
        })
        .join(", ");
      const where = this.compileWhere(mutation.table, mutation.where, values);
      const returning = mutation.returning === false ? "" : " RETURNING *";
      return {
        text: `UPDATE ${table} SET ${assignments} WHERE ${where}${returning}`,
        values,
      };
    }

    const where = this.compileWhere(mutation.table, mutation.where, values);
    const returning = mutation.returning === true ? " RETURNING *" : "";
    return {
      text: `DELETE FROM ${table} WHERE ${where}${returning}`,
      values,
    };
  }

  /** Turns driver output back into the values the engine declared. */
  decodeRow(table: string, row: Record<string, unknown>): Row {
    const decoded: Row = {};
    for (const [key, value] of Object.entries(row)) {
      const type = this.catalog.columnType(table, key);
      decoded[key] =
        type === undefined
          ? (value as ColumnValue)
          : this.dialect.decode(value, type);
    }
    return decoded;
  }

  private compileSelect(query: Query): string {
    if (!query.select || query.select.length === 0) return "*";
    return query.select
      .map((path) => {
        const resolved = this.resolve(query.table, path);
        if (resolved.path.length === 0) return this.dialect.quote(path);
        // The alias is the dotted path the caller asked for, so a row read
        // back is keyed the same way the query was written.
        return `${this.expression(resolved)} AS "${path.replaceAll('"', "")}"`;
      })
      .join(", ");
  }

  private compileWhere(table: string, where: Where, values: unknown[]): string {
    if (where.kind === "and" || where.kind === "or") {
      if (where.conditions.length === 0) return where.kind === "and" ? "1 = 1" : "1 = 0"; // prettier-ignore
      const joined = where.conditions
        .map((condition) => this.compileWhere(table, condition, values))
        .join(where.kind === "and" ? " AND " : " OR ");
      return `(${joined})`;
    }
    if (where.kind === "not") {
      return `NOT (${this.compileWhere(table, where.condition, values)})`;
    }

    const resolved = this.resolve(table, where.path);
    return this.compileComparison(
      resolved,
      where.operator,
      where.value,
      values,
    );
  }

  /**
   * A comparison decides the type of its own expression.
   *
   * The document body is untyped, so `views > 5` has to extract a number and
   * `slug > "a"` has to extract text out of the very same column. Postgres
   * refuses to compare the two, which is a feature: the cast belongs to the
   * comparison, not to the column.
   */
  private comparisonExpression(
    resolved: ResolvedPath,
    type: ColumnType,
  ): string {
    if (resolved.path.length === 0) return this.dialect.quote(resolved.column);
    return this.dialect.jsonExtract(resolved.column, resolved.path, type);
  }

  private compileComparison(
    resolved: ResolvedPath,
    operator: Comparator,
    value: ColumnValue | ColumnValue[],
    values: unknown[],
  ): string {
    const sample = Array.isArray(value) ? value[0] : value;
    const type = comparisonType(resolved, sample ?? null);
    const expression = this.comparisonExpression(resolved, type);

    const bind = (single: ColumnValue): string => {
      values.push(this.dialect.encode(single, type));
      return this.dialect.placeholder(values.length);
    };

    switch (operator) {
      case "eq":
      case "ne": {
        // `= NULL` is never true in SQL, and a filter on "has no value" is
        // the single most common way that bites a CMS query.
        if (value === null) {
          return `${expression} IS ${operator === "eq" ? "" : "NOT "}NULL`;
        }
        return `${expression} ${operator === "eq" ? "=" : "<>"} ${bind(value as ColumnValue)}`;
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const symbol = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[operator];
        return `${expression} ${symbol} ${bind(value as ColumnValue)}`;
      }
      case "in":
      case "nin": {
        const list = Array.isArray(value) ? value : [value];
        if (list.length === 0) return operator === "in" ? "1 = 0" : "1 = 1";
        const placeholders = list.map((entry) => bind(entry)).join(", ");
        return `${expression} ${operator === "in" ? "IN" : "NOT IN"} (${placeholders})`;
      }
      case "like":
      case "ilike": {
        const keyword = this.dialect.likeOperator(operator === "ilike");
        return `${expression} ${keyword} ${bind(value as ColumnValue)}`;
      }
      case "contains": {
        values.push(String(value));
        const placeholder = this.dialect.placeholder(values.length);
        return this.dialect.jsonArrayMembership(
          resolved.column,
          resolved.path,
          placeholder,
        );
      }
      case "exists":
        return `${expression} IS ${value === false ? "" : "NOT "}NULL`;
    }
  }

  private expression(resolved: ResolvedPath): string {
    if (resolved.path.length === 0) return this.dialect.quote(resolved.column);
    return this.dialect.jsonExtract(
      resolved.column,
      resolved.path,
      resolved.type,
    );
  }

  private resolve(table: string, path: string): ResolvedPath {
    const segments = path.split(".");
    const head = segments[0] as string;
    const headType = this.catalog.columnType(table, head);

    if (headType !== undefined && segments.length === 1) {
      return { column: head, path: [], type: headType };
    }
    if (headType !== undefined) {
      return { column: head, path: segments.slice(1), type: "text" };
    }

    // Not a column: it is a field, and fields live in the document body.
    const documentColumn = this.catalog.documentColumn(table);
    if (!documentColumn) {
      throw new CmsError(`Unknown column ${table}.${path}`, {
        status: 400,
        code: "unknown_column",
      });
    }
    return { column: documentColumn, path: segments, type: "text" };
  }

  private encodeColumn(
    table: string,
    column: string,
    value: ColumnValue,
  ): unknown {
    const type = this.catalog.columnType(table, column);
    if (type === undefined) {
      throw new CmsError(`Unknown column ${table}.${column}`, {
        status: 400,
        code: "unknown_column",
      });
    }
    return this.dialect.encode(value, type);
  }
}

/**
 * Comparing a JSON path uses the shape of the value, not of the column.
 *
 * The document body has no declared types, so `{ path: "views", value: 5 }`
 * has to cast the extracted text to a number and `{ value: "5" }` must not.
 * The caller's value is the only evidence available, and using it keeps the
 * comparison honest on Postgres, where the cast is mandatory.
 */
function comparisonType(
  resolved: ResolvedPath,
  value: ColumnValue,
): ColumnType {
  if (resolved.path.length === 0) return resolved.type;
  if (value instanceof Date) return "timestamp";
  if (typeof value === "number") return "real";
  if (typeof value === "boolean") return "boolean";
  return "text";
}

function integer(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new CmsError(`Expected a non-negative integer, received ${value}`, {
      code: "invalid_pagination",
    });
  }
  return value;
}
