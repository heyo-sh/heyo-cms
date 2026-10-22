import type { FetchLike } from "../src/storage/http";

/**
 * An object store that answers HTTP, in memory.
 *
 * The four cloud adapters differ from `local()` in exactly two places —
 * how a request is signed and where the bucket name goes — and both of those
 * are only exercised by sending a real request. This is what the storage
 * contract suite sends them to, so `s3()`, `gcs()` and `azure()` are covered
 * by the same assertions as every other adapter instead of by inspection.
 *
 * It is deliberately strict about the parts that are easy to get wrong: a
 * request with no `authorization` header is refused, which is how a signer
 * that silently stopped signing would be caught.
 */
export interface FakeObjectStore {
  fetch: FetchLike;
  objects: Map<string, { body: Uint8Array; contentType: string }>;
  /** Every request, in order, for assertions about signing. */
  requests: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }[];
}

export function fakeObjectStore(): FakeObjectStore {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const requests: FakeObjectStore["requests"] = [];

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = toRecord(init?.headers);
    requests.push({ method, url: url.toString(), headers });

    if (!headers.authorization) {
      return new Response("unsigned request", { status: 403 });
    }

    const key = decodeURIComponent(url.pathname);

    if (method === "PUT") {
      objects.set(key, {
        body: new Uint8Array(await toArrayBuffer(init?.body)),
        contentType: headers["content-type"] ?? "application/octet-stream",
      });
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      const existed = objects.delete(key);
      return new Response(null, { status: existed ? 204 : 404 });
    }

    const object = objects.get(key);
    if (!object)
      return new Response("<Error>NoSuchKey</Error>", { status: 404 });

    const responseHeaders = {
      "content-type": object.contentType,
      "content-length": String(object.body.byteLength),
      "last-modified": new Date(0).toUTCString(),
    };
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: responseHeaders });
    }
    return new Response(object.body as unknown as BodyInit, {
      status: 200,
      headers: responseHeaders,
    });
  };

  return { fetch, objects, requests };
}

/** A Workers R2 binding, enough of one for the contract suite. */
export function fakeR2Bucket(): {
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; size: number; httpMetadata?: { contentType?: string } } | null>; // prettier-ignore
  delete(keys: string | string[]): Promise<void>;
  head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string } } | null>; // prettier-ignore
} {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();

  return {
    async put(key, value, options) {
      const metadata = (options as { httpMetadata?: { contentType?: string } } | undefined)?.httpMetadata; // prettier-ignore
      objects.set(key, {
        body: new Uint8Array(await toArrayBuffer(value as BodyInit)),
        contentType: metadata?.contentType ?? "application/octet-stream",
      });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: new Blob([object.body as unknown as BlobPart]).stream(),
        size: object.body.byteLength,
        httpMetadata: { contentType: object.contentType },
      };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key);
      }
    },
    async head(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        size: object.body.byteLength,
        httpMetadata: { contentType: object.contentType },
      };
    },
  };
}

function toRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    headers as Record<string, string>,
  )) {
    result[name.toLowerCase()] = value;
  }
  return result;
}

async function toArrayBuffer(
  body: BodyInit | null | undefined,
): Promise<ArrayBuffer> {
  if (!body) return new ArrayBuffer(0);
  if (body instanceof Uint8Array) {
    return body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
  }
  return new Response(body).arrayBuffer();
}
