import { parseDuration } from "../duration";
import { CmsConfigError, CmsError } from "../errors";
import type {
  StorageAdapter,
  StorageAdapterFactory,
  StoredObject,
} from "../types/storage";
import { encodeKey, httpStorage, type FetchLike } from "./http";
import { signAwsV4, signAzure, type AwsCredentials } from "./sign";

/**
 * The managed object stores.
 *
 * Four adapters, two signing schemes, one transport (`http.ts`). Parity with
 * Payload's storage plugins, minus the four packages and the SDK each of them
 * drags in — the installation budget in section 0 is the whole reason this is
 * written out rather than delegated.
 */

const defaultExpiry = "1h";

export interface S3StorageOptions {
  bucket: string;
  region?: string;
  /** Set for an S3-compatible service: MinIO, Tigris, Wasabi, Ceph. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  acl?: "private" | "public-read";
  signedUrls?: { enabled: boolean; expiresIn?: string };
  /** Serve from a CDN while writing straight to the bucket. */
  publicUrl?: string;
  /** Where new objects go, given the file. Defaults to `{year}/{id}`. */
  prefix?: (file: { id: string; filename: string }) => string;
  /** Path-style addressing. Forced on when an `endpoint` is given. */
  forcePathStyle?: boolean;
  fetch?: FetchLike;
}

/**
 * S3 and everything that speaks its API.
 *
 * Credentials are read from the environment when they are not given, which is
 * what makes an IAM role or a `~/.aws` profile work without naming a secret in
 * a file that is checked in.
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

  return () => awsStorage("s3", options, "s3");
}

export interface R2StorageOptions extends Omit<
  S3StorageOptions,
  "region" | "endpoint"
> {
  /** From the Cloudflare dashboard. Not needed when a binding is passed. */
  accountId?: string;
}

/** A Workers R2 binding, structurally. Typing it avoids depending on the types. */
export interface R2Binding {
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(keys: string | string[]): Promise<void>;
  head(key: string): Promise<R2ObjectLike | null>;
}

interface R2ObjectLike {
  size: number;
  uploaded?: Date;
  httpMetadata?: { contentType?: string };
}

interface R2ObjectBody extends R2ObjectLike {
  body: ReadableStream;
}

/**
 * Cloudflare R2, either way round.
 *
 * Given a binding it uses the binding, which costs nothing and leaves the
 * Worker's own network. Given credentials it speaks S3 over HTTPS, which is
 * what a Node process or a build script has to do.
 */
export function r2(
  binding: R2Binding | (R2StorageOptions & { bucket: string }),
): StorageAdapterFactory {
  if (isR2Binding(binding)) {
    return () => r2BindingStorage(binding);
  }

  const options = binding;
  if (!options.accountId) {
    throw new CmsConfigError(
      "uploads.storage",
      "r2() needs an accountId, or an R2 bucket binding",
    );
  }
  return () =>
    awsStorage(
      "r2",
      {
        ...options,
        region: "auto",
        endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
        forcePathStyle: true,
      },
      "s3",
    );
}

export interface GcsStorageOptions extends Omit<
  S3StorageOptions,
  "endpoint" | "forcePathStyle"
> {
  /** An HMAC key from Cloud Storage interoperability settings. */
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * Google Cloud Storage, through its S3-compatible XML endpoint.
 *
 * Interoperability mode rather than the JSON API because it needs an HMAC key
 * pair and nothing else: the JSON API wants a service-account JWT, which means
 * RSA signing, key rotation and a JSON file on disk, for the same four verbs.
 */
export function gcs(options: GcsStorageOptions): StorageAdapterFactory {
  if (!options.bucket) {
    throw new CmsConfigError("uploads.storage", "gcs() needs a bucket");
  }
  return () =>
    awsStorage(
      "gcs",
      {
        ...options,
        region: options.region ?? "auto",
        endpoint: "https://storage.googleapis.com",
        forcePathStyle: true,
      },
      "s3",
    );
}

export interface AzureStorageOptions {
  /** The storage account name, not its URL. */
  account: string;
  container: string;
  /** The account key. Falls back to `AZURE_STORAGE_KEY`. */
  accountKey?: string;
  publicUrl?: string;
  prefix?: (file: { id: string; filename: string }) => string;
  fetch?: FetchLike;
}

/** Azure Blob Storage, signed with a shared key. */
export function azure(options: AzureStorageOptions): StorageAdapterFactory {
  if (!options.account || !options.container) {
    throw new CmsConfigError(
      "uploads.storage",
      "azure() needs an account and a container",
    );
  }

  return () => {
    const key = required(
      options.accountKey ?? env("AZURE_STORAGE_KEY"),
      "azure()",
      "an account key",
      "AZURE_STORAGE_KEY",
    );
    const base = `https://${options.account}.blob.core.windows.net/${options.container}`;
    const publicBase = (options.publicUrl ?? base).replace(/\/+$/, "");

    return httpStorage({
      id: "azure",
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      endpoint: (objectKey) => new URL(`${base}/${encodeKey(objectKey)}`),
      publicUrl: (objectKey) => `${publicBase}/${encodeKey(objectKey)}`,
      // Block blobs are the only kind that makes sense for uploaded media, and
      // the header is required on every write.
      defaultHeaders: { "x-ms-blob-type": "BlockBlob" },
      sign: (request) =>
        signAzure({
          method: request.method,
          url: request.url,
          headers: request.headers,
          account: options.account,
          key,
          contentLength: request.contentLength,
        }),
    });
  };
}

// ---------------------------------------------------------------------------
// Shared implementation
// ---------------------------------------------------------------------------

function awsStorage(
  id: string,
  options: S3StorageOptions,
  service: string,
): StorageAdapter {
  const credentials: AwsCredentials = {
    accessKeyId: required(
      options.accessKeyId ?? env("AWS_ACCESS_KEY_ID"),
      `${id}()`,
      "an access key id",
      "AWS_ACCESS_KEY_ID",
    ),
    secretAccessKey: required(
      options.secretAccessKey ?? env("AWS_SECRET_ACCESS_KEY"),
      `${id}()`,
      "a secret access key",
      "AWS_SECRET_ACCESS_KEY",
    ),
    ...((options.sessionToken ?? env("AWS_SESSION_TOKEN"))
      ? { sessionToken: (options.sessionToken ?? env("AWS_SESSION_TOKEN")) as string } // prettier-ignore
      : {}),
  };

  const region = options.region ?? "us-east-1";
  // Virtual-host style is what AWS wants and what its TLS certificates cover;
  // every compatible service is addressed by path, because its bucket is not
  // a subdomain of anything.
  const pathStyle =
    options.forcePathStyle === true || Boolean(options.endpoint);
  const host = options.endpoint
    ? options.endpoint.replace(/\/+$/, "")
    : `https://s3.${region}.amazonaws.com`;
  const base = pathStyle ? `${host}/${options.bucket}` : hostWithBucket(host, options.bucket); // prettier-ignore
  const publicBase = (options.publicUrl ?? base).replace(/\/+$/, "");

  const expiresIn = () =>
    Math.floor(
      parseDuration(options.signedUrls?.expiresIn ?? defaultExpiry) / 1000,
    );

  return httpStorage({
    id,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    endpoint: (key) => new URL(`${base}/${encodeKey(key)}`),
    publicUrl: (key) => `${publicBase}/${encodeKey(key)}`,
    ...(options.acl === undefined
      ? {}
      : { defaultHeaders: { "x-amz-acl": options.acl } }),
    sign: (request) =>
      signAwsV4({
        method: request.method,
        url: request.url,
        headers: request.headers,
        payload: request.payload,
        region,
        service,
        credentials,
      }),
    signedUrl: (key, signOptions) =>
      presign({
        url: new URL(`${base}/${encodeKey(key)}`),
        region,
        service,
        credentials,
        expiresIn: toSeconds(signOptions?.expiresIn) ?? expiresIn(),
        ...(signOptions?.download === true
          ? {
              disposition: `attachment${signOptions.filename ? `; filename="${signOptions.filename}"` : ""}`,
            }
          : {}),
      }),
  });
}

/**
 * A URL that carries its own signature.
 *
 * The same canonical request as a signed header, with the credential scope
 * moved into the query string and the body declared unsigned — which it has to
 * be, because the browser that will follow the link has not been born yet.
 */
async function presign(options: {
  url: URL;
  region: string;
  service: string;
  credentials: AwsCredentials;
  expiresIn: number;
  disposition?: string;
}): Promise<string> {
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const scope = `${amzDate.slice(0, 8)}/${options.region}/${options.service}/aws4_request`;

  const url = new URL(options.url.toString());
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set(
    "X-Amz-Credential",
    `${options.credentials.accessKeyId}/${scope}`,
  );
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(options.expiresIn));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  if (options.credentials.sessionToken) {
    url.searchParams.set("X-Amz-Security-Token", options.credentials.sessionToken); // prettier-ignore
  }
  if (options.disposition) {
    url.searchParams.set("response-content-disposition", options.disposition);
  }

  // Reusing the header signer would sign `x-amz-date` and `x-amz-content-sha256`
  // as headers, which a browser will not send. Presigning signs `host` alone.
  const signed = await signAwsV4({
    method: "GET",
    url,
    headers: {},
    payload: "UNSIGNED-PAYLOAD",
    region: options.region,
    service: options.service,
    credentials: { ...options.credentials, sessionToken: undefined as never },
    now,
  });
  const signature = /Signature=([a-f0-9]+)/.exec(signed.authorization ?? "")?.[1]; // prettier-ignore
  url.searchParams.set("X-Amz-Signature", signature ?? "");
  return url.toString();
}

function r2BindingStorage(bucket: R2Binding): StorageAdapter {
  return {
    id: "r2",
    async put(key, body, meta) {
      await bucket.put(key, body, {
        httpMetadata: {
          contentType: meta.contentType,
          ...(meta.cacheControl ? { cacheControl: meta.cacheControl } : {}),
        },
        ...(meta.metadata ? { customMetadata: meta.metadata } : {}),
      });
    },
    async get(key) {
      const object = await bucket.get(key);
      return object ? object.body : null;
    },
    async delete(keys) {
      if (keys.length > 0) await bucket.delete(keys);
    },
    url(key) {
      // A binding has no public hostname: R2 serves through a custom domain or
      // a Worker route, and inventing `r2.cloudflarestorage.com` here would
      // produce a URL that answers 401 to everybody.
      return `/${key}`;
    },
    async head(key): Promise<StoredObject | null> {
      const object = await bucket.head(key);
      if (!object) return null;
      return {
        key,
        size: object.size,
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream", // prettier-ignore
        ...(object.uploaded ? { lastModified: object.uploaded } : {}),
      };
    },
  };
}

function isR2Binding(value: unknown): value is R2Binding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as R2Binding).get === "function" &&
    typeof (value as R2Binding).put === "function" &&
    typeof (value as R2Binding).head === "function"
  );
}

function hostWithBucket(host: string, bucket: string): string {
  const url = new URL(host);
  url.host = `${bucket}.${url.host}`;
  return url.toString().replace(/\/+$/, "");
}

function env(name: string): string | undefined {
  // `process` is absent in a Worker, and reading it unguarded there would turn
  // "configure your bucket" into a ReferenceError at module load.
  const source = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env; // prettier-ignore
  return source?.[name];
}

function required(
  value: string | undefined,
  who: string,
  what: string,
  variable: string,
): string {
  if (value) return value;
  throw new CmsError(
    `${who} needs ${what}; pass it in the configuration or set ${variable}`,
    { status: 500, code: "storage_credentials_missing" },
  );
}

function toSeconds(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number"
    ? value
    : Math.floor(parseDuration(value) / 1000);
}
