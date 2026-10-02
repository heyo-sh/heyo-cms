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
}

export type StorageAdapterFactory = () =>
  StorageAdapter | Promise<StorageAdapter>;

export type StorageConfig = StorageAdapter | StorageAdapterFactory;
