import { base64url, fromBase64url } from "../auth/crypto";
import { CmsError } from "../errors";

/**
 * Provider keys stored in the database, encrypted.
 *
 * The paragraph pattern the plan cites (`aiProviderCredentials` +
 * `decryptApiKey`): a key configured in the panel has to be readable by the
 * server and by nobody who gets a copy of the table. AES-GCM over Web Crypto,
 * so the same code runs on Node, Bun and Workers — the same constraint that
 * shaped the auth primitives.
 *
 * The encryption key is derived from `ai.storage.secret`. Rotating that
 * secret therefore invalidates every stored key, which is the honest
 * behaviour: an envelope scheme that survived rotation would mean the old
 * secret still decrypts, which is not what rotation means.
 */

const version = "v1";
const ivLength = 12;

async function keyFrom(secret: string): Promise<CryptoKey> {
  if (secret.length < 16) {
    throw new CmsError(
      "ai.storage.secret must be at least 16 characters; it encrypts provider keys.",
      { status: 500, code: "ai_secret_too_short" },
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(
  plaintext: string,
  secret: string,
): Promise<string> {
  const key = await keyFrom(secret);
  const iv = crypto.getRandomValues(new Uint8Array(ivLength));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return [version, base64url(iv), base64url(new Uint8Array(ciphertext))].join(
    ".",
  );
}

/**
 * Decrypts, or says what is wrong.
 *
 * A value that will not decrypt is almost always a rotated secret rather
 * than tampering, and the error says so: the alternative is an operator
 * staring at "AI failed" after changing an environment variable.
 */
export async function decryptSecret(
  stored: string,
  secret: string,
): Promise<string> {
  const [marker, iv, ciphertext] = stored.split(".");
  if (marker !== version || !iv || !ciphertext) {
    throw new CmsError("A stored provider key is not in a format this version can read.", { status: 500, code: "ai_credential_unreadable" }); // prettier-ignore
  }
  const key = await keyFrom(secret);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv) as BufferSource },
      key,
      fromBase64url(ciphertext) as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new CmsError(
      "A stored provider key could not be decrypted; ai.storage.secret has probably changed. Re-enter the key in the panel.",
      { status: 500, code: "ai_credential_unreadable" },
    );
  }
}

/** The last four characters, so a key can be recognised but not used. */
export function keyHint(token: string): string {
  return token.length <= 4 ? "****" : `…${token.slice(-4)}`;
}
