import { CmsError } from "../errors";
import type {
  ObjectMeta,
  StorageAdapter,
  StoredObject,
} from "../types/storage";
import { streamOf, toBytes } from "./bytes";

/**
 * The two adapters the engine itself needs.
 *
 * Memory so the storage contract suite has something to run against and so an
 * example boots without a bucket; local disk so a single-server deployment is
 * a directory rather than an account with a cloud provider.
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
      return streamOf(object.body);
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
  prefix?: (file: { id: string; filename: string }) => string;
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
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
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
        return streamOf(new Uint8Array(content));
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
