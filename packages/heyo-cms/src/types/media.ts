import type { Actor, OperationSource } from "./actor";
import type { JsonObject } from "./json";
import type { StorageAdapter } from "./storage";

/**
 * Where a file is in its life (section 6).
 *
 * `orphaned` is the state that makes the whole design work: a file that lost
 * its last reference stops being counted as used but keeps serving, so an
 * accidental delete or a reverted edit costs nothing for `retention.purgeAfter`.
 * `purging` is only ever seen by a collector that died mid-sweep.
 */
export type MediaStatus = "active" | "orphaned" | "purging";

/** Relative, `0..1`, origin top-left. Resolution-independent by construction. */
export interface FocalPoint {
  x: number;
  y: number;
}

/** A rectangle in the pixels of the stored original. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A file, as everything outside the engine sees it.
 *
 * `crop` and `variants` are stored inside the `metadata` column under those
 * two reserved keys and surfaced here, because a panel needs them and nobody
 * should have to know they share a column with user metadata.
 */
export interface MediaDocument {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  storageKey: string;
  checksum: string | null;
  /** Localized alternative text, keyed by locale like any content field. */
  alt: Record<string, string>;
  focalPoint: FocalPoint | null;
  crop: CropRect | null;
  status: MediaStatus;
  orphanedAt: string | null;
  /** When the collector will delete it. `null` means never. */
  purgeAfter: string | null;
  /** Why the last purge attempt failed, so it is not retried blindly. */
  purgeError: string | null;
  /** Everything except the two keys the engine reserves. */
  metadata: JsonObject;
  /** Named sizes that exist as stored objects right now. */
  variants: string[];
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** The public URL of the original, from the storage adapter. */
  url: string;
}

/** One place a document points at a file. */
export interface MediaUsage {
  mediaId: string;
  collection: string;
  documentId: string;
  field: string;
  /** Empty for a field that is not localized. */
  locale: string;
  createdAt: string | null;
}

/** One file used by one document, as `cms.media.forDocuments()` returns it. */
export interface MediaDocumentUsage {
  media: MediaDocument;
  field: string;
  /** Null for a field that is not localized: the file is used in every locale. */
  locale: string | null;
}

export interface MediaForDocumentsArgs {
  /** Only these documents. All of the collection's, by default. */
  ids?: readonly string[];
}

/** The fields of a file a URL is made of. A `MediaDocument` has them all. */
export type MediaUrlInput = Pick<
  MediaDocument,
  "id" | "filename" | "mimeType"
> &
  Partial<Pick<MediaDocument, "width" | "height" | "crop" | "focalPoint">>;

export type MediaImageInput = MediaUrlInput &
  Partial<Pick<MediaDocument, "alt">>;

export interface MediaUrlOptions {
  /** A name from `uploads.images.variants.sizes`; the original when omitted. */
  variant?: string;
}

export interface MediaSrcsetOptions {
  /**
   * The sizes to offer, by name. By default every declared size that keeps
   * the picture's shape: `inside` and `outside` fits, and one-sided boxes.
   */
  sizes?: string[];
}

export interface MediaImageOptions {
  /** One named size as the `src`, without a `srcset`: a thumbnail, a card. */
  variant?: string;
  /** The `sizes` attribute that goes with the `srcset`, e.g. `(min-width: 768px) 680px, 100vw`. */
  sizes?: string;
  /** The sizes the `srcset` offers; see `MediaSrcsetOptions.sizes`. */
  srcset?: string[];
  /** Which language of the library's alt text; the default locale otherwise. */
  locale?: string;
}

/** An `<img>`, as data. Every field maps to the attribute of the same name. */
export interface MediaImage {
  src: string;
  width: number | null;
  height: number | null;
  srcset: string | null;
  sizes: string | null;
  /** The library's alt text in the requested locale, or null when there is none. */
  alt: string | null;
}

export interface MediaRichTextOptions {
  /** `html` by default. */
  format?: "html" | "markdown" | "text";
  /** Which language of the library's alt text to fall back on. */
  locale?: string;
  /** The `sizes` attribute for every image's `srcset`. */
  sizes?: string;
  /**
   * `lazy` by default: images in prose are rarely what a reader sees first.
   * `eager` for a document whose first image is the largest thing on screen.
   */
  loading?: "lazy" | "eager";
}

/** What an upload may be handed. All of them end up as bytes. */
export type MediaSource =
  Blob | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

export interface MediaUploadArgs {
  file: MediaSource;
  /** Required unless `file` is a `File`, which already carries one. */
  filename?: string;
  /** Sniffed from the bytes when absent or when the client sent octet-stream. */
  contentType?: string;
  /** A string is stored under `locale`; an object is stored as given. */
  alt?: string | Record<string, string>;
  locale?: string;
  metadata?: JsonObject;
  actor?: Actor | null;
  source?: OperationSource;
}

export interface MediaListArgs {
  status?: MediaStatus;
  /** `image/*` style wildcards allowed. */
  mimeType?: string;
  /** Case-insensitive match on the filename. */
  search?: string;
  limit?: number;
  cursor?: string;
  actor?: Actor | null;
}

export interface MediaListResult {
  docs: MediaDocument[];
  limit: number;
  hasNextPage: boolean;
  cursor: string | null;
}

export interface MediaUpdateArgs {
  id: string;
  filename?: string;
  /** A string writes one locale; an object replaces the whole map. */
  alt?: string | Record<string, string>;
  locale?: string;
  /** `null` clears it. Requires `uploads.images.focalPoint`. */
  focalPoint?: FocalPoint | null;
  /** `null` clears it. Requires `uploads.images.crop`. */
  crop?: CropRect | null;
  /** Merged into the existing metadata; the reserved keys are refused. */
  metadata?: JsonObject;
  actor?: Actor | null;
  source?: OperationSource;
}

export interface MediaDeleteArgs {
  id: string;
  /**
   * Deletes a file that documents still point at.
   *
   * Without it a referenced file is refused, because "delete" in a media
   * library is routinely clicked on something that is on a page right now.
   */
  force?: boolean;
  actor?: Actor | null;
  source?: OperationSource;
}

export interface MediaKeepArgs {
  id: string;
  actor?: Actor | null;
  source?: OperationSource;
}

export interface MediaVariantArgs {
  id: string;
  /**
   * A name from `uploads.images.variants.sizes`. Omit for the original.
   *
   * Only declared names are accepted. Arbitrary dimensions in a URL are a way
   * to make a stranger fill a bucket and burn CPU, one pixel at a time.
   */
  variant?: string;
  /** Renders again even if a stored copy exists. */
  refresh?: boolean;
}

/**
 * One answer to "give me this file at this size".
 *
 * `cached` says whether the bytes came from storage or were rendered during
 * this call, which is what makes the on-demand pipeline observable instead of
 * a guess about CDN behaviour.
 */
export interface MediaVariantResult {
  media: MediaDocument;
  variant: string | null;
  key: string;
  contentType: string;
  width: number | null;
  height: number | null;
  size: number | null;
  body: ReadableStream;
  url: string;
  cached: boolean;
  /**
   * Why the named size could not be rendered, when it could not.
   *
   * The original is served in its place and nothing is stored, so the next
   * request tries again — the usual cause is a quota that resets, or a
   * service that comes back. Null whenever the answer is what was asked for.
   * An HTTP layer should not cache a fallback for long.
   */
  processingError: string | null;
}

export interface MediaCollectArgs {
  /** The moment the sweep runs as. Injectable so a test need not wait. */
  now?: Date;
  limit?: number;
}

export interface MediaCollectReport {
  examined: number;
  purged: number;
  /** Files that were used again between being orphaned and being collected. */
  reclaimed: number;
  failed: number;
}

/**
 * `cms.media`.
 *
 * Media is a high-level setting rather than a plugin (section 3), so it is a
 * first-class part of the instance: the same object the REST routes call in
 * stage 7 and the panel calls in stage 8, available without HTTP so a seed
 * script or a migration can upload a file.
 */
export interface CmsMedia {
  upload(args: MediaUploadArgs): Promise<MediaDocument>;
  list(args?: MediaListArgs): Promise<MediaListResult>;
  get(id: string): Promise<MediaDocument | null>;
  update(args: MediaUpdateArgs): Promise<MediaDocument>;
  /** Removes the record, the original and every stored variant. */
  delete(args: MediaDeleteArgs): Promise<MediaDocument>;
  /** The panel's "Keep" button: clears the purge deadline of an orphan. */
  keep(args: MediaKeepArgs): Promise<MediaDocument>;
  /** Where a file is used. Empty for an orphan, by definition. */
  usages(id: string): Promise<MediaUsage[]>;
  /** The original or a named size, rendering and storing it if needed. */
  variant(args: MediaVariantArgs): Promise<MediaVariantResult | null>;
  /** The `media-gc` sweep. Also registered in `cms.jobs`. */
  collect(args?: MediaCollectArgs): Promise<MediaCollectReport>;
  /** The configured adapter, built on first use. */
  storage(): Promise<StorageAdapter>;
  /**
   * Several files by id, in one query. Ids that do not exist are absent from
   * the map rather than an error: a page that references a deleted picture
   * should lose the picture, not the page.
   */
  getMany(ids: readonly string[]): Promise<Map<string, MediaDocument>>;
  /**
   * Every file a collection's documents use, per document — read from the
   * reference count the engine already keeps, so it costs two queries for
   * the whole collection instead of a parse of every document. What an
   * image sitemap is built from.
   */
  forDocuments(
    collection: string,
    args?: MediaForDocumentsArgs,
  ): Promise<Map<string, MediaDocumentUsage[]>>;
  /**
   * Where a file or one of its sizes is served. Synchronous: it is
   * arithmetic on the configuration and the record, never a storage call.
   * Uses `uploads.publicPath` when the deployment has one.
   */
  url(media: MediaUrlInput, options?: MediaUrlOptions): string;
  /** The declared sizes that keep the file's shape, as a `srcset`; null when there is no choice. */
  srcset(media: MediaUrlInput, options?: MediaSrcsetOptions): string | null;
  /** `src`, `srcset`, `width`, `height` and `alt` for an `<img>`. */
  image(media: MediaImageInput, options?: MediaImageOptions): MediaImage;
  /**
   * A rich-text value as HTML (or Markdown, or text), with every library
   * image resolved: its public URL, its dimensions, a `srcset` of the
   * declared sizes, lazy loading, and the library's alt text where the
   * editor left the node's empty. One query for all the images.
   */
  renderRichText(
    value: unknown,
    options?: MediaRichTextOptions,
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Image processing
// ---------------------------------------------------------------------------

export type ImageFormat =
  "jpeg" | "png" | "gif" | "webp" | "avif" | "svg" | "tiff";

/** What the built-in header parser can tell without decoding an image. */
export interface ImageInfo {
  format: ImageFormat;
  contentType: string;
  width: number;
  height: number;
}

/** One rendering request, in the vocabulary every image library shares. */
export interface ImageTransform {
  width?: number;
  height?: number;
  fit?: "cover" | "contain" | "inside" | "outside";
  /** Where `cover` should crop around. Relative, so it survives a resize. */
  position?: FocalPoint;
  /** Applied to the original pixels, before any resize. */
  crop?: CropRect;
  format?: "webp" | "avif" | "jpeg" | "png";
  quality?: number;
  stripMetadata?: boolean;
}

export interface ProcessedImage {
  data: Uint8Array;
  contentType: string;
  width: number;
  height: number;
}

/**
 * The pluggable renderer.
 *
 * Deliberately not built in. A codec is either a native module, which has no
 * place in a package that has to load in a Worker, or a service call, which
 * has no place in a package that has to run offline. Everything the engine can
 * do without one — reading dimensions, enforcing limits, stripping EXIF — it
 * does itself; everything that needs real pixels goes through here.
 */
export interface ImageProcessor {
  /** `sharp`, `cloudflare-images`. Printed by `cms.inspect()`. */
  readonly id: string;
  supports(contentType: string): boolean;
  transform(
    source: Uint8Array,
    transform: ImageTransform,
    info: ImageInfo,
  ): Promise<ProcessedImage>;
}
