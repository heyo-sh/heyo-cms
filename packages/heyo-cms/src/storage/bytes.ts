/**
 * Byte plumbing shared by every storage adapter.
 *
 * Kept in one place because the conversions are exactly the kind of thing that
 * grows a subtly different copy in each adapter — one that forgets a chunk
 * boundary, or that assumes `Buffer` and therefore excludes Workers.
 */

/** Collects whatever a caller handed us into one contiguous buffer. */
export async function toBytes(
  body: ReadableStream | Uint8Array | ArrayBuffer | Blob,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }

  const chunks: Uint8Array[] = [];
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** A one-shot stream over bytes already in memory. */
export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** base64 without `Buffer`, because the core also runs on Workers. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  // `BufferSource` wants an ArrayBuffer-backed view; a Uint8Array over a
  // SharedArrayBuffer would not be one, and slicing guarantees the right kind.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}
