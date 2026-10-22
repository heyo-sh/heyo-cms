import { CmsError } from "../errors";
import type {
  AiCompletionFn,
  AiCompletionRequest,
  AiCompletionResult,
  AiUsage,
} from "../types/ai";
import type { AiAuth } from "../types/config";
import type { AiModelRef } from "../types/fields";

type PiApi = import("@mariozechner/pi-ai").Api;
type PiModel<T extends PiApi> = import("@mariozechner/pi-ai").Model<T>;

/**
 * The two ways pi lets a caller authenticate, as the agent takes them.
 *
 * Typed structurally rather than against `AgentOptions` on purpose: this file
 * must stay importable when `@mariozechner/pi-agent-core` is not installed,
 * which is the normal case for a deployment that only uses field actions.
 */
export interface PiAgentAuthOptions {
  getApiKey?: (provider?: string) => string | Promise<string>;
  streamFn?: (
    ...args: Parameters<typeof import("@mariozechner/pi-ai").streamSimple>
  ) => ReturnType<typeof import("@mariozechner/pi-ai").streamSimple>;
}

/**
 * pi, under the floor.
 *
 * The same arrangement as `heyo-docs` (section 8): pi owns the provider
 * catalogue and the transport, and it never appears in the configuration. A
 * user writes `{ provider: "openai", model: "gpt-4o-mini" }` and the only
 * thing this file does is look that pair up, attach the right kind of
 * credential, and hand back text and a token count.
 *
 * Imported dynamically for two reasons that both matter in this project: a
 * deployment without an `ai` section must not carry a provider catalogue in
 * its bundle, and `@mariozechner/pi-ai` is an optional peer dependency — a
 * CMS that refuses to start because AI is not installed would make AI
 * mandatory in all but name.
 */

type PiModule = typeof import("@mariozechner/pi-ai");

let loaded: Promise<PiModule> | undefined;

export async function pi(): Promise<PiModule> {
  loaded ??= import("@mariozechner/pi-ai").catch(() => {
    throw new CmsError(
      'AI needs "@mariozechner/pi-ai". Install it, or set ai.complete to your own implementation.',
      { status: 500, code: "ai_runtime_missing" },
    );
  });
  return loaded;
}

/**
 * The model object pi works with, from the `{ provider, model }` pair the
 * configuration carries.
 *
 * Shared with the agent rather than reimplemented beside it: a one-shot
 * completion and an agent run must not disagree about which model
 * `{ provider: "openai", model: "gpt-4o-mini" }` names, and the failure mode
 * if they did would be a run that silently costs ten times as much.
 */
export async function piModelFor(
  reference: AiModelRef,
): Promise<PiModel<PiApi>> {
  const { getModel } = await pi();
  let model: PiModel<PiApi> | undefined;
  try {
    model = getModel(
      reference.provider as never,
      reference.model as never,
    ) as PiModel<PiApi>;
  } catch {
    model = undefined;
  }
  if (model) return model;
  await assertModelExists(reference.provider, reference.model);
  throw new CmsError(
    `pi could not resolve ${reference.provider}/${reference.model}.`,
    { status: 500, code: "ai_unknown_model" },
  );
}

/**
 * Refuses credentials a provider cannot use, before a request is built.
 *
 * The alternative is a 401 from somebody else's API with a message about a
 * header the operator never wrote.
 */
export function assertAuthMatches(provider: string, auth: AiAuth): void {
  const allowed = authTypesForAiProvider(provider);
  if (allowed.includes(auth.type)) return;
  throw new CmsError(
    `The provider "${provider}" needs ${allowed.map((type) => `"${type}"`).join(" or ")} credentials.`,
    { status: 500, code: "ai_auth_mismatch" },
  );
}

/**
 * How the agent authenticates, in pi's own vocabulary.
 *
 * API keys and OAuth are a function that produces a bearer token; Bedrock is
 * not, because AWS signs the request rather than carrying a token, so it has
 * to replace the stream function instead. Keeping all three here — rather
 * than in the agent — is what makes `ai.auth` mean the same thing for a field
 * action and for the assistant.
 */
export async function piAgentAuthOptions(
  provider: string,
  auth: AiAuth,
): Promise<PiAgentAuthOptions> {
  assertAuthMatches(provider, auth);
  switch (auth.type) {
    case "api-key":
      return { getApiKey: () => auth.token };
    case "oauth":
      return { getApiKey: () => auth.getAccessToken() };
    case "aws": {
      // AWS signs the request rather than carrying a token, so there is no
      // key to hand over; the only way to get the region and the credentials
      // in is to replace the stream function itself.
      const { streamSimple } = await pi();
      return {
        streamFn: (model, context, options) =>
          streamSimple(model, context, {
            ...options,
            region: auth.region,
            ...(auth.accessKeyId === undefined
              ? {}
              : { accessKeyId: auth.accessKeyId }),
            ...(auth.secretAccessKey === undefined
              ? {}
              : { secretAccessKey: auth.secretAccessKey }),
          } as Parameters<PiModule["streamSimple"]>[2]),
      };
    }
  }
}

/** Which credential kinds a provider accepts. The same table as heyo-docs. */
const oauthProviders = new Set(["github-copilot", "openai-codex"]);

export function authTypesForAiProvider(
  provider: string,
): readonly AiAuth["type"][] {
  if (provider === "amazon-bedrock") return ["aws"];
  if (oauthProviders.has(provider)) return ["oauth"];
  return ["api-key"];
}

/**
 * Checks a provider and model against the catalogue pi actually ships.
 *
 * Done before a request leaves, so a typo in a model name is an error that
 * names the provider rather than a 404 from somebody's API an hour later.
 */
export async function assertModelExists(
  provider: string,
  model: string,
): Promise<void> {
  const { getModel, getProviders } = await pi();
  try {
    const known = getModel(provider as never, model as never);
    if (known) return;
  } catch {
    // getModel throws on an unknown pair; the message below is better.
  }
  const providers = getProviders() as string[];
  if (!providers.includes(provider)) {
    throw new CmsError(`The AI provider "${provider}" is not in pi's catalogue.`, { status: 400, code: "ai_unknown_provider" }); // prettier-ignore
  }
  throw new CmsError(
    `The provider "${provider}" has no model called "${model}".`,
    { status: 400, code: "ai_unknown_model" },
  );
}

/** Models pi knows for a provider; empty when the provider is unknown. */
export async function modelsForProvider(provider: string): Promise<string[]> {
  try {
    const { getModels } = await pi();
    return (getModels(provider as never) as { id: string }[]).map(
      (model) => model.id,
    );
  } catch {
    return [];
  }
}

/**
 * The default completion: one prompt in, one answer out.
 *
 * Non-streaming on purpose. A field action produces a value that a person
 * approves before it is stored, so the only thing streaming would buy is a
 * progress animation — at the price of a second transport contract through
 * the handler, the adapters and the panel.
 */
export const piCompletion: AiCompletionFn = async (
  request: AiCompletionRequest,
): Promise<AiCompletionResult> => {
  const { complete, stream } = await pi();
  const { model: modelRef, auth } = request;

  assertAuthMatches(modelRef.provider, auth);
  const model = await piModelFor(modelRef);

  const context = {
    systemPrompt: request.system,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: request.prompt },
          ...(request.images ?? []).map((image) => ({
            type: "image" as const,
            data: base64(image.data),
            mimeType: image.contentType,
          })),
        ],
        timestamp: Date.now(),
      },
    ],
  };

  const options = {
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }), // prettier-ignore
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(auth.type === "api-key" ? { apiKey: auth.token } : {}),
    ...(auth.type === "oauth" ? { apiKey: await auth.getAccessToken() } : {}),
    ...(auth.type === "aws"
      ? {
          region: auth.region,
          ...(auth.accessKeyId === undefined
            ? {}
            : { accessKeyId: auth.accessKeyId }),
          ...(auth.secretAccessKey === undefined
            ? {}
            : { secretAccessKey: auth.secretAccessKey }),
        }
      : {}),
  };

  // `stream` is referenced so the Bedrock path keeps pi's own options
  // handling; `complete` drains it and returns the finished message.
  void stream;
  const message = await complete(model, context, options);

  if (message.stopReason === "error" || message.errorMessage) {
    throw new CmsError(message.errorMessage ?? "The model returned an error.", {
      status: 502,
      code: "ai_provider_error",
    });
  }

  const text = message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");

  return { text, usage: toUsage(message.usage) };
};

export function toUsage(usage: {
  input: number;
  output: number;
  totalTokens: number;
  cost: { total: number };
}): AiUsage {
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    total: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
    cost: usage.cost?.total ?? 0,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
