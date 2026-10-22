import type { JsonObject, JsonValue } from "../types/json";

/**
 * The on-disk format of an export: newline-delimited JSON.
 *
 * One record per line, header first. The choice is not cosmetic: a content
 * dump is the one file in a CMS that routinely outgrows memory, and NDJSON is
 * the only JSON shape that can be written and read a record at a time. It also
 * diffs, greps and `tail`s, which a single array wrapped in two brackets does
 * not.
 */
export const exportFormat = "heyo-cms/export";
export const exportVersion = 1;

/**
 * The first line of every file.
 *
 * It carries what the importer has to check before it writes anything — the
 * format and its version — and what a human has to know a year later: when it
 * was taken, from which engine, and what is in it.
 */
export interface ExportHeader {
  kind: "header";
  format: typeof exportFormat;
  version: number;
  exportedAt: string;
  /** `postgres`, `sqlite`, `d1`, `mongodb`. Informational. */
  database: string;
  /** The default locale at the time of export; the importer writes into it. */
  defaultLocale: string;
  collections: string[];
  globals: string[];
}

/**
 * One document, in storage shape.
 *
 * `data` is what the row holds, not what a read returns: a localized field is
 * a `{ [locale]: value }` map here, because an export that resolved one
 * language would silently drop every translation. The importer takes the maps
 * apart again and writes each locale through the ordinary API.
 */
export interface DocumentRecord {
  kind: "document";
  collection: string;
  id: string;
  data: JsonObject;
  createdAt: string | null;
  updatedAt: string | null;
  /** Set only on an export that asked for the trash. */
  deletedAt?: string | null;
  scheduledAt?: string | null;
  scheduledPatch?: JsonValue;
}

/** A singleton. Same shape, no id: its row id is derived from the slug. */
export interface GlobalRecord {
  kind: "global";
  global: string;
  data: JsonObject;
  updatedAt: string | null;
}

export type ContentRecord = ExportHeader | DocumentRecord | GlobalRecord;

/** Parses one line. Throws with the line number, which is what a reader needs. */
export function parseRecord(line: string, lineNumber: number): ContentRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Line ${lineNumber} is not JSON.`);
  }
  if (!isRecord(parsed) || typeof parsed.kind !== "string") {
    throw new Error(`Line ${lineNumber} has no "kind".`);
  }
  if (!["header", "document", "global"].includes(parsed.kind)) {
    throw new Error(`Line ${lineNumber} has an unknown kind: ${parsed.kind}.`);
  }
  if (parsed.kind === "header") {
    if (
      typeof parsed.format !== "string" ||
      !Number.isInteger(parsed.version)
    ) {
      throw new Error(`Line ${lineNumber} has an invalid export header.`);
    }
  } else {
    const name = parsed.kind === "document" ? parsed.collection : parsed.global;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      !isRecord(parsed.data)
    ) {
      throw new Error(
        `Line ${lineNumber} needs a collection/global name and an object "data".`,
      );
    }
    if (
      parsed.kind === "document" &&
      (typeof parsed.id !== "string" || parsed.id.length === 0)
    ) {
      throw new Error(`Line ${lineNumber} needs a non-empty document "id".`);
    }
  }
  return parsed as unknown as ContentRecord;
}

/**
 * Reads an NDJSON stream into records.
 *
 * Blank lines are skipped rather than refused: a file that was concatenated,
 * edited or produced by a shell redirect is still a valid export, and failing
 * on a trailing newline would be a rule nobody could guess.
 */
export async function* readRecords(
  lines: AsyncIterable<string>,
): AsyncGenerator<ContentRecord> {
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    yield parseRecord(trimmed, lineNumber);
  }
}

/** Splits a chunked stream into lines, so a reader never buffers the file. */
export async function* toLines(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

export function serializeRecord(record: ContentRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
