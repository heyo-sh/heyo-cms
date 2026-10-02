import type {
  ColumnChange,
  ColumnSnapshot,
  FieldSnapshot,
  IndexSnapshot,
  MigrationStep,
  SchemaSnapshot,
  TableSnapshot,
} from "../types/schema";

/**
 * Diffs two snapshots into migration steps.
 *
 * Deterministic twice over: the inputs are sorted, and the steps are grouped
 * into fixed phases rather than emitted in discovery order. Running
 * `generate` twice on an unchanged configuration therefore produces an empty
 * list, which is the property the plan asks for — a generator that sometimes
 * writes a no-op migration is a generator nobody trusts.
 */
export function planMigration(
  from: SchemaSnapshot,
  to: SchemaSnapshot,
): MigrationStep[] {
  const createTables: MigrationStep[] = [];
  const addColumns: MigrationStep[] = [];
  const alterColumns: MigrationStep[] = [];
  const dropIndexes: MigrationStep[] = [];
  const createIndexes: MigrationStep[] = [];
  const backfills: MigrationStep[] = [];
  const dropColumns: MigrationStep[] = [];
  const dropTables: MigrationStep[] = [];

  const before = byName(from.tables);
  const after = byName(to.tables);

  const created: TableSnapshot[] = [];
  for (const table of sorted(to.tables)) {
    const previous = before.get(table.name);
    if (!previous) {
      created.push(table);
      for (const index of sorted(table.indexes)) {
        createIndexes.push({ kind: "create_index", index });
      }
      continue;
    }
    diffColumns(previous, table, addColumns, alterColumns, dropColumns);
    diffIndexes(previous, table, dropIndexes, createIndexes);
  }
  for (const table of orderByReferences(created)) {
    createTables.push({ kind: "create_table", table });
  }

  const removed = sorted(from.tables).filter((table) => !after.has(table.name));
  // Dropped in the reverse order they would be created: a table nothing
  // points at goes first, so a foreign key never outlives its target.
  for (const table of orderByReferences(removed).reverse()) {
    dropTables.push({ kind: "drop_table", table: table.name });
  }

  diffCollections(from, to, backfills);

  return [
    ...createTables,
    ...addColumns,
    ...alterColumns,
    ...dropIndexes,
    ...createIndexes,
    ...backfills,
    ...dropColumns,
    ...dropTables,
  ];
}

/**
 * Orders tables so a foreign key is never created before its target.
 *
 * Alphabetical order puts `cms_api_keys` before `cms_users`, which Postgres
 * rejects outright and SQLite accepts only because it resolves references
 * lazily. A topological sort with alphabetical tie-breaking keeps the output
 * both valid and deterministic.
 */
function orderByReferences(tables: TableSnapshot[]): TableSnapshot[] {
  const remaining = new Map(sorted(tables).map((table) => [table.name, table]));
  const ordered: TableSnapshot[] = [];
  const visiting = new Set<string>();

  const visit = (table: TableSnapshot): void => {
    if (!remaining.has(table.name)) return;
    // A cycle (two tables referencing each other) cannot be ordered; emitting
    // the table anyway leaves the engine to report the real error.
    if (visiting.has(table.name)) return;
    visiting.add(table.name);

    for (const column of sorted(table.columns)) {
      const target = column.references?.table;
      if (target === undefined || target === table.name) continue;
      const dependency = remaining.get(target);
      if (dependency) visit(dependency);
    }

    visiting.delete(table.name);
    if (remaining.delete(table.name)) ordered.push(table);
  };

  for (const table of sorted(tables)) visit(table);
  return ordered;
}

function diffColumns(
  from: TableSnapshot,
  to: TableSnapshot,
  addColumns: MigrationStep[],
  alterColumns: MigrationStep[],
  dropColumns: MigrationStep[],
): void {
  const before = byName(from.columns);
  const after = byName(to.columns);

  for (const column of sorted(to.columns)) {
    const previous = before.get(column.name);
    if (!previous) {
      addColumns.push({ kind: "add_column", table: to.name, column });
      continue;
    }
    const changes = columnChanges(previous, column);
    if (changes.length > 0) {
      alterColumns.push({
        kind: "alter_column",
        table: to.name,
        column,
        previous,
        changes,
      });
    }
  }

  for (const column of sorted(from.columns)) {
    if (!after.has(column.name)) {
      dropColumns.push({
        kind: "drop_column",
        table: from.name,
        column: column.name,
      });
    }
  }
}

function columnChanges(
  from: ColumnSnapshot,
  to: ColumnSnapshot,
): ColumnChange[] {
  const changes: ColumnChange[] = [];
  if (from.type !== to.type || from.array !== to.array) changes.push("type");
  if (from.nullable !== to.nullable) changes.push("nullable");
  if (!same(from.default, to.default)) changes.push("default");
  if (!same(from.references, to.references)) changes.push("references");
  return changes;
}

/**
 * Index changes are a drop plus a create, never an alter.
 *
 * No engine can modify an index in place, and pretending otherwise would put
 * a three-way branch in every adapter for a step that is rare and cheap.
 */
function diffIndexes(
  from: TableSnapshot,
  to: TableSnapshot,
  dropIndexes: MigrationStep[],
  createIndexes: MigrationStep[],
): void {
  const before = byName(from.indexes);
  const after = byName(to.indexes);

  for (const index of sorted(from.indexes)) {
    const next = after.get(index.name);
    if (!next) {
      dropIndexes.push({ kind: "drop_index", table: from.name, index: index.name }); // prettier-ignore
      continue;
    }
    if (!sameIndex(index, next)) {
      dropIndexes.push({ kind: "drop_index", table: from.name, index: index.name }); // prettier-ignore
    }
  }

  for (const index of sorted(to.indexes)) {
    const previous = before.get(index.name);
    if (!previous || !sameIndex(previous, index)) {
      createIndexes.push({ kind: "create_index", index });
    }
  }
}

function sameIndex(from: IndexSnapshot, to: IndexSnapshot): boolean {
  return (
    from.unique === to.unique &&
    same(from.targets, to.targets) &&
    same(from.where, to.where)
  );
}

/**
 * Content changes that move data rather than schema.
 *
 * A new field with a default has to reach documents that predate it, or a
 * query filtering on that default would skip every older row; a removed field
 * has to leave the body, or it would keep appearing in reads forever. Both
 * are expressed as steps so MongoDB — which has no DDL at all — still has
 * something to apply.
 */
function diffCollections(
  from: SchemaSnapshot,
  to: SchemaSnapshot,
  backfills: MigrationStep[],
): void {
  const before = byName(from.collections);

  for (const collection of sorted(to.collections)) {
    const previous = before.get(collection.name);
    const previousFields = byName(previous?.fields ?? []);

    for (const field of sorted(collection.fields)) {
      const existing = previousFields.get(field.name);
      const defaultChanged = !same(existing?.default, field.default);
      const isNew = existing === undefined;

      // A localized value is a map keyed by locale, and the set of locales is
      // a table rather than a constant, so there is no single path to write.
      // Reads fill those in through the fallback rules instead (section 9).
      if (field.localized) continue;

      if (field.default !== undefined && (isNew || defaultChanged)) {
        backfills.push({
          kind: "set_document_field",
          table: collection.table,
          collection: collection.slug,
          documentColumn: collection.documentColumn,
          path: fieldPath(field),
          value: field.default,
        });
      }
    }

    if (previous) {
      const fields = byName(collection.fields);
      for (const field of sorted(previous.fields)) {
        if (!fields.has(field.name) && !field.localized) {
          backfills.push({
            kind: "unset_document_field",
            table: collection.table,
            collection: collection.slug,
            documentColumn: collection.documentColumn,
            path: fieldPath(field),
          });
        }
      }
    }
  }

  // A collection that disappeared from the configuration emits nothing. Its
  // rows stay where they are: deleting content because a developer commented
  // out a block is not a migration, it is data loss with a changelog entry.
}

function fieldPath(field: FieldSnapshot): string[] {
  return [field.name];
}

function byName<T extends { name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.name, item]));
}

function sorted<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

/** Structural equality over snapshot values, which are plain JSON. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return stableStringify(a) === stableStringify(b);
}

/**
 * JSON with sorted keys.
 *
 * Property order is an implementation detail of whatever built the object, and
 * a diff that noticed it would write migrations for changes that did not
 * happen.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"; // prettier-ignore
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}
