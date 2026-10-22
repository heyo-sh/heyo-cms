/**
 * Every cryptographic primitive the auth layer needs, on Web Crypto alone.
 *
 * No `node:crypto`, no native dependency, no `bcrypt` build step: the same
 * code has to run on Node, Bun, Cloudflare Workers and Vercel's edge runtime,
 * and an auth package that only works on one of them would quietly undo the
 * "zero framework coupling" promise at the deployment layer.
 */

/**
 * PBKDF2-SHA256 rounds.
 *
 * Chosen for the slowest runtime we support rather than the fastest: a Worker
 * request has a CPU budget measured in milliseconds, and a hash that blows it
 * turns sign-in into a 500. 100k rounds is OWASP's floor for PBKDF2-SHA256 and
 * costs roughly 50 ms.
 */
const iterations = 100_000;
const keyLength = 32;
const saltLength = 16;
const scheme = "pbkdf2-sha256";

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(saltLength));
  const derived = await derive(password, salt, iterations);
  return [scheme, iterations, base64url(salt), base64url(derived)].join("$");
}

/**
 * Verifies a password against a stored hash.
 *
 * Reads the iteration count from the stored value instead of assuming the
 * current one, so raising the cost later does not invalidate every existing
 * password.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const [algorithm, rounds, salt, digest] = stored.split("$");
  if (algorithm !== scheme || !rounds || !salt || !digest) return false;

  const derived = await derive(password, fromBase64url(salt), Number(rounds));
  return timingSafeEqual(base64url(derived), digest);
}

async function derive(
  password: string,
  salt: Uint8Array,
  rounds: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: rounds, hash: "SHA-256" }, // prettier-ignore
    key,
    keyLength * 8,
  );
  return new Uint8Array(bits);
}

/**
 * A secret nobody can guess: 32 bytes of CSPRNG, URL-safe.
 *
 * Used for session tokens, API keys, invitations, magic links and OAuth
 * state. One generator means one place to be wrong about entropy.
 */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * What goes in the database when the plaintext goes to the user.
 *
 * SHA-256 rather than PBKDF2 on purpose: these are 256-bit random secrets, not
 * passwords, so there is nothing to brute-force and the lookup has to be a
 * single indexed read on every request.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return hex(new Uint8Array(digest));
}

/**
 * Comparison whose duration does not depend on where the strings differ.
 *
 * A fast `===` on a token hash leaks the prefix one byte at a time to anyone
 * willing to measure.
 */
export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); // prettier-ignore
}

export function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

/** SHA-256 of a string, base64url — the PKCE challenge, and nothing else. */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64url(new Uint8Array(digest));
}
