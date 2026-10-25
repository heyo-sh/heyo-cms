import { CmsError } from "../../errors";
import type { CollectionApi, GlobalApi } from "../../types/api";
import type { ResolvedCollection } from "../../types/config";
import type { CmsInstance } from "../../types/instance";
import type { JsonObject } from "../../types/json";
import { requestSource } from "../guard";
import { boolean, findArgs, readArgs } from "../params";
import {
  mediaUrlResolver,
  renderDocumentRichText,
  renderPageRichText,
  richTextFormat,
  richTextMediaResolver,
} from "../rich-text";
import {
  json,
  readJsonObject,
  requireData,
  requireString,
  stopped,
} from "../respond";
import type { RouteRecord } from "../router";
import {
  jsonBody,
  listParams,
  localeParams,
  depthParam,
  okJson,
  pathParam,
  queryParam,
  readResponses,
  ref,
  writeResponses,
} from "../spec";

/**
 * `?richText=`, documented once because every read offers it.
 *
 * Opt-in rather than the default: the stored value is the document, and a
 * response that silently replaced it with a string would make read-then-
 * write destructive for every client that round-trips a document.
 */
const richTextParam = queryParam(
  "richText",
  "string",
  "Renders rich-text fields as `html`, `markdown` or `text` instead of the ProseMirror document. Images resolve through the media id.",
  { enum: ["html", "markdown", "text"] },
);

/**
 * The optimistic-concurrency precondition, in both spellings.
 *
 * `If-Match` is the HTTP one and is what a cache or a proxy understands;
 * `revision` in the body is what a form that already has the document in hand
 * sends without building a header. They mean exactly the same thing, and
 * supplying neither keeps the old last-writer-wins behaviour — which is still
 * correct for a script that just wrote the document it is patching.
 */
const ifMatchParam = {
  name: "If-Match",
  in: "header" as const,
  required: false,
  description:
    "The `revision` the caller read. The write answers `409` if the document has changed since.",
  schema: { type: "integer" as const },
};

function expectedRevision(
  request: Request,
  body: JsonObject,
): number | undefined {
  const header = request.headers.get("if-match");
  const raw = header ?? body.revision ?? body.expectedRevision;
  if (raw === undefined || raw === null || raw === "" || raw === "*") {
    return undefined;
  }
  // Quoted ETags are what a conforming client sends; the number inside is
  // the thing we actually compare.
  const parsed = Number(String(raw).replace(/^W\/|"/g, ""));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw CmsError.validation(
      `If-Match / revision has to be a positive integer, received ${String(raw)}.`,
    );
  }
  return parsed;
}

/**
 * CRUD, generated from the configuration.
 *
 * Every handler here is three lines around a call into `cms.api`, and that is
 * the whole design: the REST layer parses a URL and serialises a result, and
 * knows nothing about access control, hooks, locales, the trash or events.
 * A second implementation of any of those — the usual outcome of writing
 * route handlers by hand — is a second set of bugs (section 10).
 */
export function documentRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  const api = cms.api as unknown as Record<string, CollectionApi<JsonObject>>;
  const routes: RouteRecord[] = [];
  const mediaUrl = mediaUrlResolver(config.basePath);

  for (const collection of Object.values(config.collections)) {
    const name = collection.name;
    const base = `/${collection.slug}`;
    const tags = [collection.slug];
    const operations = api[name];
    if (!operations) continue;

    routes.push(
      {
        method: "GET",
        path: base,
        source: "core",
        handler: async (context) => {
          const page = await operations.find(
            findArgs(context.query, collection, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
          );
          const format = richTextFormat(context.query.get("richText"));
          if (format) {
            const mediaImage = await richTextMediaResolver(
              cms,
              page.docs,
              collection,
              context.query.get("locale"),
            );
            renderPageRichText(page.docs, {
              collection,
              format,
              mediaUrl,
              ...(mediaImage === undefined ? {} : { mediaImage }),
            });
          }
          return json(page);
        },
        openapi: {
          summary: `List ${collection.label}`,
          tags,
          parameters: [...listParams(collection.slug), richTextParam],
          responses: {
            "200": okJson(
              {
                type: "object",
                properties: {
                  docs: { type: "array", items: ref(schemaName(collection)) },
                  limit: { type: "integer" },
                  totalDocs: { type: ["integer", "null"] },
                  hasNextPage: { type: "boolean" },
                  cursor: { type: ["string", "null"] },
                },
              },
              "One page of documents.",
            ),
          },
        },
      },
      {
        method: "POST",
        path: base,
        source: "core",
        handler: async (context) => {
          const body = await readJsonObject(context.request);
          const created = await operations.create({
            ...readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
            data: requireData(body),
          });
          return created === null ? stopped() : json(created, 201);
        },
        openapi: {
          summary: `Create a ${collection.label}`,
          tags,
          parameters: localeParams,
          requestBody: jsonBody({
            type: "object",
            required: ["data"],
            properties: { data: ref(inputName(collection)) },
          }),
          responses: writeResponses(
            ref(schemaName(collection)),
            "The created document.",
            201,
          ),
        },
      },
      {
        method: "GET",
        path: `${base}/:id`,
        source: "core",
        handler: async (context) => {
          const document = await operations.findById(
            requireId(context.params.id),
            readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
          );
          if (!document) {
            throw CmsError.notFound(`No ${name} with id "${context.params.id}"`); // prettier-ignore
          }
          const format = richTextFormat(context.query.get("richText"));
          if (format) {
            const mediaImage = await richTextMediaResolver(
              cms,
              [document],
              collection,
              context.query.get("locale"),
            );
            renderDocumentRichText(document, {
              collection,
              format,
              mediaUrl,
              ...(mediaImage === undefined ? {} : { mediaImage }),
            });
          }
          return json(document);
        },
        openapi: {
          summary: `Read one ${collection.label}`,
          tags,
          parameters: [
            pathParam("id", "Document id."),
            ...localeParams,
            depthParam,
            queryParam("includeTrashed", "boolean", "Allows reading a document that is in the trash."), // prettier-ignore
            richTextParam,
          ],
          responses: readResponses(
            ref(schemaName(collection)),
            "The document.",
          ),
        },
      },
      {
        method: "PATCH",
        path: `${base}/:id`,
        source: "core",
        handler: async (context) => {
          const body = await readJsonObject(context.request);
          const revision = expectedRevision(context.request, body);
          const updated = await operations.update({
            ...readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
            id: requireId(context.params.id),
            data: requireData(body),
            ...(revision === undefined ? {} : { expectedRevision: revision }),
          });
          return updated === null ? stopped() : json(updated);
        },
        openapi: {
          summary: `Update a ${collection.label}`,
          description:
            "A patch: fields that are absent are left alone. A field the actor may not write is refused, never silently dropped.\n\nSend `If-Match` (or `revision` in the body) with the revision you read to make the write conditional: `409 revision_conflict` instead of overwriting somebody else's save.",
          tags,
          parameters: [
            pathParam("id", "Document id."),
            ifMatchParam,
            ...localeParams,
          ],
          requestBody: jsonBody({
            type: "object",
            required: ["data"],
            properties: {
              data: ref(inputName(collection)),
              revision: {
                type: "integer",
                description: "Same as `If-Match`.",
              },
            },
          }),
          responses: writeResponses(
            ref(schemaName(collection)),
            "The document as it now stands.",
          ),
        },
      },
      {
        method: "DELETE",
        path: `${base}/:id`,
        source: "core",
        handler: async (context) => {
          const permanent = boolean(context.query.get("permanent"), "permanent") === true; // prettier-ignore
          const args = {
            ...readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
            id: requireId(context.params.id),
          };
          // Two verbs behind one method, separated by the flag and by the
          // permission each needs: `delete` moves a document to the trash,
          // `purge` removes it so nobody can bring it back (stage 5).
          const removed = permanent
            ? await operations.purge(args)
            : await operations.delete(args);
          return removed === null ? stopped() : json(removed);
        },
        openapi: {
          summary: `Delete a ${collection.label}`,
          description: config.trash.enabled
            ? "Moves the document to the trash. `?permanent=true` removes the row instead, which needs the purge permission."
            : "Removes the row; this deployment has no trash.",
          tags,
          parameters: [
            pathParam("id", "Document id."),
            queryParam("permanent", "boolean", "Skips the trash and removes the row."), // prettier-ignore
          ],
          responses: writeResponses(
            ref(schemaName(collection)),
            "The document as it was when it was removed.",
          ),
        },
      },
      {
        method: "POST",
        path: `${base}/:id/restore`,
        source: "core",
        handler: async (context) => {
          const restored = await operations.restore({
            ...readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
            id: requireId(context.params.id),
          });
          return restored === null ? stopped() : json(restored);
        },
        openapi: {
          summary: `Restore a ${collection.label} from the trash`,
          tags,
          parameters: [pathParam("id", "Document id."), ...localeParams],
          responses: {
            ...writeResponses(ref(schemaName(collection)), "The restored document."), // prettier-ignore
            "409": okJson(ref("Error"), "The document is not in the trash."),
          },
        },
      },
      {
        method: "POST",
        path: `${base}/:id/schedule`,
        source: "core",
        handler: async (context) => {
          const body = await readJsonObject(context.request);
          const scheduled = await operations.schedule({
            ...readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
            id: requireId(context.params.id),
            at: requireString(body, "at"),
            data: requireData(body),
          });
          return scheduled === null ? stopped() : json(scheduled);
        },
        openapi: {
          summary: `Schedule a change to a ${collection.label}`,
          description:
            "A patch and a time. Checked now — access, field access, validation — and applied later as an ordinary update, so publishing on Friday is refused on Tuesday if the actor may not write the field.",
          tags,
          parameters: [pathParam("id", "Document id."), ...localeParams],
          requestBody: jsonBody({
            type: "object",
            required: ["at", "data"],
            properties: {
              at: { type: "string", format: "date-time" },
              data: ref(inputName(collection)),
            },
          }),
          responses: writeResponses(
            ref(schemaName(collection)),
            "The document carrying the pending change.",
          ),
        },
      },
      {
        method: "DELETE",
        path: `${base}/:id/schedule`,
        source: "core",
        handler: async (context) => {
          const cancelled = await operations.unschedule({
            ...readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
            id: requireId(context.params.id),
          });
          return cancelled === null ? stopped() : json(cancelled);
        },
        openapi: {
          summary: `Cancel the scheduled change on a ${collection.label}`,
          tags,
          parameters: [pathParam("id", "Document id.")],
          responses: {
            ...writeResponses(ref(schemaName(collection)), "The document."),
            "409": okJson(ref("Error"), "Nothing was scheduled."),
          },
        },
      },
    );
    routes.push(...slugRoutes(collection, operations));
  }

  return routes;
}

const previousSlugSchema: JsonObject = {
  type: "array",
  items: {
    type: "object",
    properties: {
      slug: { type: "string" },
      field: { type: "string" },
      locale: { type: ["string", "null"] },
      createdAt: { type: ["string", "null"], format: "date-time" },
    },
  },
};

/**
 * Slug lookups and previous addresses, for a collection with a `slug` field.
 *
 * `resolve-slug` is a static segment, so it wins over `/:id` in the router;
 * an id is never a slug-shaped word, because the engine generates ids.
 */
function slugRoutes(
  collection: ResolvedCollection,
  operations: CollectionApi<JsonObject>,
): RouteRecord[] {
  const fields = Object.entries(collection.fields).filter(
    ([, field]) => field.type === "slug",
  );
  if (fields.length === 0) return [];
  const base = `/${collection.slug}`;
  const tags = [collection.slug];
  const withHistory = fields.some(([, field]) => field.options.history === true); // prettier-ignore
  const fieldParam = queryParam("field", "string", "The slug field; the first one by default."); // prettier-ignore

  const routes: RouteRecord[] = [
    {
      method: "GET",
      path: `${base}/resolve-slug`,
      source: "core",
      handler: async (context) => {
        const slug = context.query.get("slug");
        if (!slug) throw CmsError.validation('"slug" is required.');
        const field = context.query.get("field");
        const resolved = await operations.resolveSlug(slug, {
          ...readArgs(context.query, {
            actor: context.actor,
            source: requestSource(context.request),
          }),
          ...(field === null ? {} : { field }),
        });
        if (!resolved) throw CmsError.notFound(`No ${collection.name} has the slug "${slug}".`); // prettier-ignore
        return json(resolved);
      },
      openapi: {
        summary: `Find a ${collection.label} by its slug, now or before`,
        description:
          "`current: false` means the slug is a previous address of the document: redirect to its slug now. `locale` is where the slug matched.",
        tags,
        parameters: [
          { ...queryParam("slug", "string", "The slug from the URL."), required: true }, // prettier-ignore
          fieldParam,
          ...localeParams,
          depthParam,
        ],
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                id: { type: "string" },
                field: { type: "string" },
                locale: { type: ["string", "null"] },
                current: { type: "boolean" },
                document: ref(schemaName(collection)),
              },
            },
            "Where the slug leads.",
          ),
          "404": okJson(ref("Error"), "No readable document has this slug."),
        },
      },
    },
  ];
  if (!withHistory) return routes;

  const args = (context: Parameters<RouteRecord["handler"]>[0]) => {
    const locale = context.query.get("locale");
    const field = context.query.get("field");
    return {
      actor: context.actor,
      source: requestSource(context.request),
      id: requireId(context.params.id),
      ...(locale === null ? {} : { locale }),
      ...(field === null ? {} : { field }),
    };
  };

  routes.push(
    {
      method: "GET",
      path: `${base}/:id/previous-slugs`,
      source: "core",
      handler: async (context) =>
        json(await operations.previousSlugs(args(context))),
      openapi: {
        summary: `List a ${collection.label}'s previous slugs`,
        tags,
        parameters: [pathParam("id", "Document id."), fieldParam, ...localeParams], // prettier-ignore
        responses: { "200": okJson(previousSlugSchema, "Newest first.") },
      },
    },
    {
      method: "POST",
      path: `${base}/:id/previous-slugs`,
      source: "core",
      handler: async (context) => {
        const body = await readJsonObject(context.request);
        return json(
          await operations.addPreviousSlug({
            ...args(context),
            slug: requireString(body, "slug"),
            ...(typeof body.field === "string" ? { field: body.field } : {}),
            ...(typeof body.locale === "string" ? { locale: body.locale } : {}),
          }),
          201,
        );
      },
      openapi: {
        summary: `Make a slug lead to this ${collection.label}`,
        description:
          "How two pages are merged: add the old page's slug here, then trash the old page. 409 when the slug is another document's address or already leads elsewhere.",
        tags,
        parameters: [pathParam("id", "Document id."), ...localeParams],
        requestBody: jsonBody({
          type: "object",
          required: ["slug"],
          properties: {
            slug: { type: "string" },
            field: { type: "string" },
            locale: { type: "string" },
          },
        }),
        responses: {
          "201": okJson(previousSlugSchema, "The previous slugs now."),
          "409": okJson(ref("Error"), "The slug is taken."),
        },
      },
    },
    {
      method: "DELETE",
      path: `${base}/:id/previous-slugs`,
      source: "core",
      handler: async (context) => {
        const slug = context.query.get("slug");
        if (!slug) throw CmsError.validation('"slug" is required.');
        return json(await operations.removePreviousSlug({ ...args(context), slug })); // prettier-ignore
      },
      openapi: {
        summary: `Stop a previous slug from leading to this ${collection.label}`,
        tags,
        parameters: [
          pathParam("id", "Document id."),
          { ...queryParam("slug", "string", "The previous slug."), required: true }, // prettier-ignore
          fieldParam,
          ...localeParams,
        ],
        responses: { "200": okJson(previousSlugSchema, "The previous slugs now.") }, // prettier-ignore
      },
    },
  );
  return routes;
}

/**
 * Singletons.
 *
 * Mounted under `/globals/` rather than at the root: a global and a
 * collection are the same machinery, but a URL that could be either would
 * make `/settings` ambiguous the day somebody adds a `settings` collection.
 */
export function globalRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  const globals = cms.globals as unknown as Record<string, GlobalApi<JsonObject>>; // prettier-ignore
  const routes: RouteRecord[] = [];
  const mediaUrl = mediaUrlResolver(config.basePath);

  for (const global of Object.values(config.globals)) {
    const operations = globals[global.name];
    if (!operations) continue;
    const base = `/globals/${global.slug}`;
    const tags = ["globals"];

    routes.push(
      {
        method: "GET",
        path: base,
        source: "core",
        handler: async (context) => {
          const document = await operations.get(
            readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
          );
          const format = richTextFormat(context.query.get("richText"));
          if (format) {
            const mediaImage = await richTextMediaResolver(
              cms,
              [document],
              global,
              context.query.get("locale"),
            );
            renderDocumentRichText(document, {
              collection: global,
              format,
              mediaUrl,
              ...(mediaImage === undefined ? {} : { mediaImage }),
            });
          }
          return json(document);
        },
        openapi: {
          summary: `Read ${global.label}`,
          description:
            "Never 404s and never writes: a global nobody has saved reads as its declared defaults with createdAt null.",
          tags,
          parameters: [...localeParams, depthParam, richTextParam],
          responses: {
            "200": okJson(ref(schemaName(global)), "The singleton."),
          },
        },
      },
      {
        method: "PATCH",
        path: base,
        source: "core",
        handler: async (context) => {
          const body = await readJsonObject(context.request);
          const revision = expectedRevision(context.request, body);
          const updated = await operations.update({
            ...readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
            data: requireData(body),
            ...(revision === undefined ? {} : { expectedRevision: revision }),
          });
          return updated === null ? stopped() : json(updated);
        },
        openapi: {
          summary: `Update ${global.label}`,
          description:
            "Send `If-Match` (or `revision` in the body) with the revision you read to make the write conditional.",
          tags,
          parameters: [ifMatchParam, ...localeParams],
          requestBody: jsonBody({
            type: "object",
            required: ["data"],
            properties: {
              data: ref(inputName(global)),
              revision: { type: "integer", description: "Same as `If-Match`." },
            },
          }),
          responses: writeResponses(ref(schemaName(global)), "The singleton."),
        },
      },
      {
        method: "POST",
        path: `${base}/schedule`,
        source: "core",
        handler: async (context) => {
          const body = await readJsonObject(context.request);
          const scheduled = await operations.schedule({
            ...readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
            at: requireString(body, "at"),
            data: requireData(body),
          });
          return scheduled === null ? stopped() : json(scheduled);
        },
        openapi: {
          summary: `Schedule a change to ${global.label}`,
          tags,
          requestBody: jsonBody({
            type: "object",
            required: ["at", "data"],
            properties: {
              at: { type: "string", format: "date-time" },
              data: ref(inputName(global)),
            },
          }),
          responses: writeResponses(ref(schemaName(global)), "The singleton."),
        },
      },
      {
        method: "DELETE",
        path: `${base}/schedule`,
        source: "core",
        handler: async (context) => {
          const cancelled = await operations.unschedule(
            readArgs(context.query, {
              actor: context.actor,
              source: requestSource(context.request),
            }),
          );
          return cancelled === null ? stopped() : json(cancelled);
        },
        openapi: {
          summary: `Cancel the scheduled change to ${global.label}`,
          tags,
          responses: {
            ...writeResponses(ref(schemaName(global)), "The singleton."),
            "409": okJson(ref("Error"), "Nothing was scheduled."),
          },
        },
      },
    );
  }

  return routes;
}

export function schemaName(collection: ResolvedCollection): string {
  return collection.name;
}

export function inputName(collection: ResolvedCollection): string {
  return `${collection.name}Input`;
}

function requireId(id: string | undefined): string {
  if (id === undefined || id.length === 0) {
    throw CmsError.validation("A document id is required.");
  }
  return id;
}
