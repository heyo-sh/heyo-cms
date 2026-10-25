import { accessFilter } from "../engine/access";
import { assertFieldWriteAccess } from "../engine/field-access";
import { toIso } from "../engine/documents";
import { scopedDb } from "../engine/scoped-db";
import { CmsError } from "../errors";
import { createId } from "../ids";
import { eq } from "../query";
import type { Actor } from "../types/actor";
import type {
  AiActionContext,
  AiApprovePlanArgs,
  AiApprovePlanResult,
  AiAssistantArgs,
  AiAssistantEvent,
  AiCompletionFn,
  AiCredentialArgs,
  AiImageInput,
  AiProviderStatus,
  AiRunArgs,
  AiRunResult,
  CmsAi,
} from "../types/ai";
import type {
  AiAuth,
  ResolvedCmsConfig,
  ResolvedCollection,
} from "../types/config";
import type { DatabaseAdapter } from "../types/database";
import type { AiEventType } from "../types/events";
import type { FieldAiAction } from "../types/fields";
import type { CmsInstance } from "../types/instance";
import type { JsonObject, JsonValue } from "../types/json";
import type { Tx } from "../types/query";
import type { BufferedEvent, OutboxEntryMeta } from "../engine/outbox";
import { decryptSecret, encryptSecret, keyHint } from "./crypto";
import { piCompletion } from "./pi";
import { aiActionsFor, customAiAction, getAiAction } from "./registry";
import { translateVariantRichText } from "./variant-translation";

export const aiCredentialsTable = "cms_ai_credentials";

export interface AiServiceOptions {
  config: ResolvedCmsConfig;
  database(): Promise<DatabaseAdapter>;
  /** The bound instance, for reading documents and files under access control. */
  cms(): CmsInstance;
  emit(tx: Tx, events: BufferedEvent[], meta: OutboxEntryMeta): Promise<void>;
  deliver(): void;
}

/**
 * `cms.ai`.
 *
 * Present whether or not the configuration has an `ai` section, exactly like
 * `cms.media` is present without `uploads`: the alternative is an optional
 * property every caller has to narrow, and a 500 that says "cannot read
 * property run of undefined" instead of a sentence naming the missing
 * section.
 *
 * Everything the runtime does is one of two things — run one action on one
 * field, or hold one conversation about one document — and both of them end
 * by handing a value back to a human. Nothing in this file writes a document
 * (section 8).
 */
export function createAi(options: AiServiceOptions): CmsAi {
  const { config } = options;
  const configured: AiCompletionFn = config.ai?.complete ?? piCompletion;

  /**
   * The provider boundary.
   *
   * A model that is down, rate-limited or misconfigured is an upstream
   * failure, not a bug in the CMS, and the difference is visible: a
   * `CmsError` becomes its own status, anything else becomes a 500 whose
   * stack the operator is asked to read. `piCompletion` already raises 502
   * `ai_provider_error` itself; a project's own `ai.complete` is ordinary
   * user code that throws ordinary errors, so it is held to the same shape
   * here rather than at every call site.
   *
   * The provider's own message is forwarded, as the assistant already does
   * for the same class of failure: "Translation unavailable" is the sentence
   * the editor staring at the dialog needs, and `ai.task.failed` records it.
   * A cancelled request is not a failure at all and keeps the assistant's
   * 499, so closing a tab does not page anybody.
   */
  const complete: AiCompletionFn = async (request) => {
    try {
      return await configured(request);
    } catch (error) {
      if (error instanceof CmsError) throw error;
      if (request.signal?.aborted) {
        throw new CmsError("The request was cancelled.", {
          status: 499,
          code: "ai_aborted",
          cause: error,
        });
      }
      const message =
        error instanceof Error
          ? error.message
          : "The AI provider could not complete the request.";
      throw new CmsError(message, {
        status: 502,
        code: "ai_provider_error",
        cause: error,
      });
    }
  };

  const requireAi = () => {
    const ai = config.ai;
    if (!ai) {
      throw new CmsError(
        "This deployment has no `ai` section, so AI is switched off.",
        { status: 501, code: "ai_disabled" },
      );
    }
    return ai;
  };

  const collectionFor = (name: string): ResolvedCollection => {
    const all = { ...config.collections, ...config.globals };
    const direct = all[name];
    if (direct) return direct;
    const bySlug = Object.values(all).find(
      (collection) => collection.slug === name,
    );
    if (bySlug) return bySlug;
    throw CmsError.notFound(`No collection called "${name}".`);
  };

  /**
   * Credentials for one provider.
   *
   * A key stored in the panel wins over one in the configuration, because it
   * is the more recent decision by the operator who could see both: an
   * environment variable set a year ago should not quietly override the key
   * somebody typed into the settings screen this morning.
   */
  const authFor = async (provider: string): Promise<AiAuth> => {
    const ai = requireAi();
    const stored = await readCredential(options, provider);
    if (stored) return { type: "api-key", token: stored };
    const configured = ai.auth?.[provider];
    if (configured) return configured;
    throw new CmsError(
      `No credentials for the AI provider "${provider}". Add them to ai.auth or store them in the panel.`,
      { status: 500, code: "ai_credentials_missing" },
    );
  };

  const loadImage = async (mediaId: string): Promise<AiImageInput | null> => {
    if (!config.uploads) return null;
    try {
      const file = await options.cms().media.variant({ id: mediaId });
      if (!file || !file.contentType.startsWith("image/")) return null;
      const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
      return { contentType: file.contentType, data: bytes };
    } catch {
      // A file that cannot be read is a weaker prompt, not a failed action.
      return null;
    }
  };

  /**
   * One place where an AI event is recorded, whichever way it ended.
   *
   * The payload is metadata only — model, usage, duration, which tools ran,
   * which fields changed. Not the prompt, not the answer, not the record. An
   * audit trail has to survive being read by somebody who should not see the
   * content, and a webhook subscriber is exactly that somebody.
   */
  const record = async (
    type: AiEventType,
    data: JsonObject,
    actor: Actor | null,
    failure?: unknown,
  ): Promise<void> => {
    const adapter = await options.database();
    await adapter.transaction((tx) =>
      options.emit(
        tx,
        [
          {
            type,
            data:
              failure === undefined
                ? data
                : {
                    ...data,
                    error:
                      failure instanceof Error
                        ? failure.message
                        : String(failure),
                  },
            previous: null,
          },
        ],
        {
          actor,
          ...(typeof data.collection === "string"
            ? { collection: data.collection }
            : {}),
          ...(typeof data.documentId === "string"
            ? { documentId: data.documentId }
            : {}),
        },
      ),
    );
    options.deliver();
  };

  return {
    get enabled() {
      return config.ai !== undefined;
    },

    get assistantEnabled() {
      return config.ai !== undefined && config.ai.assistant?.enabled !== false;
    },

    actions(fieldType: string): string[] {
      return aiActionsFor(fieldType);
    },

    async run(args: AiRunArgs): Promise<AiRunResult> {
      const ai = requireAi();
      const collection = collectionFor(args.collection);
      const actor = args.actor ?? null;
      const locale = args.locale ?? config.i18n.defaultLocale;

      const field = collection.fields[args.field];
      if (!field) {
        throw CmsError.notFound(
          `"${args.field}" is not a field of ${collection.name}.`,
        );
      }

      const configured =
        args.action === "generate" ? field.aiGenerate : field.ai?.[args.action];
      const variantTranslation =
        args.variantTranslation === true &&
        args.action === "translate" &&
        field.localized &&
        ["text", "textarea", "richText", "email", "url"].includes(field.type);
      if (configured === undefined && !variantTranslation) {
        // The absence of a key is the absence of the feature, not a disabled
        // one: section 8 is explicit that a missing action is not in the
        // panel at all, so the route has to agree.
        throw CmsError.notFound(
          `"${args.action}" is not configured on ${collection.name}.${args.field}.`,
        );
      }
      const actionOptions: FieldAiAction =
        configured === undefined || configured === true ? {} : configured;
      const definition =
        getAiAction(args.action) ??
        customAiAction(args.action, actionOptions.prompt ?? "");

      if (definition.requiresLocalized && !field.localized) {
        throw CmsError.validation(
          `"${args.action}" needs a localized field; ${collection.name}.${args.field} stores one value for every language.`,
        );
      }

      const sourceLocale =
        args.sourceLocale ??
        (definition.requiresLocalized ? config.i18n.defaultLocale : locale);

      const { document, stored } = await loadDocument(
        options,
        collection,
        args,
        locale,
      );
      const sourceDocument =
        definition.requiresLocalized && sourceLocale !== locale
          ? (
              await loadDocument(
                options,
                collection,
                args,
                sourceLocale,
                args.variantTranslation === true,
              )
            ).document
          : document;

      // The same two checks a write would make, made before a token is
      // spent: a suggestion for a field the actor cannot write is a waste of
      // money and an invitation to paste it in by hand. The update rule is
      // given the *stored* document, exactly as a PATCH would hand it over —
      // never the browser's draft, which could claim any ownership it likes.
      await accessFilter(collection, {
        actor,
        operation: "update",
        locale,
        rbac: config.rbac,
        ...(stored === undefined ? {} : { record: stored }),
      });
      assertFieldWriteAccess(collection, { [args.field]: null }, actor, locale);

      const readable = visibleFields(collection, actor, locale);
      const contextFields = (actionOptions.context ?? []).filter((name) => {
        if (!(name in collection.fields)) {
          throw CmsError.validation(
            `ai.context names "${name}", which is not a field of ${collection.name}.`,
          );
        }
        return readable.has(name);
      });

      const model = actionOptions.model ?? ai.defaultModel;
      const auth = await authFor(model.provider);

      const context: AiActionContext = {
        action: args.action,
        value: (sourceDocument[args.field] ?? null) as JsonValue,
        field,
        fieldName: args.field,
        collection,
        context: Object.fromEntries(
          contextFields.map((name) => [name, document[name] ?? null]),
        ),
        document,
        locale,
        sourceLocale,
        options: actionOptions,
        model,
        actor,
        loadImage,
        complete: (request) => complete({ ...request, model, auth }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      };

      const started = Date.now();
      try {
        const outcome =
          variantTranslation && field.type === "richText"
            ? await translateVariantRichText(context)
            : await definition.run(context);
        await record(
          "ai.task.completed",
          {
            collection: collection.name,
            field: args.field,
            action: args.action,
            locale,
            provider: model.provider,
            model: model.model,
            usage: outcome.usage as unknown as JsonValue,
            durationMs: Date.now() - started,
            ...(args.id === undefined ? {} : { documentId: args.id }),
          },
          actor,
        );
        return {
          collection: collection.name,
          field: args.field,
          action: args.action,
          value: outcome.value,
          preview: outcome.preview,
          model,
          usage: outcome.usage,
        };
      } catch (error) {
        await record(
          "ai.task.failed",
          {
            collection: collection.name,
            field: args.field,
            action: args.action,
            locale,
            provider: model.provider,
            model: model.model,
            ...(args.id === undefined ? {} : { documentId: args.id }),
          },
          actor,
          error,
        );
        throw error;
      }
    },

    runAssistant(args: AiAssistantArgs): AsyncIterable<AiAssistantEvent> {
      // The tool runtime is an optional dependency. Keep the entire assistant
      // graph behind this boundary: importing `@heyo-sh/heyo-cms` must not
      // make a deployment that does not use the assistant resolve `typebox`
      // (or the pi packages) while its framework optimizes dependencies.
      return (async function* () {
        const { runAssistant } = await import("./assistant/run");
        yield* runAssistant({
          args,
          config,
          cms: options.cms(),
          database: () => options.database(),
          authFor,
          record,
        });
      })();
    },

    approveAssistantPlan(
      args: AiApprovePlanArgs,
    ): Promise<AiApprovePlanResult> {
      return import("./assistant/run").then(({ approvePlan }) =>
        approvePlan({
          args,
          config,
          cms: options.cms(),
          database: () => options.database(),
          record,
        }),
      );
    },

    async providers(): Promise<AiProviderStatus[]> {
      const ai = config.ai;
      const statuses = new Map<string, AiProviderStatus>();

      for (const [provider, auth] of Object.entries(ai?.auth ?? {})) {
        statuses.set(provider, {
          provider,
          configured: true,
          source: "config",
          type: auth.type,
          hint: null,
          updatedAt: null,
        });
      }

      if (ai?.storage?.secret) {
        const adapter = await options.database();
        const rows = await adapter.transaction((tx) =>
          adapter.query(tx, { table: aiCredentialsTable }),
        );
        for (const row of rows) {
          statuses.set(String(row.provider), {
            provider: String(row.provider),
            configured: true,
            source: "database",
            type: "api-key",
            hint: row.hint === null || row.hint === undefined ? null : String(row.hint), // prettier-ignore
            updatedAt: toIso(row.updated_at),
          });
        }
      }

      // The provider of the default model always appears, configured or not:
      // a settings screen that lists only what works cannot show what is
      // missing, which is the one thing somebody opening it wants to know.
      const fallback = ai?.defaultModel.provider;
      if (fallback && !statuses.has(fallback)) {
        statuses.set(fallback, {
          provider: fallback,
          configured: false,
          source: null,
          type: null,
          hint: null,
          updatedAt: null,
        });
      }

      return [...statuses.values()].sort((a, b) =>
        a.provider.localeCompare(b.provider),
      );
    },

    async setCredential(args: AiCredentialArgs): Promise<AiProviderStatus> {
      const ai = requireAi();
      const secret = ai.storage?.secret;
      if (!secret) {
        throw new CmsError(
          "Set ai.storage.secret to store provider keys in the database; without it keys can only come from ai.auth.",
          { status: 501, code: "ai_storage_disabled" },
        );
      }
      const token = args.token.trim();
      if (token.length === 0) {
        throw CmsError.validation("A provider key cannot be empty.");
      }

      const adapter = await options.database();
      const now = new Date();
      const encrypted = await encryptSecret(token, secret);
      const hint = keyHint(token);

      const status = await adapter.transaction(async (tx) => {
        const db = scopedDb(adapter, tx);
        const existing = await db.findOne(
          aiCredentialsTable,
          eq("provider", args.provider),
        );
        if (existing) {
          await db.update(aiCredentialsTable, eq("provider", args.provider), {
            secret: encrypted,
            hint,
            updated_at: now,
          });
        } else {
          await db.insert(aiCredentialsTable, {
            id: createId("aic"),
            provider: args.provider,
            auth_type: "api-key",
            secret: encrypted,
            hint,
            created_at: now,
            updated_at: now,
          });
        }
        return {
          provider: args.provider,
          configured: true,
          source: "database" as const,
          type: "api-key" as const,
          hint,
          updatedAt: now.toISOString(),
        };
      });

      return status;
    },

    async removeCredential(args: {
      provider: string;
      actor?: Actor | null;
    }): Promise<boolean> {
      requireAi();
      const adapter = await options.database();
      return adapter.transaction(async (tx) => {
        const db = scopedDb(adapter, tx);
        const count = await db.delete(
          aiCredentialsTable,
          eq("provider", args.provider),
        );
        return count > 0;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readCredential(
  options: AiServiceOptions,
  provider: string,
): Promise<string | null> {
  const secret = options.config.ai?.storage?.secret;
  if (!secret) return null;
  const adapter = await options.database();
  const row = await adapter.transaction(async (tx) => {
    const db = scopedDb(adapter, tx);
    return db.findOne(aiCredentialsTable, eq("provider", provider));
  });
  if (!row || typeof row.secret !== "string") return null;
  return decryptSecret(row.secret, secret);
}

/**
 * The document the model is told about.
 *
 * The stored document is read through `cms.api`, so access control, field
 * read rules and locale resolution all apply; the draft from the browser is
 * merged over it, because the editor is asking about what is on their screen
 * rather than what was saved before lunch.
 */
async function loadDocument(
  options: AiServiceOptions,
  collection: ResolvedCollection,
  args: { id?: string; document?: JsonObject; actor?: Actor | null },
  locale: string,
  noFallback = false,
): Promise<{ document: JsonObject; stored: JsonObject | undefined }> {
  const cms = options.cms();
  const actor = args.actor ?? null;
  let stored: JsonObject | undefined;

  if (collection.kind === "global") {
    const globals = cms.globals as unknown as Record<
      string,
      {
        get(args: {
          actor: Actor | null;
          locale: string;
          fallbackLocale?: false;
        }): Promise<JsonObject>;
      }
    >;
    const api = globals[collection.name];
    if (api)
      stored = await api.get({
        actor,
        locale,
        ...(noFallback ? { fallbackLocale: false as const } : {}),
      });
  } else if (args.id) {
    const api = (
      cms.api as unknown as Record<
        string,
        {
          findById(
            id: string,
            args: {
              actor: Actor | null;
              locale: string;
              fallbackLocale?: false;
            },
          ): Promise<JsonObject | null>;
        }
      >
    )[collection.name];
    const found = api
      ? await api.findById(args.id, {
          actor,
          locale,
          ...(noFallback ? { fallbackLocale: false as const } : {}),
        })
      : null;
    if (!found) {
      throw CmsError.notFound(
        `No ${collection.name} with id "${args.id}", or it is not readable.`,
      );
    }
    stored = found;
  }

  return { document: { ...(stored ?? {}), ...(args.document ?? {}) }, stored };
}

/** Field names this actor may read; the rest never reaches a prompt. */
function visibleFields(
  collection: ResolvedCollection,
  actor: Actor | null,
  locale: string,
): Set<string> {
  const visible = new Set<string>();
  for (const [name, field] of Object.entries(collection.fields)) {
    const rule = field.access?.read;
    if (rule && !rule({ actor, locale })) continue;
    visible.add(name);
  }
  return visible;
}
