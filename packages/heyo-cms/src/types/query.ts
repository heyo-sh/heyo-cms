import type { JsonValue } from "./json";

/**
 * A value as it crosses the adapter boundary.
 *
 * `Date` is kept distinct from its serialisation: Postgres wants a timestamp,
 * SQLite wants an integer, MongoDB wants a `Date`. Deciding that inside the
 * adapter is the only way the engine can stay engine-agnostic.
 */
export type ColumnValue = JsonValue | Date | Uint8Array;

export type Row = Record<string, ColumnValue>;

/**
 * A dotted path into a row: `id`, `created_at`, `data.title`, `data.title.pl`.
 *
 * Field names are validated to exclude dots, so splitting on `.` is lossless.
 * The first segment names a column; the rest, when present, address a path
 * inside that column's JSON document.
 */
export type FieldPath = string;

export type Comparator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "like"
  | "ilike"
  | "contains"
  | "exists";

/**
 * The filter AST.
 *
 * This is the hard boundary from section 12: the engine builds `Where`, the
 * adapter turns it into SQL or into a MongoDB filter document. If a feature
 * cannot be expressed here, it cannot be expressed in the engine either —
 * which is the constraint that keeps a third database adapter cheap.
 */
export type Where =
  | { kind: "and"; conditions: Where[] }
  | { kind: "or"; conditions: Where[] }
  | { kind: "not"; condition: Where }
  | {
      kind: "compare";
      path: FieldPath;
      operator: Comparator;
      value: ColumnValue | ColumnValue[];
    };

export interface OrderBy {
  path: FieldPath;
  direction: "asc" | "desc";
}

export interface Query {
  table: string;
  /** Omitted means every column. Paths may reach into the document body. */
  select?: FieldPath[];
  where?: Where;
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
  /**
   * Returns a single row `{ count }` instead of the matching rows. Counting
   * belongs in the AST rather than in a second adapter method, so pagination
   * never needs a code path the adapter contract does not cover.
   */
  count?: boolean;
}

export type Mutation =
  | { kind: "insert"; table: string; values: Row; returning?: boolean }
  | {
      kind: "update";
      table: string;
      where: Where;
      set: Row;
      returning?: boolean;
    }
  | { kind: "delete"; table: string; where: Where; returning?: boolean };

/**
 * What a mutation reports back.
 *
 * The plan sketched `Promise<Row>`, which cannot describe a delete or a
 * multi-row update. `count` is always meaningful; `rows` is populated when the
 * mutation asked for `returning`.
 */
export interface MutationResult {
  rows: Row[];
  count: number;
}

/**
 * A transaction handle.
 *
 * `real` is false when the engine could not start a true transaction — MongoDB
 * without a replica set. Hooks and the outbox read it to switch to the
 * compensating path instead of silently losing atomicity (section 12).
 */
export interface Tx {
  readonly id: string;
  readonly real: boolean;
}
