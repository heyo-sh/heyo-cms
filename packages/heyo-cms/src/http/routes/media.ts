import { CmsError } from "../../errors";
import type { CmsInstance } from "../../types/instance";
import type { JsonObject } from "../../types/json";
import type {
  CropRect,
  FocalPoint,
  MediaSource,
  MediaStatus,
} from "../../types/media";
import { requestSource, requirePermission } from "../guard";
import { boolean, integer } from "../params";
import { json, readJsonObject } from "../respond";
import type { RouteRecord } from "../router";
import {
  jsonBody,
  okJson,
  pathParam,
  queryParam,
  readResponses,
  ref,
  writeResponses,
} from "../spec";

/**
 * The media library over HTTP.
 *
 * Registered only when `uploads` is configured. A deployment with no storage
 * adapter has no library, and routes that exist in order to answer "add an
 * uploads section" would put that sentence in `cms.inspect().routes` as if it
 * were a feature.
 *
 * Reading is not gated by RBAC and writing is: a file's URL is public the
 * moment it is on a page, so gating reads would break anonymous rendering and
 * protect nothing that a private bucket and a signed URL do not already
 * protect (stage 6).
 */
export function mediaRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  if (!config.uploads) return [];

  const tags = ["media"];
  const sizes = Object.keys(config.uploads.images?.variants?.sizes ?? {});

  return [
    {
      method: "POST",
      path: "/media/upload",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "media:create");
        const upload = await readUpload(context.request);
        const file = await cms.media.upload({
          ...upload,
          actor: context.actor,
          source: requestSource(context.request),
        });
        return json(file, 201);
      },
      openapi: {
        summary: "Upload a file",
        description:
          "`multipart/form-data` with a `file` part, or the raw bytes with `content-type` and `x-heyo-cms-filename`. The MIME type is taken from the bytes, not from what the client called them.",
        tags,
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: {
                  file: { type: "string", format: "binary" },
                  filename: { type: "string" },
                  alt: { type: "string" },
                  locale: { type: "string" },
                  metadata: { type: "string", description: "JSON object." },
                },
              },
            },
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: {
          "201": okJson(ref("Media"), "The stored file."),
          "413": okJson(ref("Error"), "The file is larger than uploads.limits.maxFileSize."), // prettier-ignore
          "415": okJson(ref("Error"), "The MIME type is not in uploads.limits.accept."), // prettier-ignore
        },
      },
    },
    {
      method: "GET",
      path: "/media",
      source: "core",
      handler: async (context) => {
        const status = context.query.get("status");
        const mimeType = context.query.get("mimeType");
        const search = context.query.get("search");
        const cursor = context.query.get("cursor");
        const limit = integer(context.query.get("limit"), "limit", 1, 200);

        const page = await cms.media.list({
          actor: context.actor,
          ...(status === null ? {} : { status: mediaStatus(status) }),
          ...(mimeType === null ? {} : { mimeType }),
          ...(search === null ? {} : { search }),
          ...(cursor === null ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        });
        return json(page);
      },
      openapi: {
        summary: "List the library",
        tags,
        parameters: [
          queryParam("status", "string", "active, orphaned or purging.", {
            enum: ["active", "orphaned", "purging"],
          }),
          queryParam("mimeType", "string", "`image/*` wildcards allowed."),
          queryParam("search", "string", "Case-insensitive match on the filename."), // prettier-ignore
          queryParam("limit", "integer", "Page size. Defaults to 25.", { minimum: 1, maximum: 200 }), // prettier-ignore
          queryParam("cursor", "string", "Keyset cursor from the previous page."), // prettier-ignore
        ],
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                docs: { type: "array", items: ref("Media") },
                limit: { type: "integer" },
                hasNextPage: { type: "boolean" },
                cursor: { type: ["string", "null"] },
              },
            },
            "One page of files.",
          ),
        },
      },
    },
    {
      method: "GET",
      path: "/media/:id",
      source: "core",
      handler: async (context) => {
        const file = await cms.media.get(requireId(context.params.id));
        if (!file) throw CmsError.notFound("No such file.");
        return json(file);
      },
      openapi: {
        summary: "Read one file",
        tags,
        parameters: [pathParam("id", "Media id.")],
        responses: readResponses(ref("Media"), "The file."),
      },
    },
    {
      method: "PATCH",
      path: "/media/:id",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "media:update");
        const body = await readJsonObject(context.request);
        const file = await cms.media.update({
          id: requireId(context.params.id),
          actor: context.actor,
          source: requestSource(context.request),
          ...mediaPatch(body),
        });
        return json(file);
      },
      openapi: {
        summary: "Update a file's metadata",
        description:
          "Alternative text, filename, focal point, crop and your own metadata keys. Changing the focal point or the crop discards the variants rendered from the old one.",
        tags,
        parameters: [pathParam("id", "Media id.")],
        requestBody: jsonBody({
          type: "object",
          properties: {
            filename: { type: "string" },
            alt: {
              oneOf: [{ type: "string" }, { type: "object" }],
              description: "A string writes one locale; an object replaces the map.", // prettier-ignore
            },
            locale: { type: "string" },
            focalPoint: {
              type: ["object", "null"],
              properties: {
                x: { type: "number", minimum: 0, maximum: 1 },
                y: { type: "number", minimum: 0, maximum: 1 },
              },
            },
            crop: {
              type: ["object", "null"],
              properties: {
                x: { type: "integer" },
                y: { type: "integer" },
                width: { type: "integer" },
                height: { type: "integer" },
              },
            },
            metadata: { type: "object" },
          },
        }),
        responses: writeResponses(ref("Media"), "The file."),
      },
    },
    {
      method: "DELETE",
      path: "/media/:id",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "media:delete");
        const file = await cms.media.delete({
          id: requireId(context.params.id),
          force: boolean(context.query.get("force"), "force") === true,
          actor: context.actor,
          source: requestSource(context.request),
        });
        return json(file);
      },
      openapi: {
        summary: "Delete a file",
        description:
          "Refused, naming the documents, when something still points at it — `?force=true` overrides. This is the one destructive media operation an editor can perform; losing the last reference merely marks the file unused.",
        tags,
        parameters: [
          pathParam("id", "Media id."),
          queryParam("force", "boolean", "Deletes a file documents still reference."), // prettier-ignore
        ],
        responses: {
          "200": okJson(ref("Media"), "The file that was removed."),
          "409": okJson(ref("Error"), "Documents still reference the file."),
        },
      },
    },
    {
      method: "POST",
      path: "/media/:id/keep",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "media:update");
        const file = await cms.media.keep({
          id: requireId(context.params.id),
          actor: context.actor,
          source: requestSource(context.request),
        });
        return json(file);
      },
      openapi: {
        summary: 'The panel\'s "Keep" button',
        description:
          "Clears the purge deadline of an unused file without claiming anything references it.",
        tags,
        parameters: [pathParam("id", "Media id.")],
        responses: { "200": okJson(ref("Media"), "The file.") },
      },
    },
    {
      method: "GET",
      path: "/media/:id/usages",
      source: "core",
      handler: async (context) => {
        const usages = await cms.media.usages(requireId(context.params.id));
        return json({ usages });
      },
      openapi: {
        summary: "Where a file is used",
        description: "Empty for an unused file, by definition.",
        tags,
        parameters: [pathParam("id", "Media id.")],
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: { usages: { type: "array", items: ref("MediaUsage") } }, // prettier-ignore
            },
            "One entry per document, field and locale.",
          ),
        },
      },
    },
    {
      method: "GET",
      // Declared sizes and `original`. A static sub-route wins over this
      // pattern, which is why `usages` and `keep` cannot be shadowed by a
      // size name — and why the configuration refuses those two names.
      path: "/media/:id/:variant",
      source: "core",
      handler: async (context) => {
        const name = context.params.variant ?? "original";
        const result = await cms.media.variant({
          id: requireId(context.params.id),
          ...(name === "original" ? {} : { variant: name }),
          refresh: boolean(context.query.get("refresh"), "refresh") === true,
        });
        if (!result) throw CmsError.notFound("No such file.");

        // The checksum of the original plus the variant name: two deployments
        // of the same bytes produce the same tag, and a re-render of the same
        // size does not invalidate a cache that is already correct.
        const etag = `"${result.media.checksum ?? result.media.id}-${result.variant ?? "original"}"`; // prettier-ignore
        if (context.request.headers.get("if-none-match") === etag) {
          await result.body.cancel();
          return new Response(null, { status: 304, headers: { etag } });
        }

        return new Response(result.body, {
          status: 200,
          headers: {
            "content-type": result.contentType,
            etag,
            // A variant is addressed by a name whose meaning is fixed by the
            // configuration, so the bytes behind one URL only change when an
            // editor re-crops — which changes the checksum and the tag.
            "cache-control": "public, max-age=31536000, immutable",
            "x-heyo-cms-cache": result.cached ? "hit" : "miss",
            ...(result.size === null
              ? {}
              : { "content-length": String(result.size) }),
          },
        });
      },
      openapi: {
        summary: "Serve a file or one of its sizes",
        description:
          sizes.length === 0
            ? "`original` only; this deployment declares no sizes."
            : `\`original\` or one of: ${sizes.join(", ")}. Only declared names are accepted — arbitrary dimensions in a URL are how a stranger fills a bucket one pixel at a time.`,
        tags,
        parameters: [
          pathParam("id", "Media id."),
          pathParam("variant", `original${sizes.length === 0 ? "" : `, ${sizes.join(", ")}`}`), // prettier-ignore
          queryParam("refresh", "boolean", "Renders again even if a stored copy exists."), // prettier-ignore
        ],
        responses: {
          "200": { description: "The bytes." },
          "304": { description: "The cached copy is current." },
          "404": okJson(ref("Error"), "No such file or no such size."),
        },
      },
    },
  ];
}

/**
 * The orphan sweep, as an endpoint.
 *
 * Here rather than in the jobs module because it is the media lifecycle's
 * only destructive step and reads better next to the library it collects
 * from. It is also registered in `cms.jobs`, so a deployment with a cron
 * never needs this route.
 */
export function mediaCollectRoute(cms: CmsInstance): RouteRecord[] {
  if (!cms._config.uploads) return [];
  return [
    {
      method: "POST",
      path: "/media/collect",
      source: "core",
      handler: async (context) => {
        requirePermission(cms._config, context.actor, "jobs:run");
        const limit = integer(context.query.get("limit"), "limit", 1, 1000);
        const report = await cms.media.collect(
          limit === undefined ? {} : { limit },
        );
        return json(report);
      },
      openapi: {
        summary: "Run the unused-file collector",
        description:
          "Deletes files whose deadline has passed, re-checking references immediately before each delete. Also registered as the `media-gc` job.",
        tags: ["jobs"],
        parameters: [queryParam("limit", "integer", "Files examined in one pass.")], // prettier-ignore
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                examined: { type: "integer" },
                purged: { type: "integer" },
                reclaimed: { type: "integer" },
                failed: { type: "integer" },
              },
            },
            "What the sweep did.",
          ),
        },
      },
    },
  ];
}

/** The two names a declared size may not take; see the variant route. */
export const reservedMediaSubRoutes = ["usages", "keep", "collect", "upload"];

interface ParsedUpload {
  file: MediaSource;
  filename?: string;
  contentType?: string;
  alt?: string;
  locale?: string;
  metadata?: JsonObject;
}

/**
 * Both ways a file arrives.
 *
 * A form post from the panel, and raw bytes from a script. The second exists
 * because `curl --data-binary @photo.jpg` is how somebody checks whether the
 * upload endpoint works, and requiring a multipart envelope for that is a
 * needlessly bad first five minutes.
 */
async function readUpload(request: Request): Promise<ParsedUpload> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const entry = form.get("file");
    if (entry === null) {
      throw CmsError.validation('The form needs a "file" part.');
    }
    if (typeof entry === "string") {
      throw CmsError.validation('"file" has to be a file, not a string.');
    }

    const metadata = form.get("metadata");
    const filename = form.get("filename");
    const alt = form.get("alt");
    const locale = form.get("locale");

    return {
      file: entry,
      ...(typeof filename === "string" && filename.length > 0
        ? { filename }
        : entry.name
          ? { filename: entry.name }
          : {}),
      ...(entry.type ? { contentType: entry.type } : {}),
      ...(typeof alt === "string" ? { alt } : {}),
      ...(typeof locale === "string" ? { locale } : {}),
      ...(typeof metadata === "string" && metadata.length > 0
        ? { metadata: parseMetadata(metadata) }
        : {}),
    };
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw CmsError.validation("The request body is empty.");
  }
  const url = new URL(request.url);
  const filename =
    request.headers.get("x-heyo-cms-filename") ?? url.searchParams.get("filename"); // prettier-ignore
  if (!filename) {
    throw CmsError.validation(
      "A raw upload needs a filename: send `x-heyo-cms-filename` or ?filename=.",
    );
  }
  const alt = url.searchParams.get("alt");
  const locale = url.searchParams.get("locale");

  return {
    file: bytes,
    filename,
    ...(contentType.length > 0 ? { contentType } : {}),
    ...(alt === null ? {} : { alt }),
    ...(locale === null ? {} : { locale }),
  };
}

function parseMetadata(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    return parsed as JsonObject;
  } catch {
    throw CmsError.validation('"metadata" has to be a JSON object.');
  }
}

/** The patch, with the two geometric fields checked before they are stored. */
function mediaPatch(body: JsonObject): {
  filename?: string;
  alt?: string | Record<string, string>;
  locale?: string;
  focalPoint?: FocalPoint | null;
  crop?: CropRect | null;
  metadata?: JsonObject;
} {
  const patch: ReturnType<typeof mediaPatch> = {};

  if (typeof body.filename === "string") patch.filename = body.filename;
  if (typeof body.locale === "string") patch.locale = body.locale;
  if (typeof body.alt === "string") patch.alt = body.alt;
  else if (isObject(body.alt)) patch.alt = body.alt as Record<string, string>;
  if (isObject(body.metadata)) patch.metadata = body.metadata as JsonObject;

  if ("focalPoint" in body) {
    patch.focalPoint =
      body.focalPoint === null ? null : point(body.focalPoint, "focalPoint");
  }
  if ("crop" in body) {
    patch.crop = body.crop === null ? null : rect(body.crop);
  }
  return patch;
}

function point(value: unknown, name: string): FocalPoint {
  if (!isObject(value)) throw CmsError.validation(`"${name}" has to be an object.`); // prettier-ignore
  const { x, y } = value as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number") {
    throw CmsError.validation(`"${name}" needs numeric x and y.`);
  }
  return { x, y };
}

function rect(value: unknown): CropRect {
  if (!isObject(value)) throw CmsError.validation('"crop" has to be an object.'); // prettier-ignore
  const { x, y, width, height } = value as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    throw CmsError.validation('"crop" needs numeric x, y, width and height.');
  }
  return { x, y, width, height };
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mediaStatus(value: string): MediaStatus {
  if (value === "active" || value === "orphaned" || value === "purging") {
    return value;
  }
  throw CmsError.validation(
    `"${value}" is not a media status; use active, orphaned or purging.`,
  );
}

function requireId(id: string | undefined): string {
  if (id === undefined || id.length === 0) {
    throw CmsError.validation("A media id is required.");
  }
  return id;
}
