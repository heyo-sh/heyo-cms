import { concat } from "../storage/bytes";

/**
 * Metadata removal, without a decoder.
 *
 * `stripMetadata` exists for one concrete reason: a photograph taken on a
 * phone carries the coordinates of the place it was taken, and a CMS that
 * publishes it publishes those too (section 6). That is a privacy obligation,
 * not an optimisation, so it must not depend on whether an optional image
 * processor happens to be installed — which is why it is implemented here, by
 * dropping container chunks rather than by re-encoding pixels.
 *
 * ICC colour profiles are deliberately kept. Dropping them is what most tools
 * do under "strip metadata", and it visibly shifts the colours of every
 * wide-gamut photograph, which is not what anybody asking for privacy meant.
 */
export function stripImageMetadata(
  bytes: Uint8Array,
  contentType: string,
): Uint8Array {
  switch (contentType.toLowerCase()) {
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/png":
      return stripPng(bytes);
    case "image/webp":
      return stripWebp(bytes);
    default:
      // GIF has no standard metadata block worth the risk, and a format we do
      // not understand is returned untouched rather than corrupted.
      return bytes;
  }
}

/**
 * JPEG: copy every segment except the ones that describe the photographer.
 *
 * APP1 is EXIF and XMP, which is where GPS, the camera serial number and the
 * editing history live. APP13 is the Photoshop IRB, APP14 Adobe's colour
 * transform flag — kept, because dropping it makes CMYK files render wrong —
 * and COM is a free-text comment.
 */
function stripJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;

  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1] ?? 0;

    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      // prettier-ignore
      parts.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: everything after it is entropy-coded image data.
      parts.push(bytes.subarray(offset));
      offset = bytes.length;
      break;
    }

    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (length < 2 || offset + 2 + length > bytes.length) break;

    if (!isStrippableJpegSegment(marker)) {
      parts.push(bytes.subarray(offset, offset + 2 + length));
    }
    offset += 2 + length;
  }

  if (offset < bytes.length) parts.push(bytes.subarray(offset));
  return concat(parts);
}

function isStrippableJpegSegment(marker: number): boolean {
  if (marker === 0xfe) return true; // COM, a free-text comment
  if (marker === 0xe0) return false; // APP0, JFIF: structure, not metadata
  if (marker === 0xe2) return false; // APP2, the ICC colour profile
  if (marker === 0xee) return false; // APP14, Adobe's colour transform flag
  // Everything else in the APPn range is application metadata. APP1 — EXIF and
  // XMP — is the one that matters; the rest are vendor blobs that nobody
  // consuming a CMS needs and that nobody audits.
  return marker >= 0xe0 && marker <= 0xef;
}

/** PNG: textual chunks, the EXIF chunk and the modification time. */
function stripPng(bytes: Uint8Array): Uint8Array {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 8 ||
    !magic.every((byte, index) => bytes[index] === byte)
  ) {
    return bytes;
  }

  const drop = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME", "dSIG"]);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = be32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const total = 12 + length;
    if (total < 12 || offset + total > bytes.length) break;
    // Each chunk carries its own CRC, so removing one needs no recomputation.
    if (!drop.has(type)) parts.push(bytes.subarray(offset, offset + total));
    offset += total;
    if (type === "IEND") break;
  }

  return concat(parts);
}

/** WebP: the EXIF and XMP chunks of the extended container. */
function stripWebp(bytes: Uint8Array): Uint8Array {
  if (
    bytes.length < 12 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return bytes;
  }

  const drop = new Set(["EXIF", "XMP "]);
  const kept: Uint8Array[] = [];
  let offset = 12;
  let removed = false;

  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const size = le32(bytes, offset + 4);
    // RIFF chunks are padded to an even length.
    const total = 8 + size + (size % 2);
    if (offset + total > bytes.length) break;
    if (drop.has(type)) removed = true;
    else kept.push(bytes.subarray(offset, offset + total));
    offset += total;
  }

  if (!removed) return bytes;

  const payload = concat(kept);
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 12));
  // The RIFF size counts everything after it, which now includes four fewer
  // bytes of metadata; leaving it stale makes decoders read past the end.
  writeLe32(header, 4, payload.byteLength + 4);
  return concat([header, payload]);
}

function be32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    (((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0))
  );
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    (bytes[offset + 3] ?? 0) * 0x1000000
  );
}

function writeLe32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return out;
}
