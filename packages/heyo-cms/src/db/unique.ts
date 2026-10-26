import { CmsError } from "../errors";
import type { Row } from "../types/query";
import type { IndexSnapshot, SchemaSnapshot } from "../types/schema";

/**
 * Which unique rule a write broke, in the words the engine used.
 *
 * Postgres and MongoDB name the index. SQLite names the index when it is one
 * and the columns when the rule is a column's own — a primary key, above all.
 */
export interface UniqueViolation {
  index?: string;
  columns?: string[];
}

/**
 * Reads a unique violation out of a SQLite or D1 error.
 *
 * By the message, because that is the one thing `bun:sqlite`, `node:sqlite`,
 * `better-sqlite3` and a D1 binding agree on: their codes live on different
 * properties, and D1 adds its own prefix and suffix to the same sentence.
 */
export function sqliteUniqueViolation(error: unknown): UniqueViolation | null {
  const message = messageOf(error);
  const failed = /UNIQUE constraint failed: (.*)/.exec(message)?.[1];
  if (failed === undefined) return null;
  const index = /^index '([^']+)'/.exec(failed)?.[1];
  if (index !== undefined) return { index };
  // `documents.id` or `t.a, t.b`, possibly followed by D1's `: SQLITE_…`.
  const columns = (/^[\w.]+(?:, [\w.]+)*/.exec(failed)?.[0] ?? "")
    .split(", ")
    .map((qualified) => qualified.slice(qualified.lastIndexOf(".") + 1))
    .filter(Boolean);
  return columns.length > 0 ? { columns } : {};
}

/**
 * Reads a unique violation out of a Postgres error.
 *
 * SQLSTATE 23505 is the same for `pg`, Neon, PGlite and postgres.js. The
 * constraint is `constraint` on the first three and `constraint_name` on the
 * last; the message carries it for anything else.
 */
export function postgresUniqueViolation(
  error: unknown,
): UniqueViolation | null {
  if (typeof error !== "object" || error === null) return null;
  const fields = error as Record<string, unknown>;
  if (fields.code !== "23505") return null;
  const named = fields.constraint ?? fields.constraint_name;
  const index =
    typeof named === "string"
      ? named
      : /unique constraint "([^"]+)"/.exec(messageOf(error))?.[1];
  return index === undefined ? {} : { index };
}

/**
 * Reads a unique violation out of a MongoDB error: code 11000, or the
 * `E11000` the message starts with when the code is not carried over.
 */
export function mongoUniqueViolation(error: unknown): UniqueViolation | null {
  const message = messageOf(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== 11000 && !message.startsWith("E11000")) return null;
  const index = /index: (\S+)/.exec(message)?.[1];
  return index === undefined ? {} : { index };
}

/**
 * The 409 a broken unique rule is, instead of the 500 an unknown driver error
 * would be.
 *
 * Said the way the person who sent the write thinks about it. A content
 * field's index becomes "handle is already used", with the field in
 * `details.fields` like a validation error, so a form can put it next to the
 * input; the documents' primary key becomes the id an import tried to reuse.
 * The driver's error stays as the `cause`, for the operator's log only.
 */
export function uniqueConflict(
  schema: SchemaSnapshot,
  table: string,
  violation: UniqueViolation,
  values: Row | undefined,
  cause: unknown,
): CmsError {
  const conflict = (message: string, details?: Record<string, unknown>) =>
    new CmsError(message, {
      status: 409,
      code: "conflict",
      cause,
      ...(details === undefined ? {} : { details }),
    });

  const target = schema.tables.find((entry) => entry.name === table);
  const index = findIndex(schema, table, violation);

  if (index?.where?.column === "collection") {
    const collection = schema.collections.find(
      (entry) =>
        entry.slug === index.where?.equals && entry.table === index.table,
    );
    const json = index.targets.length === 1 ? index.targets[0] : undefined;
    const field = json?.kind === "json" ? json.path.join(".") : undefined;
    if (collection !== undefined && field !== undefined) {
      // Trashed documents keep their values, and the index still sees them:
      // the clash an editor cannot find in the list is usually there.
      const problem = "is already used by another document";
      return conflict(
        `${collection.name}: ${field} ${problem}, possibly one in the trash.`,
        { fields: { [field]: problem } },
      );
    }
  }

  const columns =
    index?.targets.map((entry) => entry.column) ?? violation.columns ?? [];
  const primaryKey = target?.primaryKey ?? [];
  const row = schema.collections.some((entry) => entry.table === table)
    ? "A document"
    : `A ${table} row`;
  const isPrimaryKey =
    violation.index === `${table}_pkey` ||
    violation.index === "_id_" ||
    (columns.length > 0 && sameColumns(columns, primaryKey));
  if (isPrimaryKey) {
    // An explicit id on create is how an import keeps references; reusing
    // one is the mistake this names.
    const key = primaryKey.length === 1 ? primaryKey[0] : undefined;
    const id = key === undefined ? undefined : values?.[key];
    return conflict(
      typeof id === "string"
        ? `${row} with the id "${id}" already exists.`
        : `${row} with the same ${primaryKey.join(", ") || "key"} already exists.`,
    );
  }

  return conflict(
    columns.length > 0
      ? `${row} with the same ${columns.join(", ")} already exists.`
      : `${row} with the same unique value already exists.`,
  );
}

function findIndex(
  schema: SchemaSnapshot,
  table: string,
  violation: UniqueViolation,
): IndexSnapshot | undefined {
  const indexes = schema.tables.flatMap((entry) => entry.indexes);
  if (violation.index !== undefined) {
    return indexes.find((entry) => entry.name === violation.index);
  }
  const columns = violation.columns;
  if (columns === undefined) return undefined;
  return indexes.find(
    (entry) =>
      entry.table === table &&
      entry.unique &&
      entry.targets.every((target) => target.kind === "column") &&
      sameColumns(
        entry.targets.map((target) => target.column),
        columns,
      ),
  );
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((column) => b.includes(column));
}

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
}
