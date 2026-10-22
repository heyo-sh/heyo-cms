import type { ImageFormat, ImageInfo } from "../types/media";

/**
 * What an image is, read from its header.
 *
 * No decoder and no dependency: every format below states its dimensions in
 * the first few dozen bytes, and reading them is the difference between
 * `uploads.limits.maxImageDimensions` being a real limit on every runtime and
 * being a limit only where a native module happens to be installed.
 *
 * It also answers "what is this file, really". A browser will happily send
 * `application/octet-stream`, and a caller will happily lie, so the MIME type
 * that ends up in the database is the one the bytes support.
 */

const contentTypes: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  tiff: "image/tiff",
};

export function imageContentType(format: ImageFormat): string {
  return contentTypes[format];
}

export function probeImage(bytes: Uint8Array): ImageInfo | null {
  return (
    probePng(bytes) ??
    probeGif(bytes) ??
    probeWebp(bytes) ??
    probeJpeg(bytes) ??
    probeIsoBmff(bytes) ??
    probeSvg(bytes)
  );
}

/** The extension a stored object should carry for a content type. */
export function extensionFor(contentType: string): string {
  const known: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "image/tiff": "tiff",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/plain": "txt",
    "text/csv": "csv",
  };
  const mapped = known[contentType.toLowerCase()];
  if (mapped) return mapped;
  // `image/x-icon` -> `x-icon`, which is wrong but harmless and honest about
  // what we were told, unlike silently writing `.bin`.
  const subtype = contentType.split("/")[1]?.split(";")[0]?.trim();
  return subtype && /^[a-z0-9.+-]+$/i.test(subtype) ? subtype : "bin";
}

function probePng(bytes: Uint8Array): ImageInfo | null {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !starts(bytes, magic)) return null;
  return info("png", be32(bytes, 16), be32(bytes, 20));
}

function probeGif(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== "GIF") return null;
  return info("gif", le16(bytes, 6), le16(bytes, 8));
}

/**
 * WebP, which is three formats in one container.
 *
 * Lossy stores the size in the VP8 frame tag, lossless packs it into fourteen
 * bits apiece, and the extended form — the one an animation or an alpha
 * channel produces — puts the canvas size in its own chunk.
 */
function probeWebp(bytes: Uint8Array): ImageInfo | null {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }

  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return info("webp", le24(bytes, 24) + 1, le24(bytes, 27) + 1);
  }
  if (chunk === "VP8 ") {
    // 20 = RIFF header + WEBP + chunk header; then a 3-byte frame tag and the
    // 3-byte start code `9d 01 2a`.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null;
    }
    return info("webp", le16(bytes, 26) & 0x3fff, le16(bytes, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const b0 = at(bytes, 21);
    const b1 = at(bytes, 22);
    const b2 = at(bytes, 23);
    const b3 = at(bytes, 24);
    return info(
      "webp",
      (((b1 & 0x3f) << 8) | b0) + 1,
      (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) + 1,
    );
  }
  return null;
}

/** JPEG: walk the segment chain to the first frame header. */
function probeJpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = at(bytes, offset + 1);
    // Padding and the standalone markers carry no length field.
    if (
      marker === 0xff ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd9)
    ) {
      // prettier-ignore
      offset += 2;
      continue;
    }
    const isFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isFrame) {
      return info("jpeg", be16(bytes, offset + 7), be16(bytes, offset + 5));
    }
    const length = be16(bytes, offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * AVIF and HEIC, by finding the `ispe` box.
 *
 * A full ISO-BMFF walk would be a few hundred lines for one 12-byte answer.
 * The box is self-describing and its four-character code does not occur in
 * compressed payloads often enough to matter, so this looks for it inside the
 * metadata region and validates what it finds.
 */
function probeIsoBmff(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return null;
  const brand = ascii(bytes, 8, 4);
  const avif = brand === "avif" || brand === "avis";
  const heic = brand === "heic" || brand === "heix" || brand === "mif1";
  if (!avif && !heic) return null;

  const limit = Math.min(bytes.length - 16, 65_536);
  for (let offset = 16; offset < limit; offset += 1) {
    if (ascii(bytes, offset, 4) !== "ispe") continue;
    const width = be32(bytes, offset + 8);
    const height = be32(bytes, offset + 12);
    if (width > 0 && height > 0 && width < 100_000 && height < 100_000) {
      return info(avif ? "avif" : "avif", width, height);
    }
  }
  return null;
}

/**
 * SVG, which has no header at all.
 *
 * `width`/`height` when they are given in pixels, the viewBox otherwise, and
 * zero when it is a purely relative drawing — which is legal, and which the
 * dimension limit then has nothing to say about.
 */
function probeSvg(bytes: Uint8Array): ImageInfo | null {
  const head = new TextDecoder().decode(bytes.subarray(0, 2048));
  if (!/<svg[\s>]/i.test(head)) return null;

  const attribute = (name: string): number => {
    const match = new RegExp(`\\b${name}\\s*=\\s*["']([\\d.]+)`, "i").exec(
      head,
    );
    return match ? Math.round(Number(match[1])) : 0;
  };

  let width = attribute("width");
  let height = attribute("height");
  if (width === 0 || height === 0) {
    const box = /\bviewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i.exec(head); // prettier-ignore
    if (box) {
      width = Math.round(Number(box[1]));
      height = Math.round(Number(box[2]));
    }
  }
  return info("svg", width, height);
}

function info(format: ImageFormat, width: number, height: number): ImageInfo {
  return { format, contentType: contentTypes[format], width, height };
}

function at(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

function be16(bytes: Uint8Array, offset: number): number {
  return (at(bytes, offset) << 8) | at(bytes, offset + 1);
}

function be32(bytes: Uint8Array, offset: number): number {
  return (
    at(bytes, offset) * 0x1000000 +
    ((at(bytes, offset + 1) << 16) |
      (at(bytes, offset + 2) << 8) |
      at(bytes, offset + 3))
  );
}

function le16(bytes: Uint8Array, offset: number): number {
  return at(bytes, offset) | (at(bytes, offset + 1) << 8);
}

function le24(bytes: Uint8Array, offset: number): number {
  return (
    at(bytes, offset) | (at(bytes, offset + 1) << 8) | (at(bytes, offset + 2) << 16) // prettier-ignore
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(at(bytes, offset + index));
  }
  return out;
}

function starts(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}
