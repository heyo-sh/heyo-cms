/**
 * TOTP (RFC 6238), on Web Crypto.
 *
 * Six digits, thirty seconds, HMAC-SHA1 — not because SHA-1 is a good hash in
 * 2026, but because it is what every authenticator app implements, and a
 * second factor nobody can enrol is not a second factor.
 */

const digits = 6;
const period = 30;
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 160 bits, the size RFC 4226 recommends for the HMAC-SHA1 key. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/**
 * The `otpauth://` URI an authenticator scans.
 *
 * The issuer appears twice — as a label prefix and as a parameter — which is
 * redundant and is also what every app expects.
 */
export function totpUri(options: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.account)}`;
  const parameters = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

export async function totpCode(
  secret: string,
  at = Date.now(),
): Promise<string> {
  return generate(secret, Math.floor(at / 1000 / period));
}

/**
 * Verifies a code, allowing one step either side.
 *
 * The window is for clock drift between the phone and the server, not for
 * convenience: widening it multiplies the number of codes that are valid at
 * any moment, which is exactly what the second factor is trying to limit.
 */
export async function verifyTotp(
  secret: string | null | undefined,
  code: string,
  options: { at?: number; window?: number } = {},
): Promise<boolean> {
  if (!secret) return false;
  const cleaned = code.replaceAll(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;

  const counter = Math.floor((options.at ?? Date.now()) / 1000 / period);
  const window = options.window ?? 1;

  for (let offset = -window; offset <= window; offset += 1) {
    const expected = await generate(secret, counter + offset);
    // Both strings are six digits, so length never differs and the loop
    // always runs the same number of comparisons.
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
      difference |= expected.charCodeAt(index) ^ cleaned.charCodeAt(index);
    }
    if (difference === 0) return true;
  }
  return false;
}

async function generate(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const message = new Uint8Array(8);
  let value = counter;
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = value & 0xff;
    value = Math.floor(value / 256);
  }

  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, message as BufferSource),
  );
  const offset = (signature[signature.length - 1] ?? 0) & 0x0f;
  const binary =
    (((signature[offset] ?? 0) & 0x7f) << 24) |
    (((signature[offset + 1] ?? 0) & 0xff) << 16) |
    (((signature[offset + 2] ?? 0) & 0xff) << 8) |
    ((signature[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string): Uint8Array {
  const cleaned = value.replaceAll("=", "").replaceAll(/\s/g, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;

  for (const character of cleaned) {
    const index = base32Alphabet.indexOf(character);
    if (index === -1) continue;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}
