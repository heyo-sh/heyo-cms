import { CmsError } from "../../errors";
import type { OperationSource } from "../../types/actor";
import type { CmsInstance } from "../../types/instance";
import { requestSource, requirePermission } from "../guard";
import { integer } from "../params";
import { json, noContent, readJsonObject, requireString } from "../respond";
import type { RouteRecord } from "../router";
import { jsonBody, okJson, pathParam, queryParam, ref } from "../spec";

/**
 * The endpoints that are about the CMS rather than about content: the trash,
 * the language registry, the audit trail and the sweeps.
 *
 * All four are read through an instance method rather than a query written
 * here, for the same reason the document routes are three lines each. The
 * trash list in particular has to be one paged query across collections —
 * assembling it per collection would page wrongly the moment two collections
 * have entries.
 */
export function trashRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  if (!config.trash.enabled) return [];
  const tags = ["trash"];

  return [
    {
      method: "GET",
      path: "/trash",
      source: "core",
      handler: async (context) => {
        const collection = context.query.get("collection");
        const limit = integer(context.query.get("limit"), "limit", 1, 200);
        const cursor = context.query.get("cursor");
        const locale = context.query.get("locale");

        const page = await cms.trash.list({
          actor: context.actor,
          source: requestSource(context.request),
          ...(collection === null ? {} : { collection }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === null ? {} : { cursor }),
          ...(locale === null ? {} : { locale }),
        });
        return json(page);
      },
      openapi: {
        summary: "List deleted documents",
        description:
          "Every collection at once, newest deletion first. A collection the caller may not read contributes nothing, so the list is shorter rather than forbidden.",
        tags,
        parameters: [
          queryParam("collection", "string", "Restrict to one collection."),
          queryParam("limit", "integer", "Page size. Defaults to 25."),
          queryParam("cursor", "string", "Keyset cursor from the previous page."), // prettier-ignore
          queryParam("locale", "string", "Language to resolve the documents in."), // prettier-ignore
        ],
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                entries: { type: "array", items: ref("TrashedEntry") },
                limit: { type: "integer" },
                hasNextPage: { type: "boolean" },
                cursor: { type: ["string", "null"] },
              },
            },
            "One page of the bin.",
          ),
        },
      },
    },
    {
      method: "POST",
      // The collection is in the path rather than looked up from the id: the
      // engine restores through the collection's own rules and hooks, and
      // guessing which collection a stranger's id belongs to in order to find
      // out whether they may touch it is backwards.
      path: "/trash/:collection/:id/restore",
      source: "core",
      handler: async (context) => {
        const restored = await cms.trash.restore({
          collection: context.params.collection as string,
          id: context.params.id as string,
          actor: context.actor,
          source: requestSource(context.request),
        });
        if (!restored) throw CmsError.notFound("Nothing was restored.");
        return json(restored);
      },
      openapi: {
        summary: "Restore a document from the trash",
        tags,
        parameters: [
          pathParam("collection", "Collection name."),
          pathParam("id", "Document id."),
        ],
        responses: {
          "200": okJson({ type: "object" }, "The restored document."),
          "409": okJson(ref("Error"), "The document is not in the trash."),
        },
      },
    },
    {
      method: "DELETE",
      path: "/trash/:collection/:id",
      source: "core",
      handler: async (context) => {
        const purged = await cms.trash.purge({
          collection: context.params.collection as string,
          id: context.params.id as string,
          actor: context.actor,
          source: requestSource(context.request),
        });
        if (!purged) throw CmsError.notFound("Nothing was purged.");
        return json(purged);
      },
      openapi: {
        summary: "Delete a document for good",
        description:
          "Needs the `purge` permission rather than `delete`: removing something and removing it so nobody can get it back are different decisions.",
        tags,
        parameters: [
          pathParam("collection", "Collection name."),
          pathParam("id", "Document id."),
        ],
        responses: {
          "200": okJson({ type: "object" }, "The document as it last stood."),
          "403": okJson(ref("Error"), "Access control refused the purge."),
        },
      },
    },
  ];
}

export function localeRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  const tags = ["i18n"];

  return [
    {
      method: "GET",
      path: "/locales",
      source: "core",
      handler: () =>
        json({
          locales: cms.locales.list(),
          defaultLocale: config.i18n.defaultLocale,
        }),
      openapi: {
        summary: "List the languages",
        description:
          "Anonymous, because a frontend needs the list to render a language switcher. The list is `i18n.locales` in the configuration; each entry carries the English name of its language and whether it is written right to left.",
        tags,
        security: false,
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                locales: { type: "array", items: ref("Locale") },
                defaultLocale: { type: "string" },
              },
            },
            "The configured languages, and the one reads fall back to.",
          ),
        },
      },
    },
  ];
}

export function activityRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;

  return [
    {
      method: "GET",
      path: "/activity",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "activity:read");
        const collection = context.query.get("collection");
        const documentId = context.query.get("documentId");
        const actorId = context.query.get("actorId");
        const action = context.query.get("action");
        const source = context.query.get("source");
        const cursor = context.query.get("cursor");
        const limit = integer(context.query.get("limit"), "limit", 1, 200);

        const page = await cms.activity.list({
          ...(collection === null ? {} : { collection }),
          ...(documentId === null ? {} : { documentId }),
          ...(actorId === null ? {} : { actorId }),
          ...(action === null ? {} : { action }),
          ...(source === null ? {} : { source: source as OperationSource }),
          ...(cursor === null ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        });
        return json(page);
      },
      openapi: {
        summary: "Read the audit trail",
        description:
          "Written by the engine inside the transaction that caused each entry, so what is here committed and what is not here did not. Read-only: there is no way to delete a line.",
        tags: ["activity"],
        parameters: [
          queryParam("collection", "string", "Restrict to one collection."),
          queryParam("documentId", "string", "Restrict to one document."),
          queryParam("actorId", "string", "Restrict to one person or key."),
          queryParam("action", "string", "`document.created`, `document.trashed`, …"), // prettier-ignore
          queryParam("source", "string", "Where the write came from: `admin`, `rest`, `job`, `ai`."), // prettier-ignore
          queryParam("limit", "integer", "Page size. Defaults to 50."),
          queryParam("cursor", "string", "Keyset cursor from the previous page."), // prettier-ignore
        ],
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                entries: { type: "array", items: ref("ActivityEntry") },
                limit: { type: "integer" },
                hasNextPage: { type: "boolean" },
                cursor: { type: ["string", "null"] },
              },
            },
            "One page of the trail.",
          ),
        },
      },
    },
  ];
}

/**
 * The sweeps, as endpoints.
 *
 * The package deliberately starts no timer (`cms.jobs` is not a daemon,
 * because it has to run on Workers and on Lambda), so something has to call
 * this: a Vercel cron with an API key, `wrangler`'s scheduled handler calling
 * `cms.jobs.run()` directly, or a developer with curl.
 */
export function jobRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  const tags = ["jobs"];

  return [
    {
      method: "POST",
      path: "/jobs/run",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "jobs:run");
        const limit = integer(context.query.get("limit"), "limit", 1, 1000);
        const only = context.query.getAll("only");
        const report = await cms.jobs.run({
          ...(limit === undefined ? {} : { limit }),
          ...(only.length === 0 ? {} : { only }),
        });
        // Delivered before the answer, so a serverless invocation that is
        // about to freeze does not leave the events its own sweep produced
        // sitting in the outbox until the next cron.
        await cms.drainEvents();
        return json(report);
      },
      openapi: {
        summary: "Run the due background work",
        description: `Registered sweeps: ${cms.jobs.list().join(", ") || "none"}. Reports whether more was waiting than \`limit\` allowed, so a cron can loop instead of watching a backlog build.`, // prettier-ignore
        tags,
        parameters: [
          queryParam("limit", "integer", "Items examined per job."),
          queryParam("only", "string", "Run one job. Repeatable."),
        ],
        responses: {
          "200": okJson(ref("JobRunReport"), "What the sweep did."),
          "401": okJson(ref("Error"), "Needs a session or an API key with `jobs:run`."), // prettier-ignore
        },
      },
    },
    {
      method: "GET",
      path: "/jobs/failures",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "jobs:read");
        const type = context.query.get("type");
        const limit = integer(context.query.get("limit"), "limit", 1, 200);
        const failures = await cms.jobs.failures({
          ...(type === null ? {} : { type }),
          ...(limit === undefined ? {} : { limit }),
        });
        return json({ failures });
      },
      openapi: {
        summary: "What failed",
        description:
          "Each row carries the payload. For a scheduled change that is the patch itself, and this row is the only remaining copy — the claim that removed it from the document had already happened when the write failed.",
        tags,
        parameters: [
          queryParam("type", "string", "Job name."),
          queryParam("limit", "integer", "Page size. Defaults to 50."),
        ],
        responses: {
          "200": okJson(
            { type: "object", properties: { failures: { type: "array", items: ref("JobFailure") } } }, // prettier-ignore
            "Recorded failures, newest first.",
          ),
        },
      },
    },
  ];
}
