import { renderRichText } from "../editor/index";
import { richTextMedia } from "../media/usages";
import { CmsError } from "../errors";
import type { ResolvedCollection } from "../types/config";
import type { RichTextFormat, RichTextMediaImage } from "../types/editor";
import type { CmsInstance } from "../types/instance";
import type { JsonObject, JsonValue } from "../types/json";

/**
 * `?richText=html` on a read.
 *
 * The reason this exists is the one `defineEditorNode()` enforces: a
 * ProseMirror document is useless to a consumer that has no ProseMirror. A
 * static site generator, an RSS feed, a mail template and a search index all
 * want the same thing, and without this each of them writes its own
 * half-correct renderer against a tree they do not control.
 *
 * It is opt-in and not the default, because the document *is* the stored
 * value: a client that writes back what it read must get back what is
 * stored, and a response that silently replaced a document with a string
 * would make `GET` then `PATCH` destructive.
 */
export function richTextFormat(
  value: string | null,
): RichTextFormat | undefined {
  if (value === null || value === "") return undefined;
  if (value === "html" || value === "markdown" || value === "text") {
    return value;
  }
  throw CmsError.validation(
    `"${value}" is not a rich-text format; use html, markdown or text.`,
  );
}

export interface RenderOptions {
  collection: ResolvedCollection;
  format: RichTextFormat;
  /** Resolves a `mediaId` on an image node to a URL this deployment serves. */
  mediaUrl: (id: string) => string;
  /** Resolves a `mediaId` to a whole `<img>`: dimensions, `srcset`, alt. */
  mediaImage?: (id: string) => RichTextMediaImage | null;
}

/** Renders every rich-text field of one document, in place. */
export function renderDocumentRichText(
  document: JsonObject,
  options: RenderOptions,
): JsonObject {
  for (const [name, field] of Object.entries(options.collection.fields)) {
    if (field.type !== "richText") continue;
    if (!(name in document)) continue;
    const value = document[name];
    if (value === null || typeof value !== "object") continue;
    document[name] = renderRichText(value, {
      format: options.format,
      mediaUrl: options.mediaUrl,
      ...(options.mediaImage === undefined
        ? {}
        : {
            mediaImage: options.mediaImage,
            images: { loading: "lazy", decoding: "async" } as const,
          }),
    }) as JsonValue;
  }
  return document;
}

export function renderPageRichText(
  documents: JsonObject[],
  options: RenderOptions,
): void {
  for (const document of documents) renderDocumentRichText(document, options);
}

/** The URL the CMS itself serves a file from, for an image inside prose. */
export function mediaUrlResolver(basePath: string): (id: string) => string {
  return (id) => `${basePath}/media/${id}/original`;
}

/**
 * Every library image the rich-text fields of these documents show, loaded
 * in one query and described for an `<img>`.
 *
 * Undefined without `uploads`: there is no library to look in, and the
 * serialiser's plain `mediaUrl` fallback is the whole answer.
 */
export async function richTextMediaResolver(
  cms: CmsInstance,
  documents: JsonObject[],
  collection: ResolvedCollection,
  locale: string | null,
): Promise<((id: string) => RichTextMediaImage | null) | undefined> {
  if (!cms._config.uploads) return undefined;
  const ids = new Set<string>();
  for (const document of documents) {
    for (const [name, field] of Object.entries(collection.fields)) {
      if (field.type !== "richText") continue;
      const value = document[name];
      if (value === null || typeof value !== "object") continue;
      for (const id of richTextMedia(value)) ids.add(id);
    }
  }
  if (ids.size === 0) return undefined;
  const files = await cms.media.getMany([...ids]);
  return (id) => {
    const media = files.get(id);
    return media
      ? cms.media.image(media, locale === null ? {} : { locale })
      : null;
  };
}
