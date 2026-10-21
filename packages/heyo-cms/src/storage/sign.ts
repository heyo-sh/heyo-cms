import { base64, hex, sha256 } from "./bytes";

/**
 * Request signing for the object stores we speak to over HTTP.
 *
 * Written out rather than taken from an SDK on purpose. `@aws-sdk/client-s3`
 * is roughly twenty megabytes of dependency for four HTTP verbs, which is the
 * entire installation budget this project set itself (section 0), and it does
 * not run unchanged on every runtime we target. Signing is about ninety lines
 * when the only operations are PUT, GET, DELETE and HEAD.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Set when the credentials come from an assumed role. */
  sessionToken?: string;
}

export interface AwsSignRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** `UNSIGNED-PAYLOAD` is legal over TLS and avoids buffering a stream. */
  payload: Uint8Array | "UNSIGNED-PAYLOAD";
  region: string;
  service: string;
  credentials: AwsCredentials;
  now?: Date;
}

const unsigned = "UNSIGNED-PAYLOAD";

/**
 * AWS Signature Version 4.
 *
 * Used for S3, for R2 (which speaks the S3 API) and for Google Cloud Storage
 * through its S3-compatible XML endpoint, so one implementation covers three
 * of the five adapters.
 */
export async function signAwsV4(
  request: AwsSignRequest,
): Promise<Record<string, string>> {
  const now = request.now ?? new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash =
    request.payload === unsigned
      ? unsigned
      : hex(await sha256(request.payload));

  const headers: Record<string, string> = {
    ...request.headers,
    host: request.url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    ...(request.credentials.sessionToken
      ? { "x-amz-security-token": request.credentials.sessionToken }
      : {}),
  };

  const canonicalHeaders = Object.entries(headers)
    .map(
      ([name, value]) =>
        [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const,
    ) // prettier-ignore
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(";");

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(request.url.pathname),
    canonicalQuery(request.url),
    `${canonicalHeaders.map(([name, value]) => `${name}:${value}`).join("\n")}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hex(await sha256(canonicalRequest)),
  ].join("\n");

  const signingKey = await deriveKey(
    request.credentials.secretAccessKey,
    dateStamp,
    request.region,
    request.service,
  );
  const signature = hex(await hmac(signingKey, stringToSign));

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface AzureSignRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  account: string;
  /** The base64 account key from the portal. */
  key: string;
  contentLength?: number;
  now?: Date;
}

/**
 * Azure Blob Storage shared key.
 *
 * A different scheme from SigV4 and not reducible to it: the string to sign is
 * a fixed list of positional headers, most of which we never send and all of
 * which still have to be there as empty lines.
 */
export async function signAzure(
  request: AzureSignRequest,
): Promise<Record<string, string>> {
  const now = request.now ?? new Date();
  const headers: Record<string, string> = {
    ...request.headers,
    "x-ms-date": now.toUTCString(),
    "x-ms-version": "2021-08-06",
  };

  const canonicalHeaders = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .filter(([name]) => name.startsWith("x-ms-"))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");

  const query = [...request.url.searchParams.keys()]
    .map((name) => name.toLowerCase())
    .sort()
    .map(
      (name) =>
        `${name}:${request.url.searchParams.getAll(name).sort().join(",")}`,
    ) // prettier-ignore
    .join("\n");

  const canonicalResource =
    `/${request.account}${decodeURIComponent(request.url.pathname)}` +
    (query ? `\n${query}` : "");

  const stringToSign = [
    request.method.toUpperCase(),
    headers["content-encoding"] ?? "",
    headers["content-language"] ?? "",
    // Zero is an empty line rather than "0": Azure's own documentation calls
    // this out, and getting it wrong fails every request with no body.
    request.contentLength ? String(request.contentLength) : "",
    headers["content-md5"] ?? "",
    headers["content-type"] ?? "",
    "",
    "",
    "",
    "",
    "",
    "",
    canonicalHeaders,
    canonicalResource,
  ].join("\n");

  const signature = base64(
    await hmac(base64ToBytes(request.key), stringToSign),
  );
  return {
    ...headers,
    authorization: `SharedKey ${request.account}:${signature}`,
  };
}

async function deriveKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  let key = await hmac(encoder.encode(`AWS4${secret}`), dateStamp);
  key = await hmac(key, region);
  key = await hmac(key, service);
  return hmac(key, "aws4_request");
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    imported,
    new TextEncoder().encode(data) as BufferSource,
  );
  return new Uint8Array(signature);
}

/**
 * Every segment encoded, slashes kept.
 *
 * S3 object keys routinely contain spaces and non-ASCII characters, and a
 * signature computed over a differently encoded path fails with a message
 * that names none of this.
 */
function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)])
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
