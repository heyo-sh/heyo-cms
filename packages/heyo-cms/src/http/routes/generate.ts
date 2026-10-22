import { accessFilter } from "../../engine/access";
import { assertFieldWriteAccess } from "../../engine/field-access";
import { CmsError } from "../../errors";
import { and, eq } from "../../query";
import { documentsTableName } from "../../schema/snapshot";
import type { Actor } from "../../types/actor";
import type { ResolvedCollection } from "../../types/config";
import type { CmsInstance } from "../../types/instance";
import type { JsonObject, JsonValue } from "../../types/json";
import { json, readJsonObject } from "../respond";
import type { RouteRecord } from "../router";
import { jsonBody, okJson, pathParam } from "../spec";

/** Deterministic field generation: server functions stay on the server. */
export function generateRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  const routes: RouteRecord[] = [];
  for (const collection of [
    ...Object.values(config.collections),
    ...Object.values(config.globals),
  ]) {
    if (!Object.values(collection.fields).some((field) => field.generate))
      continue;
    const base =
      collection.kind === "global"
        ? `/globals/${collection.slug}`
        : `/${collection.slug}`;
    const run = async (
      request: Parameters<RouteRecord["handler"]>[0],
      id?: string,
    ) => {
      const name = request.params.field as string;
      const field = collection.fields[name];
      if (!field?.generate)
        throw CmsError.notFound(`No generator for ${collection.name}.${name}.`);
      const body = await readJsonObject(request.request);
      const locale =
        typeof body.locale === "string"
          ? body.locale
          : config.i18n.defaultLocale;
      if (!config.i18n.locales.includes(locale)) {
        throw CmsError.validation(`Unknown locale "${locale}".`);
      }
      const actor = request.actor;
      const draft = isObject(body.document) ? body.document : {};
      const operation =
        collection.kind === "global" || id ? "update" : "create";
      // The write path applies the update rule once before loading a row,
      // then again with the resolved document for record-dependent rules.
      const preGranted =
        operation === "update"
          ? await accessFilter(collection, {
              actor,
              operation,
              locale,
              rbac: config.rbac,
            })
          : undefined;
      const stored = await load(cms, collection, id, actor, locale);
      if (
        field.access?.read &&
        !field.access.read({ actor, locale, record: stored })
      ) {
        throw CmsError.notFound(`No generator for ${collection.name}.${name}.`);
      }
      const granted = await accessFilter(collection, {
        actor,
        operation,
        locale,
        rbac: config.rbac,
        ...(id || collection.kind === "global" ? { record: stored } : {}),
      });
      if (preGranted || granted) {
        if (operation === "create") {
          throw new CmsError(
            `access.create on "${collection.name}" returned a filter; a create has no row to filter. Return true or false.`,
            { status: 500, code: "invalid_access_rule" },
          );
        }
        // Update access filters must be applied to the row, not merely
        // evaluated. A readable record is not necessarily writable.
        const adapter = await cms.database();
        const matches = await adapter.transaction((tx) =>
          adapter.query(tx, {
            table: documentsTableName,
            where: and(
              eq("id", String(stored.id)),
              eq("collection", collection.slug),
              eq("deleted_at", null),
              ...(preGranted ? [preGranted] : []),
              ...(granted ? [granted] : []),
            ),
            limit: 1,
          }),
        );
        if (matches.length === 0) {
          throw CmsError.notFound(
            `No ${collection.name} with id "${stored.id}".`,
          );
        }
      }
      assertFieldWriteAccess(
        collection,
        { [name]: null },
        actor,
        locale,
        operation === "create" ? undefined : stored,
      );

      // Never hand an unfiltered browser draft or an unreadable field to a callback.
      const fields: JsonObject = {};
      for (const [sibling, definition] of Object.entries(collection.fields)) {
        if (sibling === name) continue;
        if (
          definition.access?.read &&
          !definition.access.read({ actor, locale, record: stored })
        )
          continue;
        if (sibling in draft || sibling in stored)
          fields[sibling] =
            sibling in draft
              ? (draft[sibling] ?? null)
              : (stored[sibling] ?? null);
      }
      const value = await field.generate({ fields, locale });
      const result = field.schema.safeParse(value);
      if (!result.success) {
        throw CmsError.validation(
          `${collection.name}.${name}: generated value is invalid: ${result.error.issues[0]?.message ?? "invalid value"}`,
        );
      }
      return json({ value: result.data as JsonValue });
    };
    const spec = (withId: boolean): RouteRecord["openapi"] => ({
      summary: `Generate a ${collection.label} field without AI`,
      tags: ["content"],
      parameters: [
        pathParam("field", "Field with a generate function."),
        ...(withId ? [pathParam("id", "Document ID.")] : []),
      ],
      requestBody: jsonBody({
        type: "object",
        properties: {
          document: { type: "object" },
          locale: { type: "string" },
        },
      }),
      responses: {
        "200": okJson(
          { type: "object", properties: { value: {} } },
          "Generated field value.",
        ),
      },
    });
    if (collection.kind !== "global")
      routes.push({
        method: "POST",
        path: `${base}/:id/generate/:field`,
        source: "core",
        handler: (context) => run(context, context.params.id as string),
        openapi: spec(true),
      });
    routes.push({
      method: "POST",
      path: `${base}/generate/:field`,
      source: "core",
      handler: (context) => run(context),
      openapi: spec(false),
    });
  }
  return routes;
}

async function load(
  cms: CmsInstance,
  collection: ResolvedCollection,
  id: string | undefined,
  actor: Actor | null,
  locale: string,
): Promise<JsonObject> {
  if (collection.kind === "global") {
    const api = (
      cms.globals as Record<
        string,
        {
          get(args: {
            actor: typeof actor;
            locale: string;
          }): Promise<JsonObject>;
        }
      >
    )[collection.name];
    return api ? api.get({ actor, locale }) : {};
  }
  if (!id) return {};
  const api = (
    cms.api as Record<
      string,
      {
        findById(
          id: string,
          args: { actor: typeof actor; locale: string },
        ): Promise<JsonObject | null>;
      }
    >
  )[collection.name];
  const found = await api?.findById(id, { actor, locale });
  if (!found)
    throw CmsError.notFound(
      `No ${collection.name} with id "${id}", or it is not readable.`,
    );
  return found;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
