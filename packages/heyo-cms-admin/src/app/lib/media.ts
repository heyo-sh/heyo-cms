import type { MediaDocument, MediaStatus } from "@heyo-sh/heyo-cms/types";

import { api, mediaUrl } from "./api";

/**
 * The media endpoints, in the three shapes the panel uses them.
 *
 * Kept out of the components because both the library screen and the field
 * picker upload files, and an upload that behaves differently depending on
 * where it was started is a bug waiting for a deadline.
 */

export interface MediaPage {
  docs: MediaDocument[];
  limit: number;
  hasNextPage: boolean;
  cursor: string | null;
}

export interface MediaQuery {
  status?: MediaStatus;
  search?: string;
  mimeType?: string;
  cursor?: string;
  limit?: number;
}

export function listMedia(
  query: MediaQuery,
  signal?: AbortSignal,
): Promise<MediaPage> {
  return api.get<MediaPage>("/media", {
    query: { ...query },
    ...(signal ? { signal } : {}),
  });
}

/**
 * One file, uploaded as multipart.
 *
 * The MIME type is taken from the bytes by the server, not from what the
 * browser called them, so there is nothing to declare here beyond the file
 * itself and the alternative text if the editor typed one.
 */
export async function uploadMedia(
  file: File,
  options: { alt?: string; locale?: string } = {},
): Promise<MediaDocument> {
  const form = new FormData();
  form.set("file", file);
  form.set("filename", file.name);
  if (options.alt) form.set("alt", options.alt);
  if (options.locale) form.set("locale", options.locale);
  return api.post<MediaDocument>("/media/upload", { form });
}

export function isImage(file: MediaDocument): boolean {
  return file.mimeType.startsWith("image/");
}

/**
 * The URL to show in the panel.
 *
 * A declared size when the deployment has one — a library of originals is
 * how a grid of twenty files becomes forty megabytes — and the original
 * otherwise, since only declared sizes may be requested.
 */
export function previewUrl(
  file: MediaDocument,
  variants: string[],
  preferred = "thumb",
): string {
  if (!isImage(file)) return mediaUrl(file.id);
  const size = variants.includes(preferred)
    ? preferred
    : (variants[0] ?? undefined);
  return mediaUrl(file.id, size);
}

/** Alternative text in the locale being edited, falling back to any. */
export function altText(file: MediaDocument, locale: string): string {
  return file.alt[locale] ?? Object.values(file.alt)[0] ?? "";
}
