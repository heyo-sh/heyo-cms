import { CmsError } from "../errors";
import { and, eq, exists, inList, or, orderBy } from "../query";
import { documentsTableName } from "../schema/snapshot";
import type { ResolvedCmsConfig, ResolvedCollection } from "../types/config";
import type { DatabaseAdapter } from "../types/database";
import type { Where } from "../types/query";
import type { TrashListArgs, TrashPage } from "../types/trash";
import { accessFilter } from "./access";
import { cursorWhere, encodeCursor } from "./cursor";
import { rowToDocument, toIso } from "./documents";
import { applyFieldReadAccess, hasFieldAccessRules } from "./field-access";
import { localeContext } from "./locales";

const defaultLimit = 25;
const maxLimit = 200;

/** Newest deletion first, with `id` as the tiebreaker every cursor needs. */
const order = [orderBy("deleted_at", "desc"), orderBy("id", "desc")];

export interface ListTrashedOptions {
  adapter: DatabaseAdapter;
  config: ResolvedCmsConfig;
  /** Collections and globals, by name. */
  collections: Record<string, ResolvedCollection>;
  args: TrashListArgs;
}

/**
 * The trash across collections.
 *
 * One query, not one per collection: the panel shows a single list ordered by
 * when things were deleted, and assembling that from per-collection pages
 * would page wrongly the moment two collections have entries.
 *
 * Access control is folded into the filter rather than applied afterwards —
 * the same rule as everywhere else (stage 4). Each collection contributes one
 * branch of an `OR`, carrying its own `read` filter; a collection the actor
 * may not read contributes nothing and is therefore invisible rather than
 * forbidden.
 */
export async function listTrashed(
  options: ListTrashedOptions,
): Promise<TrashPage> {
  const { adapter, config, collections, args } = options;
  const locale = localeContext(config, args);
  const actor = args.actor ?? null;
  const limit = clampLimit(args.limit);

  const requested = args.collection
    ? [requireCollection(collections, args.collection)]
    : Object.values(collections);

  const branches: Where[] = [];
  const bySlug = new Map<string, ResolvedCollection>();

  for (const collection of requested) {
    let granted: Where | undefined;
    try {
      granted = await accessFilter(collection, {
        actor,
        operation: "read",
        locale: locale.locale,
        rbac: config.rbac,
      });
    } catch (error) {
      // Asking for one collection and being refused is an error worth
      // reporting; being refused one of many while listing everything is just
      // a shorter list.
      if (args.collection) throw error;
      continue;
    }
    bySlug.set(collection.slug, collection);
    branches.push(
      granted
        ? and(eq("collection", collection.slug), granted)
        : eq("collection", collection.slug),
    );
  }

  if (branches.length === 0) {
    return { entries: [], limit, hasNextPage: false, cursor: null };
  }

  // All the branches collapse into one `IN` when none of them carries a
  // filter, which is the common case and the cheaper plan.
  const scope =
    branches.length === bySlug.size &&
    branches.every((branch) => branch.kind === "compare")
      ? inList("collection", [...bySlug.keys()])
      : or(...branches);

  const base = and(exists("deleted_at", true), scope);
  const rows = await adapter.transaction((tx) =>
    adapter.query(tx, {
      table: documentsTableName,
      where: args.cursor ? and(base, cursorWhere(args.cursor, order)) : base,
      orderBy: order,
      limit: limit + 1,
    }),
  );

  const hasNextPage = rows.length > limit;
  const page = rows.slice(0, limit);

  const entries = page.flatMap((row) => {
    const collection = bySlug.get(String(row.collection));
    if (!collection) return [];
    const document = rowToDocument(row, collection, locale);
    if (hasFieldAccessRules(collection)) {
      applyFieldReadAccess(document, collection, actor, locale.locale);
    }
    return [
      {
        collection: collection.name,
        id: String(row.id),
        deletedAt: toIso(row.deleted_at),
        purgeAfter: toIso(row.purge_after),
        document,
      },
    ];
  });

  const last = page.at(-1);
  return {
    entries,
    limit,
    hasNextPage,
    cursor: last ? encodeCursor(last, order) : null,
  };
}

function requireCollection(
  collections: Record<string, ResolvedCollection>,
  name: string,
): ResolvedCollection {
  const collection = collections[name];
  if (!collection) throw CmsError.notFound(`No collection named "${name}"`);
  return collection;
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
