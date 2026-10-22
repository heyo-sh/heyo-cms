import { CmsError } from "../../errors";
import type { CmsInstance } from "../../types/instance";
import type { JsonObject } from "../../types/json";
import type { WebhookDeliveryStatus, WebhookFilters } from "../../types/webhooks"; // prettier-ignore
import { requestSource, requirePermission } from "../guard";
import { boolean, integer } from "../params";
import { json, noContent, readJsonObject, requireString } from "../respond";
import type { RouteRecord } from "../router";
import { jsonBody, okJson, pathParam, queryParam, ref } from "../spec";

/**
 * Subscriptions, deliveries, replay.
 *
 * Registered only when `webhooks.enabled` is true, so a deployment that does
 * not use them does not answer on these paths at all — and the panel, which
 * reads `cms.inspect()`-shaped data from `/panel`, hides the screen rather
 * than showing one that 501s.
 *
 * Every endpoint needs a permission in the `resource:action` grammar the
 * rest of the product uses: `webhooks:read`, `webhooks:create`,
 * `webhooks:update`, `webhooks:delete`. Managing where this CMS sends its
 * content is an administrative act, not an editorial one.
 */
export function webhookRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  if (config.webhooks?.enabled !== true) return [];
  const tags = ["webhooks"];

  return [
    {
      method: "GET",
      path: "/webhooks",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "webhooks:read");
        const active = boolean(context.query.get("active"), "active");
        const webhooks = await cms.webhooks.list(
          active === undefined ? {} : { active },
        );
        return json({ webhooks });
      },
      openapi: {
        summary: "List the subscriptions",
        description:
          "Secrets never leave: `hasSecret` says whether this subscription signs with its own, nothing says what it is.",
        tags,
        parameters: [
          queryParam("active", "boolean", "Only active, or only inactive."),
        ],
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                webhooks: { type: "array", items: ref("Webhook") },
              },
            },
            "Every subscription.",
          ),
        },
      },
    },
    {
      method: "POST",
      path: "/webhooks",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "webhooks:create"); // prettier-ignore
        const body = await readJsonObject(context.request);
        const created = await cms.webhooks.create({
          url: requireString(body, "url"),
          events: stringArray(body.events, "events"),
          ...(filters(body.filters) === undefined
            ? {}
            : { filters: filters(body.filters) as WebhookFilters }),
          ...(headers(body.headers) === undefined
            ? {}
            : { headers: headers(body.headers) as Record<string, string> }),
          ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
          ...(typeof body.active === "boolean" ? { active: body.active } : {}),
          actor,
          source: requestSource(context.request),
        });
        return json({ webhook: created }, 201);
      },
      openapi: {
        summary: "Subscribe to events",
        description:
          "Event types may be exact (`document.updated`), a family (`document.*`) or everything (`*`). A family keeps working when the catalogue grows, which is why it exists.",
        tags,
        requestBody: jsonBody({
          type: "object",
          required: ["url", "events"],
          properties: {
            url: { type: "string", format: "uri" },
            events: { type: "array", items: { type: "string" } },
            filters: {
              type: "object",
              properties: {
                collections: { type: "array", items: { type: "string" } },
                locales: { type: "array", items: { type: "string" } },
              },
            },
            headers: { type: "object", additionalProperties: { type: "string" } }, // prettier-ignore
            secret: {
              type: "string",
              description: "Overrides webhooks.signing.secret for this one.",
            },
            active: { type: "boolean" },
          },
        }),
        responses: {
          "201": okJson({ type: "object", properties: { webhook: ref("Webhook") } }, "The subscription."), // prettier-ignore
          "422": okJson(ref("Error"), "The URL or the event list is not usable."), // prettier-ignore
        },
      },
    },
    {
      method: "PATCH",
      path: "/webhooks/:id",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "webhooks:update"); // prettier-ignore
        const body = await readJsonObject(context.request);
        const updated = await cms.webhooks.update({
          id: context.params.id as string,
          ...(typeof body.url === "string" ? { url: body.url } : {}),
          ...(body.events === undefined
            ? {}
            : { events: stringArray(body.events, "events") }),
          ...(body.filters === undefined
            ? {}
            : { filters: (filters(body.filters) ?? {}) as WebhookFilters }),
          ...(body.headers === undefined
            ? {}
            : { headers: (headers(body.headers) ?? {}) as Record<string, string> }), // prettier-ignore
          ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
          ...(typeof body.active === "boolean" ? { active: body.active } : {}),
          actor,
          source: requestSource(context.request),
        });
        return json({ webhook: updated });
      },
      openapi: {
        summary: "Change a subscription",
        tags,
        parameters: [pathParam("id", "Webhook id.")],
        requestBody: jsonBody({ type: "object" }),
        responses: {
          "200": okJson({ type: "object", properties: { webhook: ref("Webhook") } }, "The subscription."), // prettier-ignore
          "404": okJson(ref("Error"), "No such webhook."),
        },
      },
    },
    {
      method: "DELETE",
      path: "/webhooks/:id",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "webhooks:delete"); // prettier-ignore
        const removed = await cms.webhooks.remove({
          id: context.params.id as string,
          actor,
        });
        if (!removed) throw CmsError.notFound("No such webhook.");
        return noContent();
      },
      openapi: {
        summary: "Unsubscribe",
        description:
          "The delivery history goes with it: it is the history of this subscription and means nothing without it.",
        tags,
        parameters: [pathParam("id", "Webhook id.")],
        responses: {
          "204": { description: "Removed." },
          "404": okJson(ref("Error"), "No such webhook."),
        },
      },
    },
    {
      method: "GET",
      path: "/webhooks/deliveries",
      source: "core",
      handler: (context) => deliveries(cms, context),
      openapi: deliveriesSpec(false),
    },
    {
      method: "GET",
      path: "/webhooks/:id/deliveries",
      source: "core",
      handler: (context) =>
        deliveries(cms, context, context.params.id as string),
      openapi: deliveriesSpec(true),
    },
    {
      method: "POST",
      path: "/webhooks/:id/test",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "webhooks:update"); // prettier-ignore
        const delivery = await cms.webhooks.test({
          id: context.params.id as string,
          actor,
        });
        return json({ delivery });
      },
      openapi: {
        summary: "Send a test event",
        description:
          "A real delivery carrying a synthetic `webhook.test` event: same signature, same headers, same retry rules. A receiver that accepts this accepts the real thing.",
        tags,
        parameters: [pathParam("id", "Webhook id.")],
        responses: {
          "200": okJson({ type: "object", properties: { delivery: ref("WebhookDelivery") } }, "What the receiver answered."), // prettier-ignore
        },
      },
    },
    {
      method: "POST",
      path: "/webhooks/deliveries/:id/retry",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "webhooks:update"); // prettier-ignore
        const delivery = await cms.webhooks.retry({
          id: context.params.id as string,
          actor,
        });
        return json({ delivery });
      },
      openapi: {
        summary: "Replay a delivery",
        description:
          "A new attempt carrying the same event id, so a consumer's idempotency key still matches and the original attempt stays readable.",
        tags,
        parameters: [pathParam("id", "Delivery id.")],
        responses: {
          "200": okJson({ type: "object", properties: { delivery: ref("WebhookDelivery") } }, "The replayed delivery."), // prettier-ignore
          "404": okJson(ref("Error"), "No such delivery."),
        },
      },
    },
  ];
}

async function deliveries(
  cms: CmsInstance,
  context: Parameters<RouteRecord["handler"]>[0],
  webhookId?: string,
): Promise<Response> {
  requirePermission(cms._config, context.actor, "webhooks:read");
  const status = context.query.get("status");
  const eventId = context.query.get("eventId");
  const cursor = context.query.get("cursor");
  const limit = integer(context.query.get("limit"), "limit", 1, 200);
  const includeBody = boolean(context.query.get("includeBody"), "includeBody");

  const page = await cms.webhooks.deliveries({
    ...(webhookId === undefined ? {} : { webhookId }),
    ...(status === null ? {} : { status: status as WebhookDeliveryStatus }),
    ...(eventId === null ? {} : { eventId }),
    ...(cursor === null ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
    ...(includeBody === undefined ? {} : { includeBody }),
  });
  return json(page);
}

function deliveriesSpec(scoped: boolean): RouteRecord["openapi"] {
  return {
    summary: scoped ? "Deliveries for one subscription" : "Every delivery",
    description:
      "Newest first. `failed` is the dead-letter queue: out of attempts, still here, replayable.",
    tags: ["webhooks"],
    parameters: [
      ...(scoped ? [pathParam("id", "Webhook id.")] : []),
      queryParam("status", "string", "pending, delivered or failed."),
      queryParam("eventId", "string", "Every attempt at one event."),
      queryParam("limit", "integer", "Page size. Defaults to 25."),
      queryParam("cursor", "string", "Keyset cursor from the previous page."),
      queryParam("includeBody", "boolean", "Includes the signed request body."),
    ],
    responses: {
      "200": okJson(
        {
          type: "object",
          properties: {
            entries: { type: "array", items: ref("WebhookDelivery") },
            limit: { type: "integer" },
            hasNextPage: { type: "boolean" },
            cursor: { type: ["string", "null"] },
          },
        },
        "One page of deliveries.",
      ),
    },
  };
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw CmsError.validation(`"${name}" has to be an array of strings.`);
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function filters(value: unknown): WebhookFilters | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as JsonObject;
  const collections = Array.isArray(source.collections)
    ? source.collections.filter((entry): entry is string => typeof entry === "string") // prettier-ignore
    : undefined;
  const locales = Array.isArray(source.locales)
    ? source.locales.filter((entry): entry is string => typeof entry === "string") // prettier-ignore
    : undefined;
  return {
    ...(collections === undefined ? {} : { collections }),
    ...(locales === undefined ? {} : { locales }),
  };
}

function headers(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[name] = entry;
  }
  return result;
}
