import type { JsonObject } from "../types/json";

/**
 * The small vocabulary the route modules use to document themselves.
 *
 * Keeping it here rather than inline is not tidiness: a response envelope
 * described slightly differently on forty endpoints produces a generated
 * document nobody can code-generate a client from.
 */

export function ref(schema: string): JsonObject {
  return { $ref: `#/components/schemas/${schema}` };
}

export function pathParam(name: string, description: string): JsonObject {
  return {
    name,
    in: "path",
    required: true,
    description,
    schema: { type: "string" },
  };
}

export function queryParam(
  name: string,
  type: "string" | "integer" | "boolean",
  description: string,
  extra: JsonObject = {},
): JsonObject {
  return {
    name,
    in: "query",
    required: false,
    description,
    schema: { type, ...extra },
  };
}

/** Locale and fallback: every read takes them, so they are written once. */
export const localeParams: JsonObject[] = [
  queryParam("locale", "string", "Language to resolve the document in. Defaults to i18n.defaultLocale."), // prettier-ignore
  queryParam("fallbackLocale", "string", 'Where missing values come from for this call; "false" turns substitution off. Defaults to i18n.defaultLocale.'), // prettier-ignore
];

export const depthParam = queryParam(
  "depth",
  "integer",
  "Relation levels to resolve. Each level is one batched query.",
  { minimum: 0, maximum: 10 },
);

/** The filter, sort and paging parameters of a list endpoint. */
export function listParams(collection: string): JsonObject[] {
  return [
    ...localeParams,
    depthParam,
    queryParam("where", "string", `JSON filter AST over ${collection}, as produced by the query helpers.`), // prettier-ignore
    queryParam("sort", "string", 'Comma-separated fields, "-" for descending. Defaults to -updatedAt.'), // prettier-ignore
    queryParam("limit", "integer", "Page size. Defaults to 25, capped at 500.", { minimum: 1, maximum: 500 }), // prettier-ignore
    queryParam("offset", "integer", "Rows to skip. Prefer `cursor`."),
    queryParam("cursor", "string", "Keyset cursor from the previous page."),
    queryParam("count", "boolean", "Runs a second COUNT query and fills totalDocs."), // prettier-ignore
    queryParam("includeTrashed", "boolean", "Includes soft-deleted documents."),
    {
      name: "<field>",
      in: "query",
      required: false,
      description:
        "Shorthand filter: ?status=draft, ?views[gte]=10, ?tags[in]=news,guide. Any field of the collection or system column (id, createdAt, updatedAt, deletedAt, scheduledAt).",
      schema: { type: "string" },
    },
  ];
}

export function jsonBody(schema: JsonObject, required = true): JsonObject {
  return {
    required,
    content: { "application/json": { schema } },
  };
}

export function okJson(schema: JsonObject, description: string): JsonObject {
  return {
    description,
    content: { "application/json": { schema } },
  };
}

/**
 * The responses every write shares.
 *
 * `204` is in here on purpose: a `before` hook returning `false` stops the
 * operation without an error (section 5), and a client that does not know
 * that will read an empty body as a broken endpoint.
 */
export function writeResponses(
  schema: JsonObject,
  description: string,
  status = 200,
): JsonObject {
  return {
    [String(status)]: okJson(schema, description),
    "204": {
      description: "A `before` hook stopped the operation (x-heyo-cms-stopped).", // prettier-ignore
    },
    "403": okJson(ref("Error"), "Access control refused the operation."),
    "409": okJson(
      ref("Error"),
      "`revision_conflict`: the document changed since the revision the caller sent in `If-Match`.",
    ),
    "422": okJson(ref("Error"), "Validation failed."),
  };
}

export function readResponses(
  schema: JsonObject,
  description: string,
): JsonObject {
  return {
    "200": okJson(schema, description),
    "404": okJson(ref("Error"), "No such document."),
  };
}
