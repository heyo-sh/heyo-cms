import { CmsError } from "../errors";
import type {
  ImageInfo,
  ImageProcessor,
  ImageTransform,
  ProcessedImage,
} from "../types/media";
import { probeImage } from "./probe";
import { sourceRegion } from "./sharp";

/**
 * The image processor for Cloudflare Workers, backed by the Images binding.
 *
 * A Worker cannot load `sharp` — no native modules, ever — but the runtime
 * itself can resize and convert: `env.IMAGES` decodes and re-encodes inside
 * workerd, costs no subrequest to leave for, and exists in `wrangler dev`.
 * With it, `convert: { to: "webp" }`, `maxDimensions` and `pregenerate`
 * work on Workers as they do on Node with `sharpImages()`.
 *
 * `wrangler dev` simulates the binding locally, and the simulator ignores
 * `trim` and `gravity` coordinates: resizing, fitting and conversion work, a
 * crop or a focal point does not. `"remote": true` on the binding uses the
 * real service instead.
 *
 * The binding is typed structurally, like the R2 and D1 ones, so this module
 * needs no SDK and loads on every runtime; it only refuses at transform time,
 * when it is asked for pixels and has no binding to render them with.
 *
 * ```jsonc
 * // wrangler.json
 * { "images": { "binding": "IMAGES" } }
 * ```
 * ```ts
 * processor: cloudflareImages(() => env.IMAGES)
 * ```
 */

/** The input formats the binding decodes. SVG and TIFF are not among them. */
const supported = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** The Workers Images binding, structurally. Typing it avoids depending on the types. */
export interface CloudflareImagesBinding {
  input(image: ReadableStream<Uint8Array>): CloudflareImageTransformer;
}

export interface CloudflareImageTransformer {
  transform(options: Record<string, unknown>): CloudflareImageTransformer;
  output(options: Record<string, unknown>): Promise<CloudflareImageOutput>;
}

export interface CloudflareImageOutput {
  contentType(): string;
  image(): ReadableStream<Uint8Array>;
}

/**
 * The binding, or where to get it.
 *
 * A function, usually: the processor is constructed while the configuration
 * module loads, and on Workers the bindings only exist once a request (or the
 * `cloudflare:workers` module) hands them over. Returning `undefined` is
 * allowed — that is "this runtime has no binding", reported as an error only
 * if something actually asks for pixels.
 */
export type CloudflareImagesSource =
  | CloudflareImagesBinding
  | (() =>
      | CloudflareImagesBinding
      | undefined
      | Promise<CloudflareImagesBinding | undefined>);

export function cloudflareImages(
  source: CloudflareImagesSource,
): ImageProcessor {
  return {
    id: "cloudflare-images",
    supports: (contentType) => supported.has(contentType.toLowerCase()),

    async transform(
      bytes: Uint8Array,
      transform: ImageTransform,
      info: ImageInfo,
    ): Promise<ProcessedImage> {
      const binding = typeof source === "function" ? await source() : source;
      if (!binding) {
        throw new CmsError(
          'cloudflareImages() has no Images binding: add `"images": { "binding": "IMAGES" }` to wrangler.json and pass the binding (or a function returning it) to cloudflareImages().',
          { status: 500, code: "image_processor_missing" },
        );
      }

      const plan = cloudflareTransform(info, transform);
      let pipeline = binding.input(streamOf(bytes));
      if (plan.options) pipeline = pipeline.transform(plan.options);

      // The binding re-encodes, which strips EXIF as a side effect; there is
      // no knob for `stripMetadata: false` here, and losing embedded GPS
      // coordinates by default is the behaviour this project wants anyway.
      const output = await pipeline.output({
        format: transform.format
          ? `image/${transform.format}`
          : normalise(info.contentType),
        ...(transform.quality === undefined ? {} : { quality: transform.quality }), // prettier-ignore
      });

      const data = new Uint8Array(
        await new Response(output.image()).arrayBuffer(),
      );
      // The binding reports a content type but not dimensions, so read them
      // from the bytes it produced — the same header probe the upload
      // pipeline uses — and fall back to the arithmetic of the plan.
      const probed = probeImage(data);
      return {
        data,
        contentType: output.contentType(),
        width: probed?.width ?? plan.width,
        height: probed?.height ?? plan.height,
      };
    },
  };
}

export interface CloudflarePlan {
  /** What to pass to `.transform()`, or null when only re-encoding. */
  options: Record<string, unknown> | null;
  /** The dimensions the output should have, for when the probe cannot say. */
  width: number;
  height: number;
}

/**
 * One `ImageTransform`, translated into the binding's vocabulary.
 *
 * The crop and the focal point are resolved here rather than delegated:
 * `sourceRegion` already turns both into a single rectangle of the original
 * (the exact logic the sharp processor uses, tested in isolation), and that
 * rectangle becomes a `trim` — pixels removed from each edge — which is the
 * form Cloudflare accepts.
 *
 * The fit names do not line up one to one, and two of them are false friends:
 *
 * | heyo-cms (sharp)       | Cloudflare       |
 * | ---------------------- | ---------------- |
 * | `inside` (default)     | `scale-down`     |
 * | `contain` (letterbox)  | `pad`            |
 * | `cover`                | `cover`, clamped |
 * | `outside`              | computed + `scale-down` |
 *
 * `scale-down` never enlarges, which matches the `withoutEnlargement` the
 * sharp processor always sets; `cover` would enlarge, so the requested box is
 * shrunk to the source first — a 400px logo asked for at 1920 stays 400px.
 */
export function cloudflareTransform(
  info: ImageInfo,
  transform: ImageTransform,
): CloudflarePlan {
  const options: Record<string, unknown> = {};

  const region = sourceRegion(info.width, info.height, transform);
  const sourceWidth = region?.width ?? info.width;
  const sourceHeight = region?.height ?? info.height;
  if (region) {
    options.trim = {
      left: region.left,
      top: region.top,
      right: info.width - region.left - region.width,
      bottom: info.height - region.top - region.height,
    };
  }

  let width = sourceWidth;
  let height = sourceHeight;
  const w = transform.width;
  const h = transform.height;
  const fit = transform.fit ?? "inside";

  if (w !== undefined || h !== undefined) {
    if (fit === "cover" && w !== undefined && h !== undefined) {
      const scale = Math.max(w / sourceWidth, h / sourceHeight);
      width = scale > 1 ? Math.max(1, Math.round(w / scale)) : w;
      height = scale > 1 ? Math.max(1, Math.round(h / scale)) : h;
      Object.assign(options, { width, height, fit: "cover" });
    } else if (fit === "contain" && w !== undefined && h !== undefined) {
      width = w;
      height = h;
      Object.assign(options, { width, height, fit: "pad" });
    } else if (fit === "outside") {
      // Cloudflare has no "at least this box", so compute the result — the
      // smallest no-crop resize covering the box, never enlarged — and ask
      // for it exactly.
      const scale = Math.min(
        1,
        Math.max(w === undefined ? 0 : w / sourceWidth, h === undefined ? 0 : h / sourceHeight), // prettier-ignore
      );
      width = Math.max(1, Math.round(sourceWidth * scale));
      height = Math.max(1, Math.round(sourceHeight * scale));
      Object.assign(options, { width, height, fit: "scale-down" });
    } else {
      // "inside", a one-sided box, or a "cover" missing a side (which the
      // configuration validator refuses anyway): fit within, never enlarge.
      const scale = Math.min(
        w === undefined ? Infinity : w / sourceWidth,
        h === undefined ? Infinity : h / sourceHeight,
        1,
      );
      width = Math.max(1, Math.round(sourceWidth * scale));
      height = Math.max(1, Math.round(sourceHeight * scale));
      Object.assign(options, {
        ...(w === undefined ? {} : { width: w }),
        ...(h === undefined ? {} : { height: h }),
        fit: "scale-down",
      });
    }
  }

  return {
    options: Object.keys(options).length > 0 ? options : null,
    width,
    height,
  };
}

function normalise(contentType: string): string {
  const value = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return value === "image/jpg" ? "image/jpeg" : value;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
