import { parseByteSize } from "../duration";
import { CmsError } from "../errors";
import { hex, sha256 } from "../storage/bytes";
import type { ImagesConfig, UploadsConfig } from "../types/config";
import type { ImageInfo, ImageTransform } from "../types/media";
import { extensionFor, probeImage } from "./probe";
import { stripImageMetadata } from "./strip";

/**
 * What happens between "here is a file" and "it is in the bucket".
 *
 * Validate, identify, shrink, strip, fingerprint — in that order, and all of
 * it before a single byte reaches storage. Doing any of it afterwards would
 * mean a rejected upload still costs a write, and a downscale that failed
 * would leave the original in the bucket forever.
 */

export interface PreparedUpload {
  data: Uint8Array;
  contentType: string;
  filename: string;
  /** Null for anything that is not an image we can read. */
  info: ImageInfo | null;
  checksum: string;
  extension: string;
}

export interface PrepareUploadOptions {
  bytes: Uint8Array;
  filename: string;
  /** What the client claimed. Overruled by the bytes when they disagree. */
  contentType: string;
  uploads: UploadsConfig;
}

export async function prepareUpload(
  options: PrepareUploadOptions,
): Promise<PreparedUpload> {
  const limits = options.uploads.limits;
  const images = options.uploads.images;

  // Identity first: every check below is about the real file, not about what
  // a form happened to label it. A browser sends `application/octet-stream`
  // for anything it does not recognise, and a caller can send whatever it
  // likes.
  const probed = probeImage(options.bytes);
  const contentType = resolveContentType(options.contentType, probed);

  assertAccepted(contentType, limits?.accept);

  if (limits?.maxFileSize) {
    const max = parseByteSize(limits.maxFileSize, "uploads.limits.maxFileSize");
    if (options.bytes.byteLength > max) {
      throw new CmsError(
        `"${options.filename}" is ${format(options.bytes.byteLength)}, over the ${limits.maxFileSize} limit`,
        { status: 413, code: "file_too_large" },
      );
    }
  }

  // A rejection, not a downscale: `maxImageDimensions` is the guard against a
  // 60000x60000 decompression bomb, and quietly resizing one would mean
  // decoding it first, which is the part that costs the memory.
  const maxDimensions = limits?.maxImageDimensions;
  if (probed && maxDimensions) {
    if (
      probed.width > maxDimensions.width ||
      probed.height > maxDimensions.height
    ) {
      // prettier-ignore
      throw new CmsError(
        `"${options.filename}" is ${probed.width}x${probed.height}, over the ${maxDimensions.width}x${maxDimensions.height} limit`,
        { status: 422, code: "image_too_large" },
      );
    }
  }

  let data = options.bytes;
  let info = probed;
  let type = contentType;

  if (probed && images) {
    const rendered = await renderOriginal(data, probed, images, type);
    data = rendered.data;
    info = rendered.info;
    type = rendered.contentType;
  }

  return {
    data,
    contentType: type,
    filename: sanitiseFilename(options.filename),
    info,
    // SHA-256 of what was actually stored, so "is this the same file" is
    // answerable after a conversion rather than only before one.
    checksum: hex(await sha256(data)),
    extension: extensionFor(type),
  };
}

interface RenderedOriginal {
  data: Uint8Array;
  info: ImageInfo;
  contentType: string;
}

/**
 * The original as it will be stored.
 *
 * `maxDimensions` is the important one: it is a hard ceiling on what enters
 * the bucket, so a 12-megapixel phone photograph does not become the thing
 * every variant is rendered from for the next five years.
 */
async function renderOriginal(
  bytes: Uint8Array,
  info: ImageInfo,
  images: ImagesConfig,
  contentType: string,
): Promise<RenderedOriginal> {
  const processor = images.processor;
  const transform: ImageTransform = {};

  const convert = images.convert;
  if (
    convert &&
    !(convert.keep ?? []).includes(contentType) &&
    // Converting an SVG to WebP turns a vector into pixels; it is a drawing,
    // not a photograph, and no sensible default rasterises one.
    info.format !== "svg"
  ) {
    transform.format = convert.to;
  }

  const max = images.maxDimensions;
  if (max && (info.width > max.width || info.height > max.height)) {
    transform.width = max.width;
    transform.height = max.height;
    transform.fit = "inside";
  }
  if (images.quality !== undefined) transform.quality = images.quality;

  const needsProcessor =
    transform.format !== undefined || transform.width !== undefined;

  if (needsProcessor && processor && processor.supports(contentType)) {
    if (images.stripMetadata !== false) transform.stripMetadata = true;
    const result = await processor.transform(bytes, transform, info);
    return {
      data: result.data,
      contentType: result.contentType,
      info: {
        format: info.format,
        contentType: result.contentType,
        width: result.width,
        height: result.height,
      },
    };
  }

  // No processor, or one that does not handle this type: the bytes go in
  // untouched, except that privacy does not get to be optional.
  const stripped =
    images.stripMetadata === true
      ? stripImageMetadata(bytes, contentType)
      : bytes;
  return { data: stripped, info, contentType };
}

/**
 * The MIME whitelist.
 *
 * Checked against what the bytes say, so `evil.svg` renamed to `photo.png`
 * is still an SVG here and is still refused where SVGs are not accepted.
 */
function assertAccepted(
  contentType: string,
  accept: string[] | undefined,
): void {
  if (!accept || accept.length === 0) return;
  if (accept.some((pattern) => matchesMime(contentType, pattern))) return;
  throw new CmsError(
    `"${contentType}" is not an accepted file type; uploads.limits.accept allows ${accept.join(", ")}`,
    { status: 415, code: "unsupported_media_type" },
  );
}

export function matchesMime(contentType: string, pattern: string): boolean {
  const value = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  const wanted = pattern.toLowerCase().trim();
  if (wanted === "*" || wanted === "*/*") return true;
  if (wanted.endsWith("/*")) return value.startsWith(wanted.slice(0, -1));
  return value === wanted;
}

function resolveContentType(
  declared: string,
  probed: ImageInfo | null,
): string {
  if (probed) return probed.contentType;
  const value = declared.split(";")[0]?.trim().toLowerCase();
  return value && value.includes("/") ? value : "application/octet-stream";
}

/**
 * A filename that is safe to show, log and put in a header.
 *
 * It is never used to build a storage key — those are derived from the id —
 * so this is about display and `content-disposition`, not about traversal.
 */
export function sanitiseFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "file";
  const cleaned = base
    .replaceAll("\0", "")
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : "file";
}

function format(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
