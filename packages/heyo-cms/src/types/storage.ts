/** Everything the storage layer records about an object it is given. */
export interface ObjectMeta {
  contentType: string;
  size?: number;
  cacheControl?: string;
  contentDisposition?: string;
  /** Provider-side user metadata. Never trusted for access decisions. */
  metadata?: Record<string, string>;
}

export interface SignedUrlOptions {
  /** Seconds, or a duration string such as `1h`. */
  expiresIn?: number | string;
  download?: boolean;
  filename?: string;
}

/** What `head()` reports for an object that exists. */
export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
  lastModified?: Date;
}

/**
 * The whole storage contract.
 *
 * Four required methods is the point: a bespoke adapter for an in-house object
 * store should be a short afternoon, not a project. `head` is optional because
 * media garbage collection can fall back to the size recorded in the database.
 */
export interface StorageAdapter {
  /** `local`, `s3`, `r2`, `gcs`, `azure`. Printed by `cms.inspect()`. */
  readonly id: string;
  put(
    key: string,
    body: ReadableStream | Uint8Array,
    meta: ObjectMeta,
  ): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(keys: string[]): Promise<void>;
  url(key: string, options?: SignedUrlOptions): string;
  head?(key: string): Promise<StoredObject | null>;
  /**
   * A time-limited URL for a bucket that is not public.
   *
   * Separate from `url()` and asynchronous because signing is cryptography:
   * making `url()` async instead would make the common case — a public file
   * on a CDN — pay for a feature it does not use, in every template that
   * renders an image.
   */
  signedUrl?(key: string, options?: SignedUrlOptions): Promise<string>;
  /**
   * Where new objects should live, given the file being stored.
   *
   * The adapter decides because the layout belongs to the bucket: a lifecycle
   * rule that archives `2024/` only works if the adapter that was configured
   * with it is the one choosing prefixes (section 6).
   */
  readonly prefix?: (file: { id: string; filename: string }) => string;
}

export type StorageAdapterFactory = () =>
  StorageAdapter | Promise<StorageAdapter>;

export type StorageConfig = StorageAdapter | StorageAdapterFactory;
