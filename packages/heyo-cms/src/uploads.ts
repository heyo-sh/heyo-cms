import { parseDuration } from "./duration";
import { CmsConfigError, CmsError } from "./errors";
import type {
  ObjectMeta,
  SignedUrlOptions,
  StorageAdapter,
  StorageAdapterFactory,
  StoredObject,
} from "./types/storage";

/**
 * Storage lives behind four methods (section 2), so a bespoke adapter for an
 * in-house object store is an afternoon rather than a project. The two below
 * are the ones the engine itself needs: memory for tests, local disk for a
 * single-server deployment.
 */

interface MemoryObject {
  body: Uint8Array;
  meta: ObjectMeta;
  lastModified: Date;
}

export interface MemoryStorageOptions {
  baseUrl?: string;
}

/**
 * In-process storage.
 *
 * Exported rather than kept in the test folder on purpose: the storage
 * contract suite has to run against something, and an example that boots
 * without a bucket is worth more than a mock nobody else can use.
 */
export function memory(options: MemoryStorageOptions = {}): StorageAdapter {
  const objects = new Map<string, MemoryObject>();
  const baseUrl = (options.baseUrl ?? "memory://media").replace(/\/+$/, "");

  return {
    id: "memory",
    async put(key, body, meta) {
      objects.set(key, {
        body: await toBytes(body),
        meta,
        lastModified: new Date(),
      });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return new Blob([object.body as BlobPart]).stream();
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
    url(key) {
      return `${baseUrl}/${key}`;
    },
    async head(key): Promise<StoredObject | null> {
      const object = objects.get(key);
      if (!object) return null;
      return {
        key,
        size: object.body.byteLength,
        contentType: object.meta.contentType,
        lastModified: object.lastModified,
      };
    },
  };
}

export interface LocalStorageOptions {
  /** Directory on disk. Created on first write. */
  directory: string;
  /** Public prefix the files are served from. */
  baseUrl?: string;
}

/**
 * Local disk.
 *
 * `node:fs` is imported inside the methods, not at the top of the module: a
 * Worker bundle that merely configures storage must not drag a filesystem
 * into a runtime that has none.
 */
export function local(options: LocalStorageOptions): StorageAdapter {
  const baseUrl = (options.baseUrl ?? "/media").replace(/\/+$/, "");

  const resolvePath = async (key: string): Promise<string> => {
    const { join, normalize, resolve } = await import("node:path");
    const root = resolve(options.directory);
    const target = resolve(join(root, normalize(key)));
    // A key arriving from an upload must not be able to address a path
    // outside the storage root, whatever it contains.
    if (target !== root && !target.startsWith(`${root}/`)) {
      throw new CmsError(`Refusing to write outside the storage root: ${key}`, {
        status: 400,
        code: "invalid_storage_key",
      });
    }
    return target;
  };

  return {
    id: "local",
    async put(key, body) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const path = await resolvePath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await toBytes(body));
    },
    async get(key) {
      const { readFile } = await import("node:fs/promises");
      try {
        const content = await readFile(await resolvePath(key));
        return new Blob([content as unknown as BlobPart]).stream();
      } catch {
        return null;
      }
    },
    async delete(keys) {
      const { rm } = await import("node:fs/promises");
      for (const key of keys) {
        await rm(await resolvePath(key), { force: true });
      }
    },
    url(key) {
      return `${baseUrl}/${key}`;
    },
    async head(key): Promise<StoredObject | null> {
      const { stat } = await import("node:fs/promises");
      try {
        const info = await stat(await resolvePath(key));
        return {
          key,
          size: info.size,
          contentType: "application/octet-stream",
          lastModified: info.mtime,
        };
      } catch {
        return null;
      }
    },
  };
}

export interface S3StorageOptions {
  bucket: string;
  region?: string;
  /** Set for S3-compatible services: MinIO, Tigris, R2. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  acl?: "private" | "public-read";
  signedUrls?: { enabled: boolean; expiresIn?: string };
  prefix?: (file: { id: string; filename: string }) => string;
}

/**
 * S3 and S3-compatible storage.
 *
 * The options are validated here, now, because they belong to the frozen
 * configuration contract — a deployment should not discover a missing bucket
 * name at the first upload. The transport itself lands with the media
 * pipeline in stage 6, and until then building the adapter fails loudly
 * rather than silently dropping files.
 */
export function s3(options: S3StorageOptions): StorageAdapterFactory {
  if (!options.bucket) {
    throw new CmsConfigError("uploads.storage", "s3() needs a bucket");
  }
  if (!options.region && !options.endpoint) {
    throw new CmsConfigError(
      "uploads.storage",
      "s3() needs a region, or an endpoint for an S3-compatible service",
    );
  }
  if (options.signedUrls?.expiresIn) {
    parseDuration(options.signedUrls.expiresIn, "uploads.storage.signedUrls");
  }

  return () => {
    throw new CmsError(
      "The S3 storage adapter ships with the media pipeline in stage 6. " +
        "Use local() or memory() until then.",
      { status: 501, code: "storage_not_implemented" },
    );
  };
}

async function toBytes(body: ReadableStream | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value as Uint8Array);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export type { ObjectMeta, SignedUrlOptions, StorageAdapter, StoredObject };
