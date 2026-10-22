import { CmsError } from "../errors";
import type {
  ObjectMeta,
  SignedUrlOptions,
  StorageAdapter,
  StoredObject,
} from "../types/storage";
import { toBytes } from "./bytes";

/**
 * The shape of every object store we reach over HTTP.
 *
 * S3, R2, GCS and Azure differ in how a request is signed and in where the
 * bucket name goes. They do not differ in what PUT, GET, DELETE and HEAD mean,
 * so that part is written once here and each adapter supplies the two
 * functions that are actually its own.
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SignableRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payload: Uint8Array | "UNSIGNED-PAYLOAD";
  contentLength: number;
}

export interface HttpStorageOptions {
  id: string;
  /** Where the bytes actually live, including credentials-bearing hosts. */
  endpoint(key: string): URL;
  sign(request: SignableRequest): Promise<Record<string, string>>;
  /** What a browser should be given; a CDN domain when one is configured. */
  publicUrl(key: string): string;
  /** Produces a time-limited URL. Absent when the adapter cannot sign one. */
  signedUrl?(key: string, options: SignedUrlOptions | undefined): Promise<string>; // prettier-ignore
  prefix?: (file: { id: string; filename: string }) => string;
  fetch?: FetchLike;
  /** Headers every request carries, such as a storage class or an ACL. */
  defaultHeaders?: Record<string, string>;
}

export function httpStorage(options: HttpStorageOptions): StorageAdapter {
  const call = options.fetch ?? ((...args: Parameters<FetchLike>) => fetch(...args)); // prettier-ignore

  const send = async (
    method: string,
    key: string,
    init: { body?: Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<Response> => {
    const url = options.endpoint(key);
    const body = init.body;
    const headers = await options.sign({
      method,
      url,
      headers: { ...options.defaultHeaders, ...init.headers },
      payload: body ?? new Uint8Array(0),
      contentLength: body?.byteLength ?? 0,
    });
    return call(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: body as unknown as BodyInit }),
    });
  };

  const fail = async (
    response: Response,
    action: string,
    key: string,
  ): Promise<never> => {
    // The provider's XML explains what a bare status code never does: wrong
    // region, expired credentials, a bucket policy. Truncated because some of
    // them answer with a page.
    const detail = (await response.text().catch(() => "")).slice(0, 512);
    throw new CmsError(
      `${options.id}: could not ${action} "${key}" (${response.status})${detail ? `: ${detail}` : ""}`,
      { status: 502, code: "storage_request_failed" },
    );
  };

  return {
    id: options.id,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),

    async put(key, body, meta: ObjectMeta) {
      const bytes = await toBytes(body);
      const response = await send("PUT", key, {
        body: bytes,
        headers: {
          "content-type": meta.contentType,
          "content-length": String(bytes.byteLength),
          ...(meta.cacheControl ? { "cache-control": meta.cacheControl } : {}),
          ...(meta.contentDisposition
            ? { "content-disposition": meta.contentDisposition }
            : {}),
          ...userMetadata(options.id, meta.metadata),
        },
      });
      if (!response.ok) await fail(response, "store", key);
    },

    async get(key) {
      const response = await send("GET", key);
      // A missing object is an answer, not a failure: the collector races
      // with reads, and a purge that lands between the two must not turn a
      // page request into a 500.
      if (response.status === 404) return null;
      if (!response.ok) await fail(response, "read", key);
      return response.body;
    },

    async delete(keys) {
      for (const key of keys) {
        const response = await send("DELETE", key);
        // 404 is success: the point of a delete is that the key is gone.
        if (!response.ok && response.status !== 404) {
          await fail(response, "delete", key);
        }
      }
    },

    url(key) {
      return options.publicUrl(key);
    },

    ...(options.signedUrl === undefined
      ? {}
      : { signedUrl: options.signedUrl.bind(options) }),

    async head(key): Promise<StoredObject | null> {
      const response = await send("HEAD", key);
      if (response.status === 404) return null;
      if (!response.ok) await fail(response, "stat", key);
      const modified = response.headers.get("last-modified");
      return {
        key,
        size: Number(response.headers.get("content-length") ?? 0),
        contentType:
          response.headers.get("content-type") ?? "application/octet-stream",
        ...(modified ? { lastModified: new Date(modified) } : {}),
      };
    },
  };
}

/** Provider-side user metadata, under whichever prefix the provider wants. */
function userMetadata(
  id: string,
  metadata: Record<string, string> | undefined,
): Record<string, string> {
  if (!metadata) return {};
  const prefix = id === "azure" ? "x-ms-meta-" : "x-amz-meta-";
  return Object.fromEntries(
    Object.entries(metadata).map(([name, value]) => [
      `${prefix}${name.toLowerCase()}`,
      value,
    ]),
  );
}

/**
 * Every segment encoded, slashes kept.
 *
 * Object keys are not URL paths: `a b/c.png` is one perfectly ordinary key and
 * has to survive the round trip to the same bytes it went in as.
 */
export function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
