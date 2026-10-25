import { asObject, toIso } from "../engine/documents";
import type { JsonObject, JsonValue } from "../types/json";
import type { CropRect, FocalPoint, MediaDocument, MediaStatus } from "../types/media"; // prettier-ignore
import type { Row } from "../types/query";
import type { StorageAdapter } from "../types/storage";
import { publicOriginalUrl } from "./urls";

/**
 * Metadata keys the engine owns.
 *
 * The crop rectangle and the list of rendered sizes live inside the `metadata`
 * column because they are per-file facts no index ever has to answer about,
 * and two more columns on a system table is two more migrations for every
 * deployment that will ever exist. They are hidden from
 * `MediaDocument.metadata` and refused on write, so "your metadata" stays
 * yours.
 */
export const reservedMetadata = ["crop", "variants"] as const;

/**
 * A `media` row as the rest of the world sees it.
 *
 * `url` is where the deployment serves the file: under `uploads.publicPath`
 * when there is one, otherwise the adapter's public URL. Never a signed one:
 * signing is cryptography, and making this asynchronous would charge every
 * list of twenty-five files twenty-five signatures for a feature most
 * deployments do not use. A private bucket signs at the moment of serving
 * instead, which is what `cms.media.variant()` returns.
 */
export function toMediaDocument(
  row: Row,
  storage: StorageAdapter,
  publicPath?: string,
): MediaDocument {
  const metadata = asObject(row.metadata);
  const { crop, variants, ...rest } = metadata;
  const key = String(row.storage_key);

  return {
    id: String(row.id),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    size: Number(row.size ?? 0),
    width: optionalNumber(row.width),
    height: optionalNumber(row.height),
    storageKey: key,
    checksum: optionalString(row.checksum),
    alt: toStringMap(row.alt),
    focalPoint: toFocalPoint(row.focal_x, row.focal_y),
    crop: toCrop(crop),
    status: toStatus(row.status),
    orphanedAt: toIso(row.orphaned_at),
    purgeAfter: toIso(row.purge_after),
    purgeError: optionalString(row.purge_error),
    metadata: rest,
    variants: Array.isArray(variants)
      ? variants.filter((entry): entry is string => typeof entry === "string")
      : [],
    createdBy: optionalString(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    url:
      publicOriginalUrl(publicPath, {
        id: String(row.id),
        filename: String(row.filename),
        mimeType: String(row.mime_type),
      }) ?? storage.url(key),
  };
}

/** The document as an event payload: plain JSON, no behaviour, no aliasing. */
export function mediaJson(media: MediaDocument): JsonObject {
  return JSON.parse(JSON.stringify(media)) as JsonObject;
}

function toStatus(value: unknown): MediaStatus {
  return value === "orphaned" || value === "purging" ? value : "active";
}

function toFocalPoint(x: unknown, y: unknown): FocalPoint | null {
  if (x === null || x === undefined) return null;
  if (y === null || y === undefined) return null;
  return { x: Number(x), y: Number(y) };
}

function toCrop(value: JsonValue | undefined): CropRect | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as JsonObject;
  const numbers = ["x", "y", "width", "height"].map((key) => Number(record[key])); // prettier-ignore
  if (numbers.some((entry) => Number.isNaN(entry))) return null;
  return {
    x: numbers[0] as number,
    y: numbers[1] as number,
    width: numbers[2] as number,
    height: numbers[3] as number,
  };
}

function toStringMap(value: unknown): Record<string, string> {
  const object = asObject(value as JsonValue);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
