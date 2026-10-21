import { and, eq, exists, lte, orderBy } from "../query";
import { scopedDb } from "../engine/scoped-db";
import type { JobDefinition } from "../engine/jobs";
import type { BufferedEvent, OutboxEntryMeta } from "../engine/outbox";
import type { ResolvedCmsConfig, UploadsConfig } from "../types/config";
import type { DatabaseAdapter } from "../types/database";
import type { ScopedDb } from "../types/hooks";
import type { JsonObject } from "../types/json";
import type {
  MediaCollectArgs,
  MediaCollectReport,
  MediaDocument,
} from "../types/media";
import type { Row, Tx } from "../types/query";
import type { StorageAdapter } from "../types/storage";
import { toMediaDocument } from "./document";
import { mediaTable, mediaUsagesTable } from "./usages";
import { variantContentType, variantKey, variantNames } from "./variants";

/**
 * `media-gc`: the only thing in the product that deletes a file.
 *
 * The deadline is a necessary condition and never a sufficient one. Every
 * candidate is checked for references again immediately before its bytes go,
 * because thirty days is long enough for somebody to have used the file again
 * — and the whole point of the orphan window is that using it again is allowed
 * to save it (section 6).
 */

/** How long a failed purge waits before the collector tries it again. */
const retryAfter = 86_400_000;
const defaultBatch = 100;

export interface MediaGcContext {
  config: ResolvedCmsConfig;
  database: () => Promise<DatabaseAdapter>;
  storage: () => Promise<StorageAdapter>;
  emit: (
    tx: Tx,
    events: BufferedEvent[],
    meta: OutboxEntryMeta,
  ) => Promise<void>;
  deliver: () => void;
}

/** Files whose grace period has run out, oldest obligation first. */
export async function dueMedia(
  context: MediaGcContext,
  now: Date,
  limit: number,
): Promise<Row[]> {
  // `purgeAfter: false` means files are never collected, so there is nothing
  // due rather than a shorter deadline to apply.
  if (context.config.uploads?.retention?.purgeAfter === false) return [];

  const database = await context.database();
  return database.transaction((tx) =>
    database.query(tx, {
      table: mediaTable,
      where: and(
        eq("status", "orphaned"),
        // `exists` as well as `lte`: a null deadline sorts below a date on
        // MongoDB, so without it every file somebody pressed "Keep" on would
        // be handed straight back to the collector.
        exists("purge_after", true),
        lte("purge_after", now),
      ),
      orderBy: [orderBy("purge_after", "asc"), orderBy("id", "asc")],
      limit,
    }),
  );
}

export async function collectMedia(
  context: MediaGcContext,
  args: MediaCollectArgs = {},
): Promise<MediaCollectReport> {
  const report: MediaCollectReport = {
    examined: 0,
    purged: 0,
    reclaimed: 0,
    failed: 0,
  };
  if (!context.config.uploads) return report;

  const now = args.now ?? new Date();
  const due = await dueMedia(context, now, args.limit ?? defaultBatch);

  for (const row of due) {
    report.examined += 1;
    try {
      const outcome = await collectOne(context, row, now);
      if (outcome === "purged") report.purged += 1;
      if (outcome === "reclaimed") report.reclaimed += 1;
    } catch {
      // Already recorded on the file itself, with the deadline pushed out so
      // a bucket that is refusing deletes is not hammered every minute.
      report.failed += 1;
    }
  }
  return report;
}

export type CollectOutcome = "purged" | "reclaimed" | "taken";

/**
 * Takes one file, or discovers it should not be taken.
 *
 * The status change is a conditional update — the same portable claim the
 * outbox and the scheduler use — so two collectors running at once cannot
 * both delete the same object, on any of the three engines and without a
 * lock.
 */
export async function collectOne(
  context: MediaGcContext,
  row: Row,
  now: Date,
): Promise<CollectOutcome> {
  const storage = await context.storage();
  const media = toMediaDocument(row, storage);

  const claimed = await transaction(context, async (tx, db) => {
    const used = await db.find(mediaUsagesTable, eq("media_id", media.id));

    if (used.length > 0) {
      const changed = await db.update(
        mediaTable,
        and(eq("id", media.id), eq("status", "orphaned")),
        {
          status: "active",
          orphaned_at: null,
          purge_after: null,
          purge_error: null,
          updated_at: now,
        },
      );
      if (changed === 0) return "taken" as const;
      await emitMedia(context, tx, "media.reclaimed", {
        ...media,
        status: "active",
        orphanedAt: null,
        purgeAfter: null,
      });
      return "reclaimed" as const;
    }

    const changed = await db.update(
      mediaTable,
      and(eq("id", media.id), eq("status", "orphaned")),
      { status: "purging", updated_at: now },
    );
    return changed === 1 ? ("claimed" as const) : ("taken" as const);
  });

  context.deliver();
  if (claimed !== "claimed") return claimed;

  try {
    await storage.delete(storageKeysOf(media, context.config.uploads));
    await transaction(context, async (tx, db) => {
      await db.delete(mediaUsagesTable, eq("media_id", media.id));
      await db.delete(mediaTable, eq("id", media.id));
      await emitMedia(context, tx, "media.purged", media, { collected: true });
    });
    context.deliver();
    return "purged";
  } catch (error) {
    await recordFailure(context, media, error, now);
    throw error;
  }
}

/**
 * The sweep, as the job registry sees it.
 *
 * Registered next to `scheduled-changes` and `trash-purge` rather than run on
 * a timer of its own: the deployment decides what calls `cms.jobs.run()`,
 * because the package does not know whether it is in a process that has
 * timers (stage 5).
 */
export function mediaGcJob(context: MediaGcContext): JobDefinition {
  return {
    name: "media-gc",
    failureType: "media.purge",
    failurePayload: (row) => ({
      mediaId: String(row.id),
      storageKey: String(row.storage_key),
      filename: String(row.filename),
    }),
    due: (_host, now, limit) => dueMedia(context, now, limit),
    run: async (_host, row) => {
      await collectOne(context, row, new Date());
    },
  };
}

/**
 * Every object this file owns: the original and every size rendered from it.
 *
 * The recorded list plus the declared one. A size removed from the
 * configuration still has objects in the bucket, and a size added since the
 * last render has none but costs nothing to ask about — and a leaked
 * derivative is a file nobody will ever find again.
 */
export function storageKeysOf(
  media: MediaDocument,
  uploads: UploadsConfig | undefined,
): string[] {
  const contentType = variantContentType(uploads?.images, media.mimeType);
  const names = new Set([...media.variants, ...variantNames(uploads?.images)]);
  return [
    media.storageKey,
    ...[...names].map((name) =>
      variantKey(media.storageKey, name, contentType),
    ),
  ];
}

async function recordFailure(
  context: MediaGcContext,
  media: MediaDocument,
  error: unknown,
  now: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await transaction(context, async (_tx, db) => {
    await db.update(mediaTable, eq("id", media.id), {
      // Back to orphaned with the deadline pushed out. Leaving it `purging`
      // would strand the file in a state nothing looks at, and retrying at
      // once would turn a transient permissions problem into a log fire.
      status: "orphaned",
      purge_after: new Date(now.getTime() + retryAfter),
      purge_error: message.slice(0, 1000),
      updated_at: now,
    });
  });
}

async function emitMedia(
  context: MediaGcContext,
  tx: Tx,
  type: string,
  media: MediaDocument,
  extra: JsonObject = {},
): Promise<void> {
  await context.emit(
    tx,
    [
      {
        type,
        data: { media: JSON.parse(JSON.stringify(media)) as JsonObject, ...extra }, // prettier-ignore
        previous: null,
      },
    ],
    { actor: null, collection: "media", documentId: media.id },
  );
}

async function transaction<T>(
  context: MediaGcContext,
  fn: (tx: Tx, db: ScopedDb) => Promise<T>,
): Promise<T> {
  const database = await context.database();
  return database.transaction((tx) => fn(tx, scopedDb(database, tx)));
}
