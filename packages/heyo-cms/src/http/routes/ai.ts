import { parsePageContext } from "../../ai/assistant/context";
import { CmsError } from "../../errors";
import type { AiAssistantEvent, AiAssistantTurn } from "../../types/ai";
import type { ResolvedCollection } from "../../types/config";
import type { CmsInstance } from "../../types/instance";
import type { JsonObject } from "../../types/json";
import { requestSource, requirePermission } from "../guard";
import { json, readJsonObject, requireString } from "../respond";
import type { RouteRecord } from "../router";
import { jsonBody, okJson, pathParam, queryParam, ref } from "../spec";

/**
 * The AI endpoints, generated from the configuration like everything else.
 *
 * Two shapes per field action, and the reason there are two is that a document
 * being written for the first time has no id. The panel asks about what is on
 * the screen, which for a new document is only in the browser, so the draft
 * travels in the body and the stored document — when there is one — is read
 * through `cms.api` and merged underneath it.
 *
 *   POST /posts/:id/ai/:field/:action
 *   POST /posts/ai/:field/:action        (an unsaved draft)
 *
 * Then the panel-wide assistant, which is addressed by nothing in particular
 * because it is not about one collection:
 *
 *   POST /ai/assistant                   (SSE)
 *   POST /ai/assistant/plans/:id/approve
 *
 * The per-field routes exist only when a field declares `aiGenerate` or a legacy `ai` action.
 * A deployment with no AI has no AI endpoints, which is what
 * `cms.inspect().routes` should say (section 8).
 */
export function aiRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  if (!config.ai) return [];

  const routes: RouteRecord[] = [];
  const everything = [
    ...Object.values(config.collections),
    ...Object.values(config.globals),
  ];

  for (const collection of everything) {
    const base =
      collection.kind === "global"
        ? `/globals/${collection.slug}`
        : `/${collection.slug}`;
    const hasFieldAi = Object.values(collection.fields).some(
      (field) =>
        field.aiGenerate !== undefined ||
        (field.ai !== undefined && Object.keys(field.ai).length > 0),
    );

    // Variant creation is separate from the field menu: a localized text
    // field can be translated even when it has no `ai.translate` button.
    if (Object.values(collection.fields).some((field) => field.localized)) {
      routes.push({
        method: "POST",
        path:
          collection.kind === "global"
            ? `${base}/ai/translate-variant`
            : `${base}/:id/ai/translate-variant`,
        source: "core",
        handler: async (context) => {
          const body = await readJsonObject(context.request);
          const locale = requireString(body, "locale");
          const sourceLocale = requireString(body, "sourceLocale");
          if (
            locale === sourceLocale ||
            !config.i18n.locales.includes(locale) ||
            !config.i18n.locales.includes(sourceLocale)
          ) {
            throw CmsError.validation(
              "Choose two different configured languages.",
            );
          }
          if (
            !Array.isArray(body.fields) ||
            body.fields.some((name) => typeof name !== "string")
          ) {
            throw CmsError.validation(
              "fields must be an array of field names.",
            );
          }
          const values: JsonObject = {};
          for (const name of new Set(body.fields as string[])) {
            const field = collection.fields[name];
            if (
              !field?.localized ||
              !["text", "textarea", "richText", "email", "url"].includes(
                field.type,
              )
            ) {
              throw CmsError.validation(`Cannot translate ${name}.`);
            }
            const result = await cms.ai.run({
              collection: collection.name,
              field: name,
              action: "translate",
              variantTranslation: true,
              ...(collection.kind === "global"
                ? {}
                : { id: context.params.id as string }),
              actor: context.actor,
              source: requestSource(context.request),
              locale,
              sourceLocale,
              signal: context.request.signal,
            });
            values[name] = result.value;
          }
          return json({ values });
        },
        openapi: {
          summary: `Translate localized fields of a ${collection.label} language variant`,
          description:
            "Returns translated values without writing them. Only localized text fields are translated; the caller creates the variant through the ordinary conditional PATCH.",
          tags: ["ai"],
          parameters:
            collection.kind === "global"
              ? []
              : [pathParam("id", "Document ID.")],
          requestBody: jsonBody({
            type: "object",
            required: ["locale", "sourceLocale", "fields"],
            properties: {
              locale: { type: "string" },
              sourceLocale: { type: "string" },
              fields: { type: "array", items: { type: "string" } },
            },
          }),
          responses: {
            "200": okJson(
              { type: "object", properties: { values: { type: "object" } } },
              "Translated field values.",
            ),
            "403": okJson(ref("Error"), "The actor may not update a field."),
            "422": okJson(ref("Error"), "Invalid languages or fields."),
          },
        },
      });
    }

    if (hasFieldAi) {
      const run = async (
        context: Parameters<RouteRecord["handler"]>[0],
        id?: string,
      ) => {
        const body = await optionalBody(context.request);
        const document = body.document;
        const locale = context.query.get("locale") ?? asString(body.locale);
        const sourceLocale =
          context.query.get("sourceLocale") ?? asString(body.sourceLocale);

        const result = await cms.ai.run({
          collection: collection.name,
          field: context.params.field as string,
          action: context.params.action as string,
          actor: context.actor,
          source: requestSource(context.request),
          ...(id === undefined ? {} : { id }),
          ...(isObject(document) ? { document } : {}),
          ...(locale === undefined ? {} : { locale }),
          ...(sourceLocale === undefined ? {} : { sourceLocale }),
          signal: context.request.signal,
        });
        return json(result);
      };

      routes.push(
        {
          method: "POST",
          path: `${base}/:id/ai/:field/:action`,
          source: "core",
          handler: (context) => run(context, context.params.id as string),
          openapi: fieldAiSpec(collection, true),
        },
        {
          method: "POST",
          path: `${base}/ai/:field/:action`,
          source: "core",
          handler: (context) => run(context),
          openapi: fieldAiSpec(collection, false),
        },
      );
    }
  }

  routes.push(...assistantRoutes(cms));
  routes.push(...providerRoutes(cms));
  return routes;
}

/**
 * The assistant: one streaming endpoint and one approval endpoint.
 *
 * Registered only when there is an `ai` section and `ai.assistant.enabled` is
 * not `false`. A deployment that switched the assistant off answers 404 rather
 * than 501, because the route genuinely is not there — and `cms.inspect()`
 * says so.
 *
 * The request carries a conversation and a page hint. It does not carry the
 * document, the access rules, a token or a tool definition: everything the
 * agent is allowed to do is decided on this side, from the session.
 */
function assistantRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  if (config.ai?.assistant?.enabled === false) return [];
  const tags = ["ai"];

  return [
    {
      method: "POST",
      path: "/ai/assistant",
      source: "core",
      handler: async (context) => {
        // `ai:use` is the cost control, not the access control: the tools
        // check every record against this same actor a second time, which is
        // the check that actually decides what happens.
        const actor = requirePermission(config, context.actor, "ai:use");
        const body = await readJsonObject(context.request);

        const page = parsePageContext(body.pageContext);

        // Started by `eventStream`, with the signal it owns: the run has to
        // end when the socket does, and the socket's fate is the stream's
        // business rather than the handler's.
        return eventStream(
          (signal) =>
            cms.ai.runAssistant({
              message: requireString(body, "message"),
              history: assistantHistory(body.history),
              actor,
              source: requestSource(context.request),
              signal,
              ...(typeof body.conversationId === "string"
                ? { conversationId: body.conversationId }
                : {}),
              // The language the caller is working in, for a request that
              // carries no page context at all — a script, or a panel screen
              // that has nothing to say about a record. Checked against the
              // registry on the way in, like every other locale.
              ...(typeof body.locale === "string"
                ? { locale: body.locale }
                : {}),
              ...(page === undefined ? {} : { pageContext: page }),
            }),
          context.request,
        );
      },
      openapi: {
        summary: "Talk to the assistant",
        description:
          "Server-sent events. The agent reads and writes through the ordinary API with the caller's own permissions, so every change it makes runs the same validation, hooks, events and activity log as a form save — with `source: ai` and the signed-in human as the actor.\n\nCreating, deleting and multi-record changes never happen here: they arrive as `approval-required` and are executed by the approval endpoint.",
        tags,
        requestBody: jsonBody({
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string", maxLength: 12_000 },
            conversationId: { type: "string" },
            locale: {
              type: "string",
              description:
                "The language being edited, for a request with no `pageContext`. `pageContext.locale` wins when both are present.",
            },
            history: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  text: { type: "string" },
                },
              },
            },
            pageContext: {
              type: "object",
              description:
                "Where the editor is looking. A hint: every slug, id and locale in it is re-resolved server-side against the configuration and re-read with the caller's permissions.",
              properties: {
                kind: {
                  type: "string",
                  enum: [
                    "dashboard",
                    "collection-list",
                    "document",
                    "global",
                    "media",
                    "trash",
                    "settings",
                  ],
                },
                collectionSlug: { type: "string" },
                documentId: { type: "string" },
                mediaId: {
                  type: "string",
                  description:
                    'The file the media screen\'s details pane is showing, so "this image" resolves.',
                },
                tab: {
                  type: "string",
                  description:
                    "Which sub-surface of the screen is in front: a rich-text tab, a settings tab, the media status.",
                },
                locale: { type: "string" },
                dirtyFields: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Names only. The unsaved values stay in the browser; the assistant refuses to write a record whose form is dirty.",
                },
                baselineRevision: { type: "integer" },
              },
            },
          },
        }),
        responses: {
          "200": {
            description: "A stream of `AiAssistantEvent`, one per SSE message.",
            content: {
              "text/event-stream": {
                schema: ref("AiAssistantEvent"),
              },
            },
          },
          "403": okJson(ref("Error"), "The actor does not have `ai:use`."),
          "501": okJson(
            ref("Error"),
            "`ai_assistant_runtime_missing` or `ai_credentials_missing`.",
          ),
        },
      },
    },
    {
      method: "POST",
      path: "/ai/assistant/plans/:id/approve",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "ai:use");
        const result = await cms.ai.approveAssistantPlan({
          planId: context.params.id as string,
          actor,
          source: requestSource(context.request),
          signal: context.request.signal,
        });
        return json(result);
      },
      openapi: {
        summary: "Apply a plan the editor approved",
        description:
          "Executes the stored plan exactly as it was shown. The model is not consulted: the session, the permissions and the revisions are checked again, and the recorded operations run through the ordinary write path.",
        tags,
        parameters: [pathParam("id", "Plan id from `approval-required`.")],
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                planId: { type: "string" },
                runId: { type: "string" },
                applied: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      target: ref("AiMutationTarget"),
                      fields: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
            "What was written.",
          ),
          "404": okJson(ref("Error"), "No such plan for this actor."),
          "409": okJson(ref("Error"), "Already applied, or a record moved on."),
          "410": okJson(ref("Error"), "`ai_plan_expired`."),
        },
      },
    },
  ];
}

/**
 * The generator, as `text/event-stream`.
 *
 * One JSON object per event, which is what the panel's parser expects and what
 * `curl -N` prints legibly. Errors raised *before* the first event — no
 * credentials, no agent runtime, no permission — still arrive as an `error`
 * event rather than as a non-200 response, because by the time the body is
 * being produced the status line has already been sent.
 */
function eventStream(
  start: (signal: AbortSignal) => AsyncIterable<AiAssistantEvent>,
  request: Request,
): Response {
  const encoder = new TextEncoder();

  // The run's own signal, rather than the request's directly. Both a closed
  // socket and a cancelled body have to end the run, and only one of those is
  // a request abort — so they are funnelled into one controller that the
  // generator is actually listening to.
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signal = controller.signal;
  request.signal.addEventListener("abort", stop, { once: true });

  const iterator = start(signal)[Symbol.asyncIterator]();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // Every enqueue is guarded, because a disconnected client turns the
      // controller into something that throws — and the first place that
      // would bite is the error handler below, which would then throw while
      // reporting the error it was called for.
      const send = (event: AiAssistantEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done || signal.aborted) break;
          send(next.value);
        }
      } catch (error) {
        if (!signal.aborted) {
          const cms = error instanceof CmsError ? error : null;
          send({
            type: "error",
            code: cms?.code ?? "ai_assistant_failed",
            message: cms?.message ?? "The assistant failed.",
          });
          if (!cms) {
            console.error("[heyo-cms] the AI assistant failed", error);
          }
        }
      } finally {
        request.signal.removeEventListener("abort", stop);
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a cancel; nothing owed.
        }
      }
    },
    cancel() {
      // Aborting, never awaiting. A generator parked on a model call does not
      // settle its `return()` until that call finishes, so waiting here would
      // hold the cancel open for exactly as long as the run it is trying to
      // stop. The abort is what actually ends it.
      stop();
      void iterator.return?.().catch(() => undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // `no-transform` matters as much as `no-cache`: a proxy that buffers to
      // compress the body turns a stream into a single late blob.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function assistantHistory(value: unknown): AiAssistantTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: AiAssistantTurn[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const { role, text } = entry;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    turns.push({ role, text });
  }
  return turns;
}

/**
 * Provider keys, managed from the panel.
 *
 * Writing one needs `ai:manage`, reading the list needs `ai:read`, and
 * neither ever answers with a token: `GET` reports which providers are
 * configured, where the key came from and its last four characters. A
 * settings screen that could read a key back is a settings screen that leaks
 * one the first time somebody is phished into opening it.
 */
function providerRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  const tags = ["ai"];

  return [
    {
      method: "GET",
      path: "/ai/providers",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "ai:read");
        const providers = await cms.ai.providers();
        return json({
          providers,
          defaultModel: config.ai?.defaultModel ?? null,
          assistant: config.ai?.assistant?.enabled !== false,
          storage: config.ai?.storage?.secret !== undefined,
        });
      },
      openapi: {
        summary: "Which AI providers have credentials",
        description:
          "Never the keys themselves: `hint` is the last four characters, `source` says whether the key is in the configuration or in the database.",
        tags,
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                providers: { type: "array", items: ref("AiProvider") },
                defaultModel: { type: ["object", "null"] },
                assistant: { type: "boolean" },
                storage: {
                  type: "boolean",
                  description: "Whether keys may be stored from the panel.",
                },
              },
            },
            "The provider list.",
          ),
        },
      },
    },
    {
      method: "PUT",
      path: "/ai/providers/:provider",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "ai:manage");
        const body = await readJsonObject(context.request);
        const status = await cms.ai.setCredential({
          provider: context.params.provider as string,
          token: requireString(body, "token"),
          actor,
          source: requestSource(context.request),
        });
        return json({ provider: status });
      },
      openapi: {
        summary: "Store a provider key",
        description:
          "Encrypted with `ai.storage.secret` before it is written. Without that secret the endpoint answers 501, because storing a key in plaintext is not a lesser version of this feature.",
        tags,
        parameters: [pathParam("provider", "Provider id, e.g. `openai`.")],
        requestBody: jsonBody({
          type: "object",
          required: ["token"],
          properties: { token: { type: "string" } },
        }),
        responses: {
          "200": okJson({ type: "object", properties: { provider: ref("AiProvider") } }, "The stored key, described."), // prettier-ignore
          "501": okJson(ref("Error"), "ai.storage.secret is not configured."),
        },
      },
    },
    {
      method: "DELETE",
      path: "/ai/providers/:provider",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "ai:manage");
        const removed = await cms.ai.removeCredential({
          provider: context.params.provider as string,
          actor,
        });
        if (!removed) throw CmsError.notFound("No stored key for that provider."); // prettier-ignore
        return json({ removed: true });
      },
      openapi: {
        summary: "Forget a stored provider key",
        description:
          "Removes the database copy. A key in `ai.auth` is in the configuration and is unaffected.",
        tags,
        parameters: [pathParam("provider", "Provider id.")],
        responses: {
          "200": okJson({ type: "object", properties: { removed: { type: "boolean" } } }, "Removed."), // prettier-ignore
          "404": okJson(ref("Error"), "There was no stored key."),
        },
      },
    },
  ];
}

function fieldAiSpec(
  collection: ResolvedCollection,
  withId: boolean,
): RouteRecord["openapi"] {
  const configured = Object.entries(collection.fields)
    .filter(([, field]) => field.aiGenerate !== undefined || field.ai)
    .map(
      ([name, field]) =>
        `${name}: ${[
          ...(field.aiGenerate === undefined ? [] : ["generate"]),
          ...Object.keys(field.ai ?? {}),
        ].join(", ")}`,
    );

  return {
    summary: `Run an AI action on a ${collection.label} field`,
    description: [
      "Answers with a value. Nothing is written: the panel inserts the result into the form and the editor saves it, like any other edit (section 8).",
      withId
        ? "The stored document is read first and the draft in the body is merged over it."
        : "For a document that has not been saved yet; everything the model sees comes from the body.",
      configured.length > 0
        ? `Configured here — ${configured.join("; ")}.`
        : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n\n"),
    tags: ["ai"],
    parameters: [
      pathParam("field", "Field name."),
      pathParam(
        "action",
        "`generate` for aiGenerate, or a key of the legacy `ai` map.",
      ),
      queryParam("locale", "string", "Language the value is written in."),
      queryParam("sourceLocale", "string", "Language `translate` reads from."),
    ],
    requestBody: jsonBody(
      {
        type: "object",
        properties: {
          document: {
            type: "object",
            description: "The form as it stands in the browser.",
          },
          locale: { type: "string" },
          sourceLocale: { type: "string" },
        },
      },
      false,
    ),
    responses: {
      "200": okJson(ref("AiResult"), "The suggestion."),
      "403": okJson(ref("Error"), "The actor may not write that field."),
      "404": okJson(ref("Error"), "The field has no such action configured."),
      "501": okJson(ref("Error"), "This deployment has no `ai` section."),
    },
  };
}

async function optionalBody(request: Request): Promise<JsonObject> {
  // An action with no context needs no body, and making the panel send `{}`
  // to satisfy a parser would be a rule with no purpose.
  const length = request.headers.get("content-length");
  if (length === "0" || length === null) return {};
  try {
    return await readJsonObject(request);
  } catch {
    return {};
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
