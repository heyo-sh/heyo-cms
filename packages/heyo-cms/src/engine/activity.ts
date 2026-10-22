import { CmsError } from "../errors";
import { and, eq, lt } from "../query";
import type { ActorSource, OperationSource } from "../types/actor";
import type {
  ActivityEntry,
  ActivityListArgs,
  ActivityPage,
  CmsActivity,
} from "../types/activity";
import type { DatabaseAdapter } from "../types/database";
import type { JsonObject } from "../types/json";
import type { Row, Where } from "../types/query";
import { asObject, toIso } from "./documents";

const activityTable = "activity";
const defaultLimit = 50;
const maxLimit = 200;

export interface ActivityReaderOptions {
  database: () => Promise<DatabaseAdapter>;
}

/**
 * `cms.activity`: reading the trail the engine writes.
 *
 * Paged by the row id, descending. The ids are ordered — that is why they are
 * generated the way they are — so the cursor is the last id and nothing else:
 * paging by `created_at` would repeat or skip rows every time two writes to
 * the same document land in the same millisecond, which is the normal case
 * for a form that saves five fields.
 */
export function createActivity(options: ActivityReaderOptions): CmsActivity {
  return {
    async list(args: ActivityListArgs = {}): Promise<ActivityPage> {
      const limit = clampLimit(args.limit);
      const conditions: Where[] = [];
      if (args.collection) conditions.push(eq("collection", args.collection));
      if (args.documentId) conditions.push(eq("document_id", args.documentId));
      if (args.actorId) conditions.push(eq("actor_id", args.actorId));
      if (args.action) conditions.push(eq("action", args.action));
      if (args.source) conditions.push(eq("source", args.source));
      // Strictly less than: the cursor is the last row of the previous page,
      // and the previous page already had it.
      if (args.cursor) conditions.push(lt("id", args.cursor));

      const adapter = await options.database();
      const rows = await adapter.transaction((tx) =>
        adapter.query(tx, {
          table: activityTable,
          ...(conditions.length === 0 ? {} : { where: and(...conditions) }),
          orderBy: [{ path: "id", direction: "desc" }],
          limit: limit + 1,
        }),
      );

      const hasNextPage = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);

      return {
        entries: page.map(toEntry),
        limit,
        hasNextPage,
        cursor: hasNextPage && last ? String(last.id) : null,
      };
    },
  };
}

function toEntry(row: Row): ActivityEntry {
  const changes =
    row.changes === null || row.changes === undefined
      ? null
      : (asObject(row.changes) as JsonObject);

  return {
    id: String(row.id),
    action: String(row.action),
    actorId: nullableString(row.actor_id),
    actorSource: nullableString(row.actor_source) as ActorSource | null,
    source: nullableString(row.source) as OperationSource | null,
    collection: nullableString(row.collection),
    documentId: nullableString(row.document_id),
    locale: nullableString(row.locale),
    changes,
    ip: nullableString(row.ip),
    createdAt: toIso(row.created_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CmsError(`limit must be a positive integer, received ${limit}`, {
      status: 400,
      code: "invalid_pagination",
    });
  }
  return Math.min(limit, maxLimit);
}
