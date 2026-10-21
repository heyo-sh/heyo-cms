import { CmsError } from "../errors";
import { and, eq, gt, lt, or } from "../query";
import type { ColumnValue, OrderBy, Row, Where } from "../types/query";

/**
 * One component of a cursor.
 *
 * The type tag exists because a timestamp has to come back as a `Date`: the
 * adapters decide how a date is encoded, and handing them a string would make
 * the comparison depend on the engine's text collation instead of on time.
 */
interface CursorEntry {
  path: string;
  value: string | number | boolean | null;
  date: boolean;
}

/**
 * Keyset pagination over the sort the caller asked for.
 *
 * `offset` re-reads and re-skips every preceding row, which is what makes
 * page 400 of an archive slow and what makes a page shift when somebody
 * publishes while a reader is paging. A cursor is a `WHERE`, so it costs the
 * same on page 400 as on page 1 and cannot skip or repeat a row.
 */
export function encodeCursor(row: Row, orderBy: OrderBy[]): string {
  const entries: CursorEntry[] = orderBy.map((entry) => {
    const value = valueAt(row, entry.path);
    return {
      path: entry.path,
      value: value instanceof Date ? value.toISOString() : toPrimitive(value),
      date: value instanceof Date,
    };
  });
  return encode(JSON.stringify(entries));
}

/**
 * Turns a cursor back into a filter.
 *
 * For `a asc, b desc` the predicate is `a > va OR (a = va AND b < vb)`: one
 * disjunct per sort key, each pinning the keys before it. The last key is
 * always `id`, so the comparison is total and no two rows can tie.
 */
export function cursorWhere(cursor: string, orderBy: OrderBy[]): Where {
  const entries = decode(cursor);
  if (entries.length !== orderBy.length) {
    throw new CmsError("This cursor does not match the requested sort order.", {
      status: 400,
      code: "invalid_cursor",
    });
  }

  const disjuncts: Where[] = [];
  for (let index = 0; index < orderBy.length; index += 1) {
    const conditions: Where[] = [];
    for (let before = 0; before < index; before += 1) {
      const entry = entries[before] as CursorEntry;
      conditions.push(eq(entry.path, restore(entry)));
    }
    const entry = entries[index] as CursorEntry;
    const direction = (orderBy[index] as OrderBy).direction;
    conditions.push(
      direction === "desc"
        ? lt(entry.path, restore(entry))
        : gt(entry.path, restore(entry)),
    );
    disjuncts.push(and(...conditions));
  }
  return or(...disjuncts);
}

function decode(cursor: string): CursorEntry[] {
  try {
    const parsed: unknown = JSON.parse(decodeText(cursor));
    if (!Array.isArray(parsed)) throw new Error("not a cursor");
    return parsed as CursorEntry[];
  } catch {
    throw new CmsError("This cursor is not readable.", {
      status: 400,
      code: "invalid_cursor",
    });
  }
}

function restore(entry: CursorEntry): Date | string | number | boolean | null {
  return entry.date && typeof entry.value === "string"
    ? new Date(entry.value)
    : entry.value;
}

/**
 * A sort path may address a column or a field inside the document body, and
 * the row carries whichever the adapter returned. Looking in both places
 * keeps `orderBy("title")` and `orderBy("created_at")` the same feature.
 */
function valueAt(row: Row, path: string): ColumnValue | undefined {
  if (path in row) return row[path];
  const segments = path.split(".");
  let current: unknown = row.data ?? row;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current as ColumnValue | undefined;
}

function toPrimitive(
  value: ColumnValue | undefined,
): string | number | boolean | null {
  // prettier-ignore
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return null;
  return value;
}

/** base64url without `Buffer`: the core also runs on Workers. */
function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeText(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
