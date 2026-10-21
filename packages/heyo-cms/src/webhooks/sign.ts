/**
 * The signature a consumer verifies.
 *
 * `t=<unix seconds>,v1=<hex hmac>` over `${t}.${body}`, which is the shape
 * Stripe popularised and most receivers already have code for. The timestamp
 * is inside the signed string on purpose: without it a captured delivery can
 * be replayed forever, and the consumer has no way to notice.
 */
export const signatureHeader = "x-heyo-signature";

export async function signPayload(
  body: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `t=${timestamp},v1=${hex(new Uint8Array(mac))}`;
}

/**
 * Verifies a signature the way a consumer should.
 *
 * Exported because the first thing anybody writes after subscribing is this
 * function, and the second thing they do is get it subtly wrong — comparing
 * with `===`, or forgetting that the timestamp is part of the signed string.
 */
export async function verifySignature(options: {
  body: string;
  header: string;
  secret: string;
  /** Rejects a delivery older than this. Defaults to five minutes. */
  toleranceSeconds?: number;
  now?: number;
}): Promise<boolean> {
  const parts = new Map(
    options.header.split(",").map((part) => {
      const [name, value] = part.split("=");
      return [name?.trim() ?? "", value?.trim() ?? ""];
    }),
  );
  const timestamp = Number(parts.get("t"));
  const provided = parts.get("v1");
  if (!Number.isFinite(timestamp) || !provided) return false;

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = await signPayload(options.body, options.secret, timestamp);
  const mine = expected.split("v1=")[1] ?? "";
  if (mine.length !== provided.length) return false;
  let difference = 0;
  for (let index = 0; index < mine.length; index += 1) {
    difference |= mine.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return difference === 0;
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}
