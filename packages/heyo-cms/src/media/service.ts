import { permits } from "../access/permissions";
import { asObject, toIso } from "../engine/documents";
import { cursorWhere, encodeCursor } from "../engine/cursor";
import type { BufferedEvent, OutboxEntryMeta } from "../engine/outbox";
import { scopedDb } from "../engine/scoped-db";
import { CmsError } from "../errors";
import { createId } from "../ids";
import { and, eq, like, orderBy } from "../query";
import { streamOf, toBytes } from "../storage/bytes";
import type { Actor } from "../types/actor";
import type { ResolvedCmsConfig, UploadsConfig } from "../types/config";
import type { DatabaseAdapter } from "../types/database";
import type { ScopedDb } from "../types/hooks";
import type { JsonObject } from "../types/json";
import type {
  CmsMedia,
  FocalPoint,
  MediaCollectArgs,
  MediaCollectReport,
  MediaDeleteArgs,
  MediaDocument,
  MediaKeepArgs,
  MediaListArgs,
  MediaListResult,
  MediaUpdateArgs,
  MediaUploadArgs,
  MediaUsage,
  MediaVariantArgs,
  MediaVariantResult,
} from "../types/media";
import type { Row, Tx, Where } from "../types/query";
import type { StorageAdapter } from "../types/storage";
import { mediaJson, reservedMetadata, toMediaDocument } from "./document";
import { collectMedia, storageKeysOf, type MediaGcContext } from "./gc";
import { matchesMime, prepareUpload, sanitiseFilename } from "./pipeline";
import { mediaTable, mediaUsagesTable } from "./usages";
import {
  renderVariant,
  variantContentType,
  variantKey,
  variantNames,
  variantQuery,
  variantTransform,
} from "./variants";

const defaultLimit = 25;
const maxLimit = 200;
const listOrder = [orderBy("created_at", "desc"), orderBy("id", "desc")];

export interface MediaServiceOptions {
  config: ResolvedCmsConfig;
  database: () => Promise<DatabaseAdapter>;
  /** Appends events to the outbox inside the caller's transaction. */
  emit: (
    tx: Tx,
    events: BufferedEvent[],
    meta: OutboxEntryMeta,
  ) => Promise<void>;
  /** Schedules delivery once the transaction has committed. */
  deliver: () => void;
}

/**
 * `cms.media`.
 *
 * Media is a high-level setting rather than a plugin (section 3), and a file
 * is not a document: it has a lifecycle no document has — active, orphaned,
 * collected — and a body that lives somewhere the database cannot see. Hence
 * its own service, with the same rule as `cms.api`: everything is a method
 * rather than a route, so the REST endpoints in stage 7, the panel in stage 8
 * and a seed script all get identical behaviour, including the parts that are
 * easy to get wrong.
 */
export function createMedia(options: MediaServiceOptions): CmsMedia {
  const { config } = options;
  let adapter: Promise<StorageAdapter> | undefined;

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  const uploads = (): UploadsConfig => {
    if (!config.uploads) {
      throw new CmsError(
        "This CMS has no uploads configured; add an `uploads` section with a storage adapter.",
        { status: 501, code: "uploads_not_configured" },
      );
    }
    return config.uploads;
  };

  const storage = (): Promise<StorageAdapter> => {
    // Built on first use, once: an adapter is a connection pool or a signing
    // context, and two of them is two of everything underneath.
    adapter ??= Promise.resolve(
      typeof uploads().storage === "function"
        ? (uploads().storage as () => StorageAdapter)()
        : (uploads().storage as StorageAdapter),
    );
    return adapter;
  };

  async function run<T>(fn: (tx: Tx, db: ScopedDb) => Promise<T>): Promise<T> {
    const database = await options.database();
    return database.transaction((tx) => fn(tx, scopedDb(database, tx)));
  }

  const gc: MediaGcContext = {
    config,
    database: options.database,
    storage,
    emit: options.emit,
    deliver: options.deliver,
  };

  /**
   * Who may change the library.
   *
   * Writes are governed, reads are not. A file's URL is public the moment it
   * is on a page — that is what a bucket is for — so gating `get` would break
   * every anonymous render while protecting nothing that a private bucket and
   * a signed URL do not already protect.
   */
  const assertAllowed = (actor: Actor | null, action: string): void => {
    if (!config.rbac) return;
    if (permits(actor, `media:${action}`)) return;
    throw actor
      ? CmsError.forbidden(
          `Not allowed to ${action} media; the "media:${action}" permission is required`,
        )
      : CmsError.unauthorized(`Not allowed to ${action} media`);
  };

  const emit = async (
    tx: Tx,
    type: string,
    media: MediaDocument,
    actor: Actor | null,
    extra: JsonObject = {},
  ): Promise<void> => {
    await options.emit(
      tx,
      [{ type, data: { media: mediaJson(media), ...extra }, previous: null }],
      { actor, collection: "media", documentId: media.id },
    );
  };

  const load = async (db: ScopedDb, id: string): Promise<Row> => {
    const row = await db.findOne(mediaTable, eq("id", id));
    if (!row) throw CmsError.notFound(`No media with id "${id}"`);
    return row;
  };

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  async function upload(args: MediaUploadArgs): Promise<MediaDocument> {
    const settings = uploads();
    const actor = args.actor ?? null;
    assertAllowed(actor, "create");

    const bytes = await toBytes(args.file as Parameters<typeof toBytes>[0]);
    const prepared = await prepareUpload({
      bytes,
      filename: args.filename ?? nameOf(args.file) ?? "file",
      contentType:
        args.contentType ?? typeOf(args.file) ?? "application/octet-stream",
      uploads: settings,
    });

    const id = createId("med");
    const store = await storage();
    const key = storageKeyFor(store, id, prepared.filename, prepared.extension);

    // Bytes first, row second. The other order would leave a record pointing
    // at a file that does not exist, which breaks every page that renders it;
    // this order can only leak an object, and the compensation below removes
    // even that.
    await store.put(key, prepared.data, {
      contentType: prepared.contentType,
      size: prepared.data.byteLength,
      // Immutable because the key carries the id: the bytes under it never
      // change, and replacing an image is uploading a new one.
      cacheControl: "public, max-age=31536000, immutable",
    });

    const now = new Date();
    let uploaded: MediaDocument;
    try {
      uploaded = await run(async (tx, db) => {
        const row = await db.insert(mediaTable, {
          id,
          filename: prepared.filename,
          mime_type: prepared.contentType,
          size: prepared.data.byteLength,
          width: prepared.info?.width ?? null,
          height: prepared.info?.height ?? null,
          storage_key: key,
          checksum: prepared.checksum,
          alt: normaliseAlt(args.alt, args.locale ?? config.i18n.defaultLocale),
          focal_x: null,
          focal_y: null,
          // Active, although nothing references it yet. A file that orphaned
          // itself before the editor had finished writing the document around
          // it would arrive with a deadline already attached; the reference
          // count only starts to mean anything once a document has pointed at
          // it at least once.
          status: "active",
          orphaned_at: null,
          purge_after: null,
          purge_error: null,
          metadata: { ...(args.metadata ?? {}) },
          created_by: actor?.id ?? null,
          created_at: now,
          updated_at: now,
        });
        const media = toMediaDocument(row, store);
        await emit(tx, "media.uploaded", media, actor);
        return media;
      });
    } catch (error) {
      // The bytes are in the bucket and the row that would have pointed at
      // them does not exist, so nothing will ever find them again.
      await store.delete([key]).catch(() => undefined);
      throw error;
    }
    options.deliver();

    if (settings.images?.variants?.mode === "pregenerate") {
      return pregenerate(uploaded, actor);
    }
    return uploaded;
  }

  /**
   * Renders every declared size at upload time.
   *
   * A failure here does not fail the upload: the file is stored and usable,
   * and a missing size is rendered on first request like any other. It does
   * emit `media.processing.failed`, because somebody has to be able to notice
   * that a bucket has started refusing writes.
   */
  async function pregenerate(
    media: MediaDocument,
    actor: Actor | null,
  ): Promise<MediaDocument> {
    for (const name of variantNames(uploads().images)) {
      try {
        const result = await variant({ id: media.id, variant: name });
        if (result) await drain(result.body);
      } catch (error) {
        await run((tx) =>
          options.emit(
            tx,
            [
              {
                type: "media.processing.failed",
                data: {
                  media: mediaJson(media),
                  variant: name,
                  error: error instanceof Error ? error.message : String(error),
                },
                previous: null,
              },
            ],
            { actor, collection: "media", documentId: media.id },
          ),
        );
        options.deliver();
      }
    }
    return (await get(media.id)) ?? media;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async function list(args: MediaListArgs = {}): Promise<MediaListResult> {
    const limit = clampLimit(args.limit);
    const conditions: Where[] = [];
    if (args.status) conditions.push(eq("status", args.status));
    if (args.search) {
      conditions.push(like("filename", `%${args.search}%`, true));
    }
    // A concrete type is narrowed in the database; `image/*` is filtered
    // after the fact, because the query AST has no prefix match on a column
    // and inventing one for this would mean inventing it on three engines.
    const wildcard = args.mimeType?.includes("*") === true ? args.mimeType : null; // prettier-ignore
    if (args.mimeType && !wildcard) conditions.push(eq("mime_type", args.mimeType)); // prettier-ignore

    const base = conditions.length > 0 ? and(...conditions) : undefined;
    const database = await options.database();
    const rows = await database.transaction((tx) =>
      database.query(tx, {
        table: mediaTable,
        ...(args.cursor
          ? {
              where: and(
                ...(base ? [base] : []),
                cursorWhere(args.cursor, listOrder),
              ),
            }
          : base === undefined
            ? {}
            : { where: base }),
        orderBy: listOrder,
        limit: limit + 1,
      }),
    );

    const matched = wildcard
      ? rows.filter((row) => matchesMime(String(row.mime_type), wildcard))
      : rows;
    const hasNextPage = matched.length > limit;
    const page = matched.slice(0, limit);
    const store = await storage();
    const last = page.at(-1);

    return {
      docs: page.map((row) => toMediaDocument(row, store)),
      limit,
      hasNextPage,
      cursor: last ? encodeCursor(last, listOrder) : null,
    };
  }

  async function get(id: string): Promise<MediaDocument | null> {
    const row = await run((_tx, db) => db.findOne(mediaTable, eq("id", id)));
    return row ? toMediaDocument(row, await storage()) : null;
  }

  async function usages(id: string): Promise<MediaUsage[]> {
    const rows = await run((_tx, db) =>
      db.find(mediaUsagesTable, eq("media_id", id)),
    );
    return rows.map((row) => ({
      mediaId: String(row.media_id),
      collection: String(row.collection),
      documentId: String(row.document_id),
      field: String(row.field),
      locale: String(row.locale ?? ""),
      createdAt: toIso(row.created_at),
    }));
  }

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------

  async function update(args: MediaUpdateArgs): Promise<MediaDocument> {
    const settings = uploads();
    const actor = args.actor ?? null;
    assertAllowed(actor, "update");
    assertUpdatable(settings, args);

    const store = await storage();
    const { media, stale } = await run(async (tx, db) => {
      const row = await load(db, args.id);
      const before = toMediaDocument(row, store);

      // Every stored size was rendered from the old crop and the old focal
      // point, so keeping them would serve a thumbnail of the wrong part of
      // the picture until somebody happened to notice.
      const recrop =
        (args.crop !== undefined && !same(args.crop, before.crop)) ||
        (args.focalPoint !== undefined && !same(args.focalPoint, before.focalPoint)); // prettier-ignore
      const obsolete = recrop ? before.variants : [];

      const next: Row = { updated_at: new Date() };
      if (args.filename !== undefined) {
        next.filename = sanitiseFilename(args.filename);
      }
      if (args.alt !== undefined) {
        next.alt = mergeAlt(
          before.alt,
          args.alt,
          args.locale ?? config.i18n.defaultLocale,
        );
      }
      if (args.focalPoint !== undefined) {
        next.focal_x = args.focalPoint?.x ?? null;
        next.focal_y = args.focalPoint?.y ?? null;
      }

      const metadata: JsonObject = {
        ...asObject(row.metadata),
        ...(args.metadata ?? {}),
      };
      if (args.crop === null) delete metadata.crop;
      else if (args.crop !== undefined) metadata.crop = { ...args.crop };
      if (obsolete.length > 0) delete metadata.variants;
      next.metadata = metadata;

      await db.update(mediaTable, eq("id", args.id), next);
      const updated = toMediaDocument({ ...row, ...next }, store);
      await emit(tx, "media.updated", updated, actor);

      const contentType = variantContentType(settings.images, updated.mimeType);
      return {
        media: updated,
        stale: obsolete.map((name) =>
          variantKey(updated.storageKey, name, contentType),
        ),
      };
    });

    // After the commit: a rolled back rename must not have deleted anything,
    // and a stale variant that survives is corrected on the next request.
    if (stale.length > 0) await store.delete(stale).catch(() => undefined);
    options.deliver();
    return media;
  }

  async function keep(args: MediaKeepArgs): Promise<MediaDocument> {
    const actor = args.actor ?? null;
    assertAllowed(actor, "update");

    const media = await run(async (tx, db) => {
      const row = await load(db, args.id);
      if (String(row.status) === "active") {
        throw CmsError.conflict(
          `"${args.id}" is in use; only an unused file has a deadline to clear`,
        );
      }
      const next: Row = {
        // Still orphaned, because it is still unused — it simply has no
        // deadline any more. Calling it active would be a claim the next save
        // of any document would contradict.
        purge_after: null,
        purge_error: null,
        updated_at: new Date(),
      };
      await db.update(mediaTable, eq("id", args.id), next);
      const updated = toMediaDocument({ ...row, ...next }, await storage());
      await emit(tx, "media.updated", updated, actor, { kept: true });
      return updated;
    });
    options.deliver();
    return media;
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  async function remove(args: MediaDeleteArgs): Promise<MediaDocument> {
    const actor = args.actor ?? null;
    assertAllowed(actor, "delete");
    const store = await storage();

    const { media, keys } = await run(async (tx, db) => {
      const row = await load(db, args.id);
      const current = toMediaDocument(row, store);

      if (args.force !== true) {
        const used = await db.find(mediaUsagesTable, eq("media_id", args.id));
        if (used.length > 0) {
          // "Delete" in a media library is routinely clicked on the picture
          // that is on the front page right now. Naming the documents is the
          // difference between a refusal and a mystery.
          const where = used
            .slice(0, 3)
            .map(
              (usage) =>
                `${String(usage.collection)}/${String(usage.document_id)}`,
            ) // prettier-ignore
            .join(", ");
          throw CmsError.conflict(
            `"${current.filename}" is used by ${used.length} document${used.length === 1 ? "" : "s"} (${where}); pass force to delete it anyway`,
          );
        }
      }

      await db.delete(mediaUsagesTable, eq("media_id", args.id));
      await db.delete(mediaTable, eq("id", args.id));
      await emit(tx, "media.purged", current, actor);
      return { media: current, keys: storageKeysOf(current, config.uploads) };
    });

    await store.delete(keys);
    options.deliver();
    return media;
  }

  // -------------------------------------------------------------------------
  // Variants
  // -------------------------------------------------------------------------

  async function variant(
    args: MediaVariantArgs,
  ): Promise<MediaVariantResult | null> {
    const settings = uploads();
    const store = await storage();
    const row = await run((_tx, db) => db.findOne(mediaTable, eq("id", args.id))); // prettier-ignore
    if (!row) return null;
    const media = toMediaDocument(row, store);

    if (!args.variant) return original(store, media, null);

    const processor = settings.images?.processor;
    if (!processor || !processor.supports(media.mimeType)) {
      // Nothing here can resize, which is a legitimate deployment rather than
      // a misconfiguration: the original is served and its URL carries the
      // size the edge should render it at — the `cdn-worker` arrangement from
      // section 6. It is also the right answer for an SVG, which already
      // scales.
      const query = variantQuery(settings.images, args.variant);
      return original(store, media, args.variant, query);
    }

    const contentType = variantContentType(settings.images, media.mimeType);
    const key = variantKey(media.storageKey, args.variant, contentType);

    if (args.refresh !== true) {
      const stored = await store.get(key);
      if (stored) {
        const info = await store.head?.(key);
        return {
          media,
          variant: args.variant,
          key,
          contentType: info?.contentType ?? contentType,
          width: null,
          height: null,
          size: info?.size ?? null,
          body: stored,
          url: await publicUrl(store, key),
          cached: true,
        };
      }
    }

    const source = await store.get(media.storageKey);
    if (!source) return null;
    const rendered = await renderVariant(
      processor,
      await toBytes(source),
      variantTransform(settings.images, args.variant, media),
      media,
    );
    if (!rendered) return original(store, media, args.variant);

    // Written into storage, not just returned. That is the whole difference
    // between on-demand variants and resizing on every request: the second
    // caller gets a storage hit, and a size added to the configuration next
    // year applies to the entire archive.
    await store.put(key, rendered.data, {
      contentType: rendered.contentType,
      size: rendered.data.byteLength,
      cacheControl: "public, max-age=31536000, immutable",
    });
    await recordVariant(media.id, args.variant);

    return {
      media,
      variant: args.variant,
      key,
      contentType: rendered.contentType,
      width: rendered.width,
      height: rendered.height,
      size: rendered.data.byteLength,
      body: streamOf(rendered.data),
      url: await publicUrl(store, key),
      cached: false,
    };
  }

  async function original(
    store: StorageAdapter,
    media: MediaDocument,
    name: string | null,
    query = "",
  ): Promise<MediaVariantResult | null> {
    const body = await store.get(media.storageKey);
    if (!body) return null;
    const url = await publicUrl(store, media.storageKey);
    return {
      media,
      variant: name,
      key: media.storageKey,
      contentType: media.mimeType,
      width: media.width,
      height: media.height,
      size: media.size,
      body,
      url: query ? `${url}?${query}` : url,
      // The original is always a stored object; a named size answered with it
      // was not rendered, and saying so is how a caller can tell the two
      // deployments apart.
      cached: name === null,
    };
  }

  /** Remembers that a size exists, so a delete can find it again. */
  async function recordVariant(id: string, name: string): Promise<void> {
    await run(async (_tx, db) => {
      const row = await db.findOne(mediaTable, eq("id", id));
      if (!row) return;
      const metadata = asObject(row.metadata);
      const existing = Array.isArray(metadata.variants)
        ? metadata.variants.filter((entry): entry is string => typeof entry === "string") // prettier-ignore
        : [];
      if (existing.includes(name)) return;
      await db.update(mediaTable, eq("id", id), {
        metadata: { ...metadata, variants: [...existing, name].sort() },
      });
    });
  }

  function collect(args?: MediaCollectArgs): Promise<MediaCollectReport> {
    return collectMedia(gc, args);
  }

  return {
    upload,
    list,
    get,
    update,
    delete: remove,
    keep,
    usages,
    variant,
    collect,
    storage,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertUpdatable(settings: UploadsConfig, args: MediaUpdateArgs): void {
  for (const key of Object.keys(args.metadata ?? {})) {
    if ((reservedMetadata as readonly string[]).includes(key)) {
      throw CmsError.validation(
        `"${key}" is reserved inside media metadata; it is maintained by the engine`,
      );
    }
  }
  if (args.focalPoint !== undefined && settings.images?.focalPoint !== true) {
    throw CmsError.validation(
      "Focal points are off; set uploads.images.focalPoint to true",
    );
  }
  if (args.crop !== undefined && settings.images?.crop !== true) {
    throw CmsError.validation("Cropping is off; set uploads.images.crop to true"); // prettier-ignore
  }
  if (args.focalPoint && !isUnitPoint(args.focalPoint)) {
    throw CmsError.validation(
      "A focal point is relative: x and y are between 0 and 1",
    );
  }
}

/**
 * Where a new file goes.
 *
 * The id is in the key and the key never changes, which is what lets every
 * object be cached forever. The adapter chooses the prefix, because the
 * layout belongs to the bucket and to whatever lifecycle rules it carries.
 */
function storageKeyFor(
  storage: StorageAdapter,
  id: string,
  filename: string,
  extension: string,
): string {
  const prefix =
    storage.prefix?.({ id, filename }) ?? String(new Date().getUTCFullYear());
  const cleaned = prefix.replace(/^\/+|\/+$/g, "");
  return cleaned ? `${cleaned}/${id}.${extension}` : `${id}.${extension}`;
}

async function publicUrl(
  storage: StorageAdapter,
  key: string,
): Promise<string> {
  // A private bucket answers the plain URL with 403, so a signed one is the
  // only useful answer at the moment something is actually being served.
  return storage.signedUrl ? storage.signedUrl(key) : storage.url(key);
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

function normaliseAlt(
  alt: string | Record<string, string> | undefined,
  locale: string,
): JsonObject {
  if (alt === undefined) return {};
  return typeof alt === "string" ? { [locale]: alt } : { ...alt };
}

function mergeAlt(
  current: Record<string, string>,
  alt: string | Record<string, string>,
  locale: string,
): JsonObject {
  // A string writes one language; an object replaces the map. Merging an
  // object too would make "drop the German alt text" impossible to express.
  return typeof alt === "string" ? { ...current, [locale]: alt } : { ...alt };
}

function isUnitPoint(point: FocalPoint): boolean {
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

function nameOf(file: unknown): string | undefined {
  const name = (file as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function typeOf(file: unknown): string | undefined {
  const type = (file as { type?: unknown }).type;
  return typeof type === "string" && type.length > 0 ? type : undefined;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Consumes a stream nobody will read, so the transport can close it. */
async function drain(body: ReadableStream): Promise<void> {
  const reader = body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}
