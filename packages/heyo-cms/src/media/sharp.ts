import { CmsError } from "../errors";
import type {
  ImageInfo,
  ImageProcessor,
  ImageTransform,
  ProcessedImage,
} from "../types/media";

/**
 * The reference image processor, backed by `sharp`.
 *
 * Optional on purpose. `sharp` is a native module: it cannot load in a Worker,
 * it adds tens of megabytes to an installation that budgeted thirty for all of
 * itself, and a deployment that resizes at the edge has no use for it. So it
 * is a peer dependency, imported the first time something actually asks for a
 * pixel, and absent until then.
 *
 * Everything the engine can do without a codec — reading dimensions,
 * enforcing `maxImageDimensions`, stripping EXIF — it already does itself.
 */

const supported = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/tiff",
]);

export interface SharpImagesOptions {
  /**
   * The decompression-bomb ceiling, in pixels.
   *
   * `sharp` defaults to roughly 268 megapixels. The upload pipeline already
   * refuses anything over `uploads.limits.maxImageDimensions`, so this is the
   * second fence rather than the first.
   */
  limitInputPixels?: number | false;
  /**
   * Honour the EXIF orientation flag before doing anything else.
   *
   * On by default, and it matters: a phone photograph is stored sideways with
   * a flag saying so, and stripping metadata without applying the flag first
   * turns every portrait into a landscape.
   */
  autoOrient?: boolean;
}

interface SharpInstance {
  rotate(): SharpInstance;
  extract(region: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): SharpInstance;
  resize(options: Record<string, unknown>): SharpInstance;
  toFormat(format: string, options?: Record<string, unknown>): SharpInstance;
  keepMetadata(): SharpInstance;
  toBuffer(options: { resolveWithObject: true }): Promise<{
    data: Uint8Array;
    info: { width: number; height: number; format: string };
  }>;
}

type SharpFactory = (
  input: Uint8Array,
  options?: Record<string, unknown>,
) => SharpInstance;

let loading: Promise<SharpFactory> | undefined;

async function loadSharp(): Promise<SharpFactory> {
  loading ??= (async () => {
    // A variable specifier, so neither the type checker nor the bundler tries
    // to resolve a package that is allowed not to be there.
    const specifier: string = "sharp";
    try {
      const module = (await import(specifier)) as {
        default?: SharpFactory;
      } & SharpFactory;
      return module.default ?? module;
    } catch {
      throw new CmsError(
        "sharpImages() needs the optional `sharp` package; install it, or configure uploads.images without transformations.",
        { status: 500, code: "image_processor_missing" },
      );
    }
  })();
  return loading;
}

export function sharpImages(options: SharpImagesOptions = {}): ImageProcessor {
  return {
    id: "sharp",
    supports: (contentType) => supported.has(contentType.toLowerCase()),

    async transform(
      source: Uint8Array,
      transform: ImageTransform,
      info: ImageInfo,
    ): Promise<ProcessedImage> {
      const sharp = await loadSharp();
      let pipeline = sharp(source, {
        ...(options.limitInputPixels === undefined
          ? {}
          : { limitInputPixels: options.limitInputPixels }),
      });

      if (options.autoOrient !== false) pipeline = pipeline.rotate();

      let width = info.width;
      let height = info.height;

      // Crop coordinates and the focal point both refer to the ORIGINAL.
      // Resolve them into one extraction: a focal point outside the crop is
      // clamped to the closest possible cover frame inside that crop.
      const region = sourceRegion(width, height, transform);
      if (region) {
        pipeline = pipeline.extract(region);
        width = region.width;
        height = region.height;
      }

      if (transform.width !== undefined || transform.height !== undefined) {
        pipeline = pipeline.resize({
          ...(transform.width === undefined ? {} : { width: transform.width }),
          ...(transform.height === undefined ? {} : { height: transform.height }), // prettier-ignore
          fit: transform.fit ?? "inside",
          // Never scale a small image up to fill a large box: a 400px logo
          // asked for at 1920 should stay 400px rather than become blurry.
          withoutEnlargement: true,
        });
      }

      const format = transform.format ?? formatOf(info.contentType);
      pipeline = pipeline.toFormat(format, {
        ...(transform.quality === undefined ? {} : { quality: transform.quality }), // prettier-ignore
      });

      // `sharp` drops metadata unless told otherwise, which is the behaviour
      // this project wants by default (section 6).
      if (transform.stripMetadata === false) pipeline = pipeline.keepMetadata();

      const result = await pipeline.toBuffer({ resolveWithObject: true });
      return {
        data: result.data,
        contentType: `image/${result.info.format}`,
        width: result.info.width,
        height: result.info.height,
      };
    },
  };
}

/** The rectangle of the source that a cover crop should keep. */
export function sourceRegion(
  width: number,
  height: number,
  transform: ImageTransform,
): { left: number; top: number; width: number; height: number } | null {
  if (width <= 0 || height <= 0) return null;
  const crop = transform.crop && clampRegion(transform.crop, width, height);
  const bounds = crop || { left: 0, top: 0, width, height };
  const focal =
    transform.fit === "cover" &&
    transform.position &&
    transform.width &&
    transform.height
      ? focalRegion(
          bounds.width,
          bounds.height,
          transform.width / transform.height,
          {
            x: (transform.position.x * width - bounds.left) / bounds.width,
            y: (transform.position.y * height - bounds.top) / bounds.height,
          },
        )
      : null;
  if (!focal) return crop || null;
  return {
    left: bounds.left + focal.left,
    top: bounds.top + focal.top,
    width: focal.width,
    height: focal.height,
  };
}

function focalRegion(
  width: number,
  height: number,
  targetAspect: number,
  focal: { x: number; y: number },
): { left: number; top: number; width: number; height: number } | null {
  if (
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(targetAspect) ||
    targetAspect <= 0
  )
    return null;
  const sourceAspect = width / height;

  const cropWidth =
    sourceAspect > targetAspect
      ? clamp(Math.round(height * targetAspect), 1, width)
      : width;
  const cropHeight =
    sourceAspect > targetAspect
      ? height
      : clamp(Math.round(width / targetAspect), 1, height);
  if (cropWidth >= width && cropHeight >= height) return null;

  return {
    left: clamp(Math.round(focal.x * width - cropWidth / 2), 0, width - cropWidth), // prettier-ignore
    top: clamp(Math.round(focal.y * height - cropHeight / 2), 0, height - cropHeight), // prettier-ignore
    width: cropWidth,
    height: cropHeight,
  };
}

function clampRegion(
  crop: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } | null {
  const left = clamp(Math.round(crop.x), 0, Math.max(width - 1, 0));
  const top = clamp(Math.round(crop.y), 0, Math.max(height - 1, 0));
  const cropWidth = clamp(Math.round(crop.width), 1, width - left);
  const cropHeight = clamp(Math.round(crop.height), 1, height - top);
  if (cropWidth <= 0 || cropHeight <= 0) return null;
  return { left, top, width: cropWidth, height: cropHeight };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function formatOf(contentType: string): string {
  const subtype = contentType.split("/")[1] ?? "jpeg";
  return subtype === "jpg" ? "jpeg" : subtype;
}
