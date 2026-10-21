import { createId } from "../ids";
import { and, eq, inList, ne } from "../query";
import type { ResolvedCollection } from "../types/config";
import type { ScopedDb } from "../types/hooks";
import type { JsonObject, JsonValue } from "../types/json";
import type { RetentionConfig } from "../types/config";
import { parseDuration } from "../duration";

export const mediaTable = "media";
export const mediaUsagesTable = "media_usages";

/**
 * The attribute a rich-text node uses to point at a file.
 *
 * A convention rather than a node type, so a custom editor node registered in
 * stage 9 participates in reference counting for free: if it carries
 * `mediaId`, the file it shows is counted as used.
 */
export const richTextMediaAttribute = "mediaId";

export interface MediaReference {
  mediaId: string;
  field: string;
  /** Empty for a field that is not localized. */
  locale: string;
}

/**
 * Whether a collection can point at a file at all.
 *
 * Checked once per collection and cached by the caller: the alternative is
 * three extra queries on every write to a collection that has no images,
 * which is most of them.
 */
export function referencesMedia(collection: ResolvedCollection): boolean {
  return Object.values(collection.fields).some(
    (field) =>
      field.type === "media" ||
      field.type === "richText" ||
      field.relationTo === "media",
  );
}

/**
 * Every file this document body points at.
 *
 * Read from the stored body rather than from the resolved document, because
 * references exist per locale: a German translation that drops an image has
 * not stopped the English one from using it, and counting only the locale of
 * the current request would orphan a file that is on a live page.
 */
export function collectMediaReferences(
  collection: ResolvedCollection,
  stored: JsonObject,
): MediaReference[] {
  const references = new Map<string, MediaReference>();

  const add = (mediaId: string, field: string, locale: string): void => {
    if (!mediaId) return;
    references.set(`${mediaId}|${field}|${locale}`, { mediaId, field, locale });
  };

  for (const [name, field] of Object.entries(collection.fields)) {
    const isMedia = field.type === "media" || field.relationTo === "media";
    const isRichText = field.type === "richText";
    if (!isMedia && !isRichText) continue;

    for (const [locale, value] of localeValues(stored[name], field.localized)) {
      if (isMedia) {
        for (const id of idsOf(value)) add(id, name, locale);
        continue;
      }
      for (const id of richTextMedia(value)) add(id, name, locale);
    }
  }

  return [...references.values()];
}

export interface SyncMediaUsagesOptions {
  db: ScopedDb;
  collection: string;
  documentId: string;
  /** `null` releases every reference this document held, for a purge. */
  references: MediaReference[] | null;
  /**
   * Whether the orphan and reclaim rules apply.
   *
   * False when the configuration has no `uploads` section: the usage rows
   * still have to be kept straight, because the trash and the purge depend on
   * them, but there is no storage behind them to collect.
   */
  lifecycle: boolean;
  retention: RetentionConfig | undefined;
  now: Date;
}

export interface SyncMediaUsagesResult {
  orphaned: string[];
  reclaimed: string[];
}

/**
 * Brings `media_usages` in line with what a document now contains.
 *
 * This is the mechanism the whole of section 6 rests on. Nothing counts
 * references at read time or at delete time; the count is maintained at the
 * one moment the truth changes, inside the transaction that changed it, so a
 * rolled back save cannot leave a file looking unused.
 */
export async function syncMediaUsages(
  options: SyncMediaUsagesOptions,
): Promise<SyncMediaUsagesResult> {
  const { db, documentId } = options;

  const existing = await db.find(mediaUsagesTable, eq("document_id", documentId)); // prettier-ignore
  const wanted = new Map(
    (options.references ?? []).map((reference) => [
      `${reference.mediaId}|${reference.field}|${reference.locale}`,
      reference,
    ]),
  );

  const removedIds = new Set<string>();
  const staleRows: string[] = [];
  for (const row of existing) {
    const key = `${String(row.media_id)}|${String(row.field)}|${String(row.locale ?? "")}`; // prettier-ignore
    if (wanted.delete(key)) continue;
    staleRows.push(String(row.id));
    removedIds.add(String(row.media_id));
  }

  if (staleRows.length > 0) {
    await db.delete(mediaUsagesTable, inList("id", staleRows));
  }

  const addedIds = new Set<string>();
  for (const reference of wanted.values()) {
    addedIds.add(reference.mediaId);
    await db.insert(mediaUsagesTable, {
      id: createId("mus"),
      media_id: reference.mediaId,
      collection: options.collection,
      document_id: documentId,
      field: reference.field,
      locale: reference.locale,
      created_at: options.now,
    });
  }

  if (!options.lifecycle) return { orphaned: [], reclaimed: [] };

  return {
    orphaned: await orphanUnreferenced(options, [...removedIds]),
    reclaimed: await reclaim(options, [...addedIds]),
  };
}

/**
 * Marks the files that just lost their last reference.
 *
 * The file is not deleted and not even moved: it keeps serving from exactly
 * the same URL until `purgeAfter`, which is what makes an accidental delete
 * or a reverted edit cost nothing. `orphanAfterUnreferenced: false` turns the
 * whole thing off and keeps every file active forever.
 */
async function orphanUnreferenced(
  options: SyncMediaUsagesOptions,
  candidates: string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  if (options.retention?.orphanAfterUnreferenced === false) return [];

  const orphaned: string[] = [];
  for (const mediaId of candidates) {
    const remaining = await options.db.find(
      mediaUsagesTable,
      eq("media_id", mediaId),
    );
    if (remaining.length > 0) continue;

    // Only an active file becomes an orphan: one that is already orphaned
    // keeps its original deadline, so repeatedly saving a document cannot
    // push a file's deletion indefinitely into the future.
    const changed = await options.db.update(
      mediaTable,
      and(eq("id", mediaId), eq("status", "active")),
      {
        status: "orphaned",
        orphaned_at: options.now,
        purge_after: purgeDeadline(options.retention, options.now),
        updated_at: options.now,
      },
    );
    if (changed > 0) orphaned.push(mediaId);
  }
  return orphaned;
}

/** Using an orphan again brings it back, which is the point of the window. */
async function reclaim(
  options: SyncMediaUsagesOptions,
  candidates: string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  if (options.retention?.reclaimOnReference === false) return [];

  const reclaimed: string[] = [];
  for (const mediaId of candidates) {
    const changed = await options.db.update(
      mediaTable,
      and(eq("id", mediaId), ne("status", "active")),
      {
        status: "active",
        orphaned_at: null,
        purge_after: null,
        purge_error: null,
        updated_at: options.now,
      },
    );
    if (changed > 0) reclaimed.push(mediaId);
  }
  return reclaimed;
}

export function purgeDeadline(
  retention: RetentionConfig | undefined,
  now: Date,
): Date | null {
  const after = retention?.purgeAfter ?? "30d";
  if (after === false) return null;
  return new Date(now.getTime() + parseDuration(after));
}

/**
 * A stored value, split into the locales it holds.
 *
 * A localized field is an object keyed by locale; everything else is one
 * value under the empty locale. Usages record which one they came from, so a
 * panel can say "still used by the Polish version of this page".
 */
function localeValues(
  value: JsonValue | undefined,
  localized: boolean,
): [string, JsonValue | undefined][] {
  if (!localized) return [["", value]];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as JsonObject);
}

function idsOf(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

/**
 * Files referenced from inside a rich-text document.
 *
 * ProseMirror content is a tree of arbitrary depth and a custom node may put
 * its attributes anywhere, so this walks the whole structure rather than
 * assuming the shape TipTap's image node happens to have today.
 */
function richTextMedia(value: JsonValue | undefined): string[] {
  const found: string[] = [];
  const stack: JsonValue[] = [value ?? null];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current !== "object" || current === null) continue;

    for (const [key, entry] of Object.entries(current as JsonObject)) {
      if (key === richTextMediaAttribute && typeof entry === "string") {
        found.push(entry);
        continue;
      }
      if (entry !== null && typeof entry === "object") stack.push(entry);
    }
  }
  return found;
}
