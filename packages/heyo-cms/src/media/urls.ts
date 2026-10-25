import { slugify } from "../slugify";
import { trimTrailingSlashes } from "../strings";
import type { ImagesConfig, ResolvedCmsConfig } from "../types/config";
import type {
  MediaDocument,
  MediaImage,
  MediaImageInput,
  MediaImageOptions,
  MediaSrcsetOptions,
  MediaUrlInput,
  MediaUrlOptions,
} from "../types/media";
import { extensionFor } from "./probe";
import {
  isIdentityTransform,
  variantContentType,
  variantQuery,
  variantSize,
  variantTransform,
} from "./variants";

/**
 * Where a file is served from, and what an `<img>` needs to show it well.
 *
 * Everything here is arithmetic on the configuration and the `media` row: no
 * storage call, no rendering, no database. That is what lets a page with
 * forty pictures build forty `srcset`s without forty round trips — the sizes
 * a variant *will* have are known before it has ever been rendered, because
 * the processors never enlarge and the fits are deterministic.
 */

/**
 * The file name in a public URL: the uploaded name, as a slug, with the
 * extension of what is actually served.
 *
 * Only for people and image search, which reads it; the route ignores it.
 * The extension follows the content type rather than the upload, so a PNG
 * converted to WebP is `diagram.webp` and not a `.png` that is not one.
 */
export function publicFileName(
  media: Pick<MediaDocument, "filename">,
  contentType: string,
): string {
  const base = media.filename.replace(/\.[^.]*$/, "");
  return `${slugify(base) || "file"}.${extensionFor(contentType)}`;
}

/**
 * The address of the original under `uploads.publicPath`, or null without one.
 *
 * Kept separate from `mediaUrl` because `toMediaDocument` needs it and has no
 * use for the rest: `MediaDocument.url` is this, when the deployment serves
 * its own files.
 */
export function publicOriginalUrl(
  publicPath: string | undefined,
  media: Pick<MediaDocument, "id" | "filename" | "mimeType">,
): string | null {
  if (!publicPath) return null;
  return `${trimTrailingSlashes(publicPath)}/${encodeURIComponent(media.id)}/${publicFileName(media, media.mimeType)}`;
}

/**
 * `cms.media.url()`.
 *
 * With `uploads.publicPath`:
 *
 *   /media/med_…/condition-report.png             the original
 *   /media/med_…/card/condition-report.webp       a declared size
 *
 * Without it, the CMS's own API route, `<basePath>/media/med_…/card`. A size
 * nothing here can render — no processor, or an SVG — is the original's URL
 * with the size in the query, which is what an image CDN in front of the
 * deployment reads. A size that would not change the picture is the
 * original's URL outright, so the browser reuses what it already has.
 */
export function mediaUrl(
  config: ResolvedCmsConfig,
  media: MediaUrlInput,
  options: MediaUrlOptions = {},
): string {
  const images = config.uploads?.images;
  const publicPath = config.uploads?.publicPath;
  const name = options.variant;
  const original =
    publicOriginalUrl(publicPath, media) ??
    `${apiMediaBase(config)}/${encodeURIComponent(media.id)}/original`;
  if (name === undefined || name === "original") return original;

  // Validates the name: an undeclared size is a bug at the call site, and a
  // URL that 404s on every page is a worse place to find it than here.
  variantSize(images, name);

  const processor = images?.processor;
  if (!processor || !processor.supports(media.mimeType)) {
    return `${original}?${variantQuery(images, name)}`;
  }
  const contentType = variantContentType(images, media.mimeType);
  if (
    contentType === media.mimeType &&
    isIdentityTransform(
      variantTransform(images, name, {
        mimeType: media.mimeType,
        crop: media.crop ?? null,
        focalPoint: media.focalPoint ?? null,
      }),
      { width: media.width ?? null, height: media.height ?? null },
    )
  ) {
    return original;
  }
  if (publicPath) {
    return `${trimTrailingSlashes(publicPath)}/${encodeURIComponent(media.id)}/${encodeURIComponent(name)}/${publicFileName(media, contentType)}`;
  }
  return `${apiMediaBase(config)}/${encodeURIComponent(media.id)}/${encodeURIComponent(name)}`;
}

function apiMediaBase(config: ResolvedCmsConfig): string {
  const base = config.basePath === "/" ? "" : trimTrailingSlashes(config.basePath); // prettier-ignore
  return `${base}/media`;
}

/**
 * The pixel size a named size will have for this file, before it exists.
 *
 * The same arithmetic the processors perform: the crop first, then the fit,
 * never enlarging. Null when the file has no known dimensions (not an image,
 * or one whose header could not be read).
 */
export function variantDimensions(
  images: ImagesConfig | undefined,
  name: string,
  media: Pick<MediaUrlInput, "width" | "height" | "crop">,
): { width: number; height: number } | null {
  const source = sourceSize(media);
  if (!source) return null;
  const size = variantSize(images, name);
  const w = size.width;
  const h = size.height;
  const fit = size.fit ?? "inside";
  if (w === undefined && h === undefined) return source;

  if (
    (fit === "cover" || fit === "contain") &&
    w !== undefined &&
    h !== undefined
  ) {
    // prettier-ignore
    if (fit === "contain") return { width: w, height: h };
    // The box, shrunk to the source when it is larger: never enlarged, and
    // still the box's aspect ratio.
    const scale = Math.max(w / source.width, h / source.height);
    return scale > 1
      ? {
          width: Math.max(1, Math.round(w / scale)),
          height: Math.max(1, Math.round(h / scale)),
        }
      : { width: w, height: h };
  }

  const scale =
    fit === "outside"
      ? Math.min(
          1,
          Math.max(
            w === undefined ? 0 : w / source.width,
            h === undefined ? 0 : h / source.height,
          ),
        )
      : Math.min(
          w === undefined ? Infinity : w / source.width,
          h === undefined ? Infinity : h / source.height,
          1,
        );
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/**
 * `cms.media.srcset()`: the declared sizes that keep the picture's shape, as
 * a width-descriptor list, with the original at the top end.
 *
 * Only sizes that do not change the aspect ratio belong in one `srcset` —
 * the browser assumes every candidate is the same picture — so a `cover`
 * square is left out unless asked for by name. Sizes the file is too small
 * for collapse into the original. With a crop the original is not the same
 * picture as its sizes, so it is left out and the largest size tops the list.
 *
 * Null when there is nothing to choose between: a vector, a file with no
 * known width, or a configuration without sizes.
 */
export function mediaSrcset(
  config: ResolvedCmsConfig,
  media: MediaUrlInput,
  options: MediaSrcsetOptions = {},
): string | null {
  const entries = srcsetEntries(config, media, options);
  return entries.length < 2
    ? null
    : entries.map((entry) => `${entry.url} ${entry.width}w`).join(", ");
}

interface SrcsetEntry {
  url: string;
  width: number;
  height: number;
}

function srcsetEntries(
  config: ResolvedCmsConfig,
  media: MediaUrlInput,
  options: MediaSrcsetOptions,
): SrcsetEntry[] {
  const images = config.uploads?.images;
  const declared = images?.variants?.sizes ?? {};
  if (!isRaster(media.mimeType) || !media.width || !media.height) return [];

  const names =
    options.sizes ??
    Object.entries(declared)
      .filter(([, size]) => keepsShape(size))
      .map(([name]) => name);

  const cropped = media.crop !== null && media.crop !== undefined;
  const entries: SrcsetEntry[] = [];
  const widths = new Set<number>();
  const original = sourceSize(media);

  if (!cropped && original) {
    entries.push({ url: mediaUrl(config, media), ...original });
    widths.add(original.width);
  }
  for (const name of names) {
    const dimensions = variantDimensions(images, name, media);
    if (!dimensions || widths.has(dimensions.width)) continue;
    widths.add(dimensions.width);
    entries.push({
      url: mediaUrl(config, media, { variant: name }),
      ...dimensions,
    });
  }
  return entries.sort((a, b) => a.width - b.width);
}

/**
 * `cms.media.image()`: everything an `<img>` needs for one file.
 *
 * Width and height are always the ones of the `src` — that is what the
 * browser reserves space with before a byte arrives, and a wrong ratio there
 * is the layout shift it exists to prevent.
 */
export function mediaImage(
  config: ResolvedCmsConfig,
  media: MediaImageInput,
  options: MediaImageOptions = {},
): MediaImage {
  const images = config.uploads?.images;
  const alt = altText(config, media.alt, options.locale);
  const sizes = options.sizes ?? null;

  if (options.variant !== undefined && options.variant !== "original") {
    const dimensions = variantDimensions(images, options.variant, media);
    return {
      src: mediaUrl(config, media, { variant: options.variant }),
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      srcset: null,
      sizes: null,
      alt,
    };
  }

  const entries = srcsetEntries(
    config,
    media,
    options.srcset === undefined ? {} : { sizes: options.srcset },
  );
  const cropped = media.crop !== null && media.crop !== undefined;
  // With a crop the original shows what the editor cut away, so the largest
  // size stands in for it.
  const top = cropped ? entries.at(-1) : undefined;
  return {
    src: top?.url ?? mediaUrl(config, media),
    width: top?.width ?? media.width ?? null,
    height: top?.height ?? media.height ?? null,
    srcset:
      entries.length < 2
        ? null
        : entries.map((entry) => `${entry.url} ${entry.width}w`).join(", "),
    sizes: entries.length < 2 ? null : sizes,
    alt,
  };
}

function altText(
  config: ResolvedCmsConfig,
  alt: Record<string, string> | undefined,
  locale: string | undefined,
): string | null {
  if (!alt) return null;
  const value =
    (locale === undefined ? undefined : alt[locale]) ??
    alt[config.i18n.defaultLocale];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function sourceSize(
  media: Pick<MediaUrlInput, "width" | "height" | "crop">,
): { width: number; height: number } | null {
  if (media.crop) {
    return { width: media.crop.width, height: media.crop.height };
  }
  if (!media.width || !media.height) return null;
  return { width: media.width, height: media.height };
}

function keepsShape(size: { width?: number; height?: number; fit?: string }) {
  const fit = size.fit ?? "inside";
  if (fit === "inside" || fit === "outside") return true;
  return size.width === undefined || size.height === undefined;
}

function isRaster(mimeType: string): boolean {
  return mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
}
