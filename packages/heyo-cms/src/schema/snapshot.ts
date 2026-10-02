import type { ResolvedCollection } from "../types/config";
import type { FieldDefinition } from "../types/fields";
import type { JsonValue } from "../types/json";
import type {
  CollectionSnapshot,
  FieldSnapshot,
  IndexSnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "../types/schema";
import { systemTables } from "./system";

/** The table every user-declared collection and global is stored in. */
export const documentsTableName = "documents";
export const documentsDataColumn = "data";

export interface SnapshotInput {
  collections: Record<string, ResolvedCollection>;
  globals: Record<string, ResolvedCollection>;
  /** Tables contributed by plugins (`CmsPlugin.schema.tables`). */
  pluginTables?: TableSnapshot[];
}

/**
 * Builds the schema a configuration implies.
 *
 * Pure: the same configuration always produces the same snapshot, down to the
 * ordering of columns and indexes. `generate` diffs two of these and nothing
 * else, which is what makes a migration reviewable before any database is
 * involved.
 */
export function buildSchemaSnapshot(input: SnapshotInput): SchemaSnapshot {
  const collections = [
    ...Object.values(input.collections),
    ...Object.values(input.globals),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const contentIndexes = collections.flatMap(collectionIndexes);
  const tables = systemTables().map((table) =>
    table.name === documentsTableName
      ? {
          ...table,
          indexes: [...table.indexes, ...contentIndexes].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        }
      : table,
  );

  for (const table of input.pluginTables ?? []) tables.push(normalise(table));

  return {
    version: 1,
    tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
    collections: collections.map(collectionSnapshot),
  };
}

export function emptySnapshot(): SchemaSnapshot {
  return { version: 1, tables: [], collections: [] };
}

function normalise(table: TableSnapshot): TableSnapshot {
  return {
    ...table,
    columns: [...table.columns].sort((a, b) => a.name.localeCompare(b.name)),
    indexes: [...table.indexes].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function collectionSnapshot(
  collection: ResolvedCollection,
): CollectionSnapshot {
  return {
    name: collection.name,
    slug: collection.slug,
    kind: collection.kind,
    table: documentsTableName,
    documentColumn: documentsDataColumn,
    fields: Object.entries(collection.fields)
      .map(([name, field]) => fieldSnapshot(name, field))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function fieldSnapshot(name: string, field: FieldDefinition): FieldSnapshot {
  const defaultValue = field.defaultValue ?? field.column.default;
  return {
    name,
    type: field.type,
    localized: field.localized,
    required: field.required,
    unique: field.column.unique === true,
    index: field.column.index === true || field.column.unique === true,
    ...(defaultValue === undefined
      ? {}
      : { default: defaultValue as JsonValue }),
    ...(field.relationTo === undefined ? {} : { relationTo: field.relationTo }),
    column: field.column,
  };
}

/**
 * Expression indexes for the fields a collection asked to index.
 *
 * All collections share one table, so every content index is partial: an
 * index on `posts.slug` must not see `pages` rows, or two collections could
 * not use the same slug. Localized fields are skipped because their value is
 * a map of locales, and indexing one language would need a locale that does
 * not exist until somebody creates it.
 */
function collectionIndexes(collection: ResolvedCollection): IndexSnapshot[] {
  const indexes: IndexSnapshot[] = [];

  for (const [name, field] of Object.entries(collection.fields)) {
    const unique = field.column.unique === true;
    const wanted = unique || field.column.index === true;
    if (!wanted || field.localized) continue;

    indexes.push({
      name: indexName(collection.slug, name, unique),
      table: documentsTableName,
      targets: [
        {
          kind: "json",
          column: documentsDataColumn,
          path: [name],
          type: field.column.type,
        },
      ],
      unique,
      where: { column: "collection", equals: collection.slug },
    });
  }

  return indexes.sort((a, b) => a.name.localeCompare(b.name));
}

function indexName(slug: string, field: string, unique: boolean): string {
  return `${unique ? "uniq" : "idx"}_documents_${slug}_${field}`;
}
