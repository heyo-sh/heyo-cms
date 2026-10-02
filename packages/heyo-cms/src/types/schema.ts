import type { JsonPrimitive, JsonValue } from "./json";

/**
 * The storage types every supported engine can express.
 *
 * The list is deliberately short. A type that only Postgres understands would
 * force the MongoDB and SQLite adapters to invent a translation, and the field
 * registry would start encoding engine differences that the plan puts behind
 * the adapter boundary (section 12).
 */
export type ColumnType =
  | "text"
  | "integer"
  | "bigint"
  | "real"
  | "boolean"
  | "timestamp"
  | "json"
  | "blob";

/** What a foreign key points at, and what happens when the target goes away. */
export interface ForeignKeyDefinition {
  table: string;
  column: string;
  onDelete?: "cascade" | "set-null" | "restrict";
}

/**
 * Where a value physically lives.
 *
 * `document` means "inside the JSON body of the row". Content fields use it,
 * which is what lets a new locale or a new field ship without a table
 * rewrite (sections 9 and 12). System collections use `column`, because they
 * are queried by the engine itself on every request.
 */
export type ColumnStorage = "column" | "document";

/**
 * What a field type asks the storage layer for.
 *
 * Returned by `FieldType.column()`. For content fields only `type`, `nullable`,
 * `array`, `unique`, `index` and `default` are meaningful: the value lands in
 * the document body, and `unique`/`index` become expression indexes over the
 * JSON path rather than table columns.
 */
export interface ColumnDefinition {
  type: ColumnType;
  nullable?: boolean;
  /** Literal default. Non-literal defaults belong in a hook, not in DDL. */
  default?: JsonPrimitive;
  unique?: boolean;
  index?: boolean;
  /** Multi-value field: stored as a JSON array, never as a native array type. */
  array?: boolean;
  references?: ForeignKeyDefinition;
  storage?: ColumnStorage;
}

/** A column as it exists in a snapshot: a definition that knows its name. */
export interface ColumnSnapshot extends ColumnDefinition {
  name: string;
  nullable: boolean;
}

/**
 * An index target.
 *
 * `json` targets are what make content queryable without promoting fields to
 * columns: Postgres indexes the `data ->> 'slug'` expression, SQLite indexes
 * `json_extract(data, '$.slug')`, MongoDB indexes `data.slug`. Same snapshot,
 * three renderings, decided inside the adapter.
 */
export type IndexTarget =
  | { kind: "column"; column: string }
  | { kind: "json"; column: string; path: string[]; type: ColumnType };

export interface IndexSnapshot {
  name: string;
  table: string;
  targets: IndexTarget[];
  unique: boolean;
  /**
   * A partial-index predicate, restricted to one equality on purpose.
   *
   * Every content collection shares the `documents` table, so an index for
   * `posts.slug` has to exclude the other collections' rows. One equality is
   * all that requires, and it is the only predicate all three engines express
   * identically (`WHERE`, `WHERE`, `partialFilterExpression`).
   */
  where?: { column: string; equals: string };
}

export interface TableSnapshot {
  name: string;
  /** Sorted by name so two runs of `generate` cannot disagree on ordering. */
  columns: ColumnSnapshot[];
  primaryKey: string[];
  indexes: IndexSnapshot[];
  /**
   * The collection this table stores, when it is a content table. Backfill
   * steps need it to scope an update to one collection inside `documents`.
   */
  documentColumn?: string;
}

/**
 * A content field as the migration layer sees it.
 *
 * Content lives in a JSON body, so most field changes move no DDL at all.
 * They still have to be recorded: adding a field with a default is a
 * backfill, removing one is a cleanup, and marking one unique is an index.
 * Without this logical layer the diff would see two identical `documents`
 * tables and generate nothing.
 */
export interface FieldSnapshot {
  name: string;
  type: string;
  localized: boolean;
  required: boolean;
  unique: boolean;
  index: boolean;
  default?: JsonValue;
  relationTo?: string;
  column: ColumnDefinition;
}

export interface CollectionSnapshot {
  name: string;
  slug: string;
  kind: "collection" | "global";
  /** The physical table; `documents` for everything the user declares. */
  table: string;
  documentColumn: string;
  /** Sorted by name. */
  fields: FieldSnapshot[];
}

export interface SchemaSnapshot {
  version: 1;
  /** Sorted by name. Determinism is the whole point of the snapshot. */
  tables: TableSnapshot[];
  /** Sorted by name. The logical layer behind the JSON document body. */
  collections: CollectionSnapshot[];
}

/** Which attributes of a column a migration has to alter. */
export type ColumnChange = "type" | "nullable" | "default" | "references";

/**
 * A neutral migration step.
 *
 * `plan()` produces these from two snapshots and nothing else, so the same
 * diff drives a `.sql` file on Postgres, a `.sql` file on SQLite and an index
 * plus backfill program on MongoDB. No SQL is constructed outside an adapter.
 */
export type MigrationStep =
  | { kind: "create_table"; table: TableSnapshot }
  | { kind: "drop_table"; table: string }
  | { kind: "add_column"; table: string; column: ColumnSnapshot }
  | { kind: "drop_column"; table: string; column: string }
  | {
      kind: "alter_column";
      table: string;
      column: ColumnSnapshot;
      previous: ColumnSnapshot;
      changes: ColumnChange[];
    }
  | { kind: "create_index"; index: IndexSnapshot }
  | { kind: "drop_index"; table: string; index: string }
  | {
      /** Writes a default into documents that predate the field. */
      kind: "set_document_field";
      table: string;
      collection: string;
      documentColumn: string;
      path: string[];
      value: JsonValue;
    }
  | {
      /** Removes a field that left the collection, so reads stop seeing it. */
      kind: "unset_document_field";
      table: string;
      collection: string;
      documentColumn: string;
      path: string[];
    };

/**
 * A migration as it is written into the repository.
 *
 * SQL engines get `.sql` a human can read in a pull request; MongoDB has no
 * DDL, so it gets the step list itself — index creations, uniqueness changes
 * and backfills — as data the adapter replays. Both are reviewed the same way,
 * numbered the same way and applied by the same CLI.
 */
export interface MigrationArtifact {
  /** `0003_add_posts_slug_index` — numbered, ordered, stable. */
  id: string;
  extension: "sql" | "json";
  content: string;
  /** One line per step, printed by `heyo-cms generate`. */
  summary: string[];
}
