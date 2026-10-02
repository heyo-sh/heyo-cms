/**
 * Identifiers and checksums.
 *
 * Ids are generated in the engine rather than by the database: MongoDB,
 * Postgres and D1 would otherwise each produce a different shape, and the
 * value has to exist before the insert so hooks and events can reference the
 * document they are about.
 */

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A sortable, prefixed id: `doc_01jq8z4m2k7xqf3h`.
 *
 * Time-ordered like a ULID, because an id that sorts by creation turns
 * "newest first" into an index scan instead of a sort, and makes a log of
 * ids readable. Randomness is 60 bits, which is far more than a single
 * millisecond of inserts needs.
 */
export function createId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const random = crypto.getRandomValues(new Uint8Array(8));
  let suffix = "";
  for (const byte of random) {
    suffix += alphabet[byte % alphabet.length];
  }
  return `${prefix}_${time}${suffix}`;
}

/**
 * A fingerprint of a migration file.
 *
 * FNV-1a, not a cryptographic hash: this answers "has this file changed since
 * it was applied", which is a question about accidents, not attackers. A
 * 64-bit digest makes an accidental collision impossible in a directory that
 * will hold hundreds of files, not billions.
 */
export function checksum(content: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = new TextEncoder().encode(content);

  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
