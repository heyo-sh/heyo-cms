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
 * Uniform random base-36 characters.
 *
 * A plain `byte % 36` prefers the first 4 characters of the alphabet,
 * because 256 is not a multiple of 36. Rejection sampling discards the
 * 4 byte values past the last full multiple (252), so every character is
 * equally likely and the ids stay unpredictable end to end.
 */
function randomSuffix(length: number): string {
  const limit = 252; // the largest multiple of 36 that fits in a byte
  let suffix = "";
  while (suffix.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      suffix += alphabet[byte % alphabet.length];
      if (suffix.length === length) break;
    }
  }
  return suffix;
}

/**
 * A sortable, prefixed id: `doc_01jq8z4m2k7xqf3h`.
 *
 * Time-ordered like a ULID, because an id that sorts by creation turns
 * "newest first" into an index scan instead of a sort, and makes a log of
 * ids readable. Randomness is eight base-36 characters — about 41 bits —
 * which is far more than a single millisecond of inserts needs.
 */
export function createId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  return `${prefix}_${time}${randomSuffix(8)}`;
}

/**
 * An id that sorts by creation order even inside one millisecond.
 *
 * `createId()` breaks a tie randomly, which is fine for a document and wrong
 * for the outbox: section 7 guarantees delivery order per document, and two
 * events written by the same transaction routinely land in the same
 * millisecond. A process-local counter makes the tie deterministic; across
 * processes the timestamp still orders them.
 */
let sequence = 0;

export function createOrderedId(prefix: string): string {
  sequence = (sequence + 1) % 60_466_175; // 36^5 - 1
  const time = Date.now().toString(36).padStart(9, "0");
  const counter = sequence.toString(36).padStart(5, "0");
  return `${prefix}_${time}${counter}${randomSuffix(3)}`;
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
