import { asObject, toIso } from "../engine/documents";
import { globalRowId } from "../engine/engine";
import { and, eq, gt, inList } from "../query";
import { documentsTableName } from "../schema/snapshot";
import type { ResolvedCollection } from "../types/config";
import type { CmsInstance } from "../types/instance";
import type { JsonValue } from "../types/json";
import type { Row, Where } from "../types/query";
import {
  exportFormat,
  exportVersion,
  type ContentRecord,
  type DocumentRecord,
  type ExportHeader,
  type GlobalRecord,
} from "./records";

export interface ExportOptions {
  /** Collection names. Defaults to every collection in the configuration. */
  collections?: string[];
  /** Global names. Defaults to every global. */
  globals?: string[];
  /** Includes documents that are in the trash. Off by default. */
  includeTrashed?: boolean;
  /** Rows per query. Paging keeps a large dump off the heap. */
  batchSize?: number;
}

/**
 * Reads the content out, one record at a time.
 *
 * This is the one operation in the package that reads rows rather than
 * documents, and it has a reason: a read resolves a locale, and an export
 * that resolved a locale would drop every translation it did not pick. So the
 * export takes the storage shape — locale maps and all — and the importer
 * writes it back through the ordinary API, which is what keeps the single
 * write path the engine is built around (stage 3) intact in both directions.
 *
 * It yields instead of returning an array because the caller is a CLI writing
 * to a file descriptor: a collection with a hundred thousand documents must
 * cost a constant amount of memory to export.
 */
export async function* exportContent(
  cms: CmsInstance,
  options: ExportOptions = {},
): AsyncGenerator<ContentRecord> {
  const config = cms._config;
  const collections = select(config.collections, options.collections, "collection"); // prettier-ignore
  const globals = select(config.globals, options.globals, "global");
  const adapter = await cms.database();

  const header: ExportHeader = {
    kind: "header",
    format: exportFormat,
    version: exportVersion,
    exportedAt: new Date().toISOString(),
    database: adapter.id,
    defaultLocale: config.i18n.defaultLocale,
    collections: collections.map((collection) => collection.name),
    globals: globals.map((global) => global.name),
  };
  yield header;

  const batchSize = Math.max(1, options.batchSize ?? 200);

  for (const collection of collections) {
    let after: string | undefined;
    for (;;) {
      const rows = await read(cms, {
        where: and(
          eq("collection", collection.slug),
          options.includeTrashed ? undefined : eq("deleted_at", null),
          after === undefined ? undefined : gt("id", after),
        ),
        limit: batchSize,
      });
      if (rows.length === 0) break;
      for (const row of rows) yield documentRecord(collection, row, options);
      after = String(rows[rows.length - 1]?.id);
      if (rows.length < batchSize) break;
    }
  }

  if (globals.length > 0) {
    const rows = await read(cms, {
      where: inList(
        "id",
        globals.map((global) => globalRowId(global)),
      ),
      limit: globals.length,
    });
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    for (const global of globals) {
      const row = byId.get(globalRowId(global));
      // A global nobody has saved is still exported: its defaults are part of
      // the content, and an importer that found it missing could not tell
      // "never configured" from "exported before it existed".
      yield {
        kind: "global",
        global: global.name,
        data: row ? asObject(row.data) : {},
        updatedAt: row ? toIso(row.updated_at) : null,
      } satisfies GlobalRecord;
    }
  }
}

function documentRecord(
  collection: ResolvedCollection,
  row: Row,
  options: ExportOptions,
): DocumentRecord {
  const record: DocumentRecord = {
    kind: "document",
    collection: collection.name,
    id: String(row.id),
    data: asObject(row.data),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (options.includeTrashed) record.deletedAt = toIso(row.deleted_at);
  const scheduledAt = toIso(row.scheduled_at);
  if (scheduledAt !== null) {
    record.scheduledAt = scheduledAt;
    // The patch alone. `scheduled_patch` also stores whose permissions the
    // change will carry, and an actor from another deployment means nothing
    // in this one.
    record.scheduledPatch = (asObject(row.scheduled_patch).data ??
      null) as JsonValue;
  }
  return record;
}

async function read(
  cms: CmsInstance,
  query: { where: Where | undefined; limit: number },
): Promise<Row[]> {
  const adapter = await cms.database();
  return adapter.transaction((tx) =>
    adapter.query(tx, {
      table: documentsTableName,
      ...(query.where === undefined ? {} : { where: query.where }),
      orderBy: [{ path: "id", direction: "asc" }],
      limit: query.limit,
    }),
  );
}

/**
 * Resolves names to definitions, refusing one that does not exist.
 *
 * A typo in `--collections` has to be an error: exporting nothing because
 * `post` is not `posts` is a backup somebody only discovers when they need
 * it.
 */
function select(
  declared: Record<string, ResolvedCollection>,
  requested: string[] | undefined,
  label: string,
): ResolvedCollection[] {
  if (!requested) return Object.values(declared);
  return requested.map((name) => {
    const found = declared[name];
    if (!found) {
      const known = Object.keys(declared).join(", ") || "none";
      throw new Error(`Unknown ${label}: ${name}. Declared: ${known}.`);
    }
    return found;
  });
}
