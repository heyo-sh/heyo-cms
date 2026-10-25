import { CmsError } from "../errors";
import type { ImageSizeConfig, ImagesConfig } from "../types/config";
import type {
  ImageProcessor,
  ImageTransform,
  MediaDocument,
  ProcessedImage,
} from "../types/media";
import { extensionFor } from "./probe";

/**
 * Named sizes, and where they come from.
 *
 * Two strategies, one code path. `pregenerate` renders at upload time and
 * `on-demand` renders at first request, but both write the result into storage
 * under the same deterministic key — so a size added to the configuration next
 * year applies to the whole archive either way, and the second request for it
 * is a storage hit rather than a render (section 6).
 */

export function variantNames(images: ImagesConfig | undefined): string[] {
  return Object.keys(images?.variants?.sizes ?? {});
}

export function variantSize(
  images: ImagesConfig | undefined,
  name: string,
): ImageSizeConfig {
  const size = images?.variants?.sizes?.[name];
  if (!size) {
    const available = variantNames(images);
    throw CmsError.notFound(
      available.length > 0
        ? `No image size named "${name}"; this configuration declares ${available.join(", ")}`
        : `No image size named "${name}"; this configuration declares none`,
    );
  }
  return size;
}

/**
 * The rendering request for one named size on one file.
 *
 * The focal point and the crop come from the file, not from the size: a size
 * says "320 square, cover", and which 320 square pixels that is, is a decision
 * the editor made once in the panel and that every size inherits.
 */
export function variantTransform(
  images: ImagesConfig | undefined,
  name: string,
  media: Pick<MediaDocument, "focalPoint" | "crop" | "mimeType">,
): ImageTransform {
  const size = variantSize(images, name);
  const transform: ImageTransform = {
    ...(size.width === undefined ? {} : { width: size.width }),
    ...(size.height === undefined ? {} : { height: size.height }),
    ...(size.fit === undefined ? {} : { fit: size.fit }),
  };

  if (images?.quality !== undefined) transform.quality = images.quality;
  if (images?.stripMetadata !== false) transform.stripMetadata = true;

  if (images?.focalPoint !== false && media.focalPoint) {
    transform.position = media.focalPoint;
  }
  if (images?.crop !== false && media.crop) transform.crop = media.crop;

  const convert = images?.convert;
  if (convert && !(convert.keep ?? []).includes(media.mimeType)) {
    transform.format = convert.to;
  }
  return transform;
}

/**
 * Whether rendering this transform would give back the original's pixels.
 *
 * Only the fits that never crop are considered: `inside` (the default) and
 * `outside` leave an image alone when it is already within the box, and
 * every processor here refuses to enlarge. `cover` and `contain` change the
 * aspect ratio, and the two processors disagree about what they do to an
 * image smaller than the box, so those are always rendered. A crop always
 * changes the pixels; a format change is the caller's to check.
 */
export function isIdentityTransform(
  transform: ImageTransform,
  media: Pick<MediaDocument, "width" | "height">,
): boolean {
  const { width, height } = media;
  if (width === null || height === null || width <= 0 || height <= 0) {
    return false;
  }
  if (transform.crop) {
    const crop = transform.crop;
    const whole =
      crop.x <= 0 && crop.y <= 0 && crop.width >= width && crop.height >= height; // prettier-ignore
    if (!whole) return false;
  }

  const fit = transform.fit ?? "inside";
  const w = transform.width;
  const h = transform.height;
  if (w === undefined && h === undefined) return true;
  if (fit === "inside") {
    return (w === undefined || w >= width) && (h === undefined || h >= height);
  }
  if (fit === "outside") {
    // The smallest scale covering the box; at 1 or more nothing shrinks.
    const scale = Math.max(
      w === undefined ? 0 : w / width,
      h === undefined ? 0 : h / height,
    );
    return scale >= 1;
  }
  return false;
}

/** The content type a variant will have, before anything is rendered. */
export function variantContentType(
  images: ImagesConfig | undefined,
  mimeType: string,
): string {
  const convert = images?.convert;
  if (!convert || (convert.keep ?? []).includes(mimeType)) return mimeType;
  return `image/${convert.to}`;
}

/**
 * Where a variant lives.
 *
 * Derived from the original's key rather than recorded, so the collector can
 * find every derivative of a file it is about to delete without a second
 * table — and so two processes rendering the same variant at the same time
 * write the same object instead of two.
 */
export function variantKey(
  storageKey: string,
  name: string,
  contentType: string,
): string {
  const slash = storageKey.lastIndexOf("/");
  const dot = storageKey.lastIndexOf(".");
  const base = dot > slash ? storageKey.slice(0, dot) : storageKey;
  return `${base}/${name}.${extensionFor(contentType)}`;
}

/**
 * The query a CDN would need to do this itself.
 *
 * Appended to the original's URL when no processor is configured: that is the
 * `cdn-worker` arrangement from section 6, where the CMS owns one original and
 * the edge owns the resizing. The parameters are the ones every image CDN
 * understands, so the same URL works behind Cloudflare, Vercel or a Worker of
 * your own.
 */
export function variantQuery(
  images: ImagesConfig | undefined,
  name: string,
): string {
  const size = variantSize(images, name);
  const parameters = new URLSearchParams();
  if (size.width !== undefined) parameters.set("w", String(size.width));
  if (size.height !== undefined) parameters.set("h", String(size.height));
  if (size.fit !== undefined) parameters.set("fit", size.fit);
  if (images?.quality !== undefined) {
    parameters.set("q", String(images.quality));
  }
  return parameters.toString();
}

/**
 * Renders one variant, or explains why it cannot.
 *
 * A processor that does not handle this type is not an error — an SVG asked
 * for at thumbnail size is simply served as it is, because it already scales.
 */
export async function renderVariant(
  processor: ImageProcessor | undefined,
  source: Uint8Array,
  transform: ImageTransform,
  media: Pick<MediaDocument, "mimeType" | "width" | "height">,
): Promise<ProcessedImage | null> {
  if (!processor || !processor.supports(media.mimeType)) return null;
  return processor.transform(source, transform, {
    format: (media.mimeType.split("/")[1] ?? "jpeg") as never,
    contentType: media.mimeType,
    width: media.width ?? 0,
    height: media.height ?? 0,
  });
}
