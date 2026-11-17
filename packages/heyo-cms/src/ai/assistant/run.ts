/**
 * The panel-wide AI assistant.
 *
 * One agent, running inside the CMS process, with a small set of typed tools
 * that call the ordinary public API. That last part is the whole design: a
 * mutating tool goes through `cms.api.*` / `cms.globals.*` / `cms.media.*`
 * with the real actor and `source: "ai"`, so an agent write passes exactly the
 * same access control, field access, validation, hooks, media accounting,
 * events and activity log as somebody typing into the form.
 *
 * There is no SQL tool, no adapter access, no fetch, no file read and no
 * credential tool. The question "what could a prompt injection make this do"
 * has a bounded answer because the surface is bounded.
 *
 * Nothing re-exports this directory as a barrel on purpose: `ai/service.ts`
 * imports `./assistant/run` lazily, so a project without the assistant never
 * resolves the agent runtime's optional dependencies.
 */

import { CmsError } from "../../errors";
import { createId } from "../../ids";
import type { Actor } from "../../types/actor";
import type {
  AiApprovePlanArgs,
  AiApprovePlanResult,
  AiAssistantArgs,
  AiAssistantEvent,
  AiAssistantTurn,
  AiMutationTarget,
  AiPlanSummary,
  AiUsage,
} from "../../types/ai";
import type {
  AiAuth,
  AiAssistantConfig,
  ResolvedCmsConfig,
} from "../../types/config";
import type { DatabaseAdapter } from "../../types/database";
import type { AiModelRef } from "../../types/fields";
import type { CmsInstance } from "../../types/instance";
import type { JsonObject, JsonValue } from "../../types/json";
import { piAgentAuthOptions, piModelFor, toUsage } from "../pi";
import { requireCollection, resolvePageContext } from "./context";
import { assistantLimits } from "./limits";
import { PlanStore, planSummary, type PlanOperation } from "./plans";
import { assistantSystemPrompt } from "./prompt";
import { collectionApi, createAssistantTools, globalApi } from "./tools";
import {
  addUsage,
  agentRuntime,
  emptyUsage,
  type Agent,
  type AgentEvent,
} from "./runtime";

/**
 * The share of `timeoutMs` after which the run stops calling tools and
 * answers. The rest is for the answer itself: a deadline that only aborts
 * leaves the editor with an error after a minute and a half of waiting.
 */
const wrapUpAt = 0.75;
/**
 * How many of the slowest step so far the answer is allowed to take. The
 * answer is the longest thing a model writes in a run, so it gets two.
 */
const answerAllowance = 2;

/** What a tool says, and what the model is told, once the budget is spent. */
const wrapUpInstruction =
  "No more tool calls are available for this request. Do not call any tool. Answer the editor now from what you have already read, in their language, and say plainly what you could not finish.";

const noAnswer =
  "I could not put an answer together for that. Try asking again, or more specifically.";

/** Conversation limits, so one tab cannot post a novel. */
const maxHistoryMessages = 20;
const maxMessageChars = 12_000;
const maxRequestChars = 60_000;

export interface AssistantRunOptions {
  args: AiAssistantArgs;
  config: ResolvedCmsConfig;
  cms: CmsInstance;
  database: () => Promise<DatabaseAdapter>;
  authFor: (provider: string) => Promise<AiAuth>;
  record: (
    type:
      "ai.agent.completed" | "ai.agent.failed" | "ai.agent.mutation.applied",
    data: JsonObject,
    actor: Actor | null,
    failure?: unknown,
  ) => Promise<void>;
}

/**
 * One run of the assistant, as a stream of events the panel understands.
 *
 * An async generator rather than a callback or a `Response`: the HTTP layer
 * wants a stream, a test wants an array, and `cms.ai.runAssistant()` as a local
 * API wants to be awaited in a loop. All three are the same object here, and
 * none of them can see pi's own event vocabulary.
 */
export async function* runAssistant(
  options: AssistantRunOptions,
): AsyncGenerator<AiAssistantEvent> {
  const { args, config, cms } = options;
  const actor = args.actor ?? null;
  const runId = createId("air");
  const started = Date.now();

  const assistant = requireAssistant(config);
  const message = normaliseMessage(args.message);
  const history = normaliseHistory(args.history ?? [], message);

  // `locale` is the floor under the page context, not an alternative to it:
  // the screens that carry no record still carry a language, and a run that
  // fell back to the project default would search the wrong column for an
  // editor who has the panel in Polish.
  const page = resolvePageContext(config, args.pageContext, args.locale);
  const model: AiModelRef = assistant.model ?? config.ai!.defaultModel;
  const maxTurns = assistant.maxTurns ?? assistantLimits.maxTurns;
  const maxToolCalls = assistant.maxToolCalls ?? assistantLimits.maxToolCalls;
  const timeoutMs = assistant.timeoutMs ?? assistantLimits.timeoutMs;

  // The queue is how a push-shaped runtime becomes a pull-shaped generator:
  // the agent emits whenever it likes, and the caller consumes at its own
  // pace without any of them being dropped.
  const queue = new EventQueue();
  const plans = new PlanStore({ database: options.database });
  const mutations: { target: AiMutationTarget; fields: string[] }[] = [];
  const toolNames: string[] = [];
  let usage: AiUsage = emptyUsage();
  let spent = 0;
  let planned = 0;

  let agent: Agent | undefined;
  let failure: unknown;
  let turns = 0;
  let timedOut = false;
  /** Stopped because it would not stop calling tools after the wrap-up. */
  let overBudget = false;
  /** Whether the editor has been given an answer yet. */
  let answered = false;
  /**
   * The last thing the model said on its way to a tool call. Never shown on
   * its own — it is narration ("let me look that up") rather than an answer —
   * but it is better than an empty bubble when the model wrapped up inside
   * the same message as its last tool call and then had nothing to add.
   */
  let narration = "";
  /** The longest a single model step has taken so far in this run. */
  let slowestStep = 0;
  let stepStarted = started;
  /**
   * The text of the message being streamed, while it can still turn out to
   * be the answer (no tool call in it yet). Kept only so a run cut off by the
   * deadline in the middle of its answer shows what it had written.
   */
  let draft = "";
  let draftIsAnswer = false;

  /**
   * Whether the run has to stop calling tools and answer.
   *
   * A budget that simply aborted would cut the editor off mid-request with
   * nothing to show for the tokens already spent. Running out — of turns, of
   * tool calls, or of most of the time — instead switches the run into a
   * wrap-up: the tools refuse, the model is told to answer from what it has,
   * and only a model that ignores that is stopped outright.
   */
  const wrappingUp = () => {
    if (turns >= maxTurns || spent >= maxToolCalls) return true;
    const elapsed = Date.now() - started;
    // Time is measured against the model actually in use, not only as a
    // share of the budget: the answer is usually the longest step, and a
    // model that took eight seconds to pick a tool will not write six
    // summaries in the last quarter of a twenty-second budget.
    return (
      elapsed >= timeoutMs * wrapUpAt ||
      elapsed + slowestStep * answerAllowance >= timeoutMs
    );
  };

  // One controller for the two things that end a run early: the client
  // closing the socket, and the configured timeout. Both have to reach the
  // agent itself — a deadline that only sets a flag is a deadline that still
  // pays for the tokens, and a disconnected editor is the most likely way to
  // discover that.
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => agent?.abort(), {
    once: true,
  });
  const abort = () => controller.abort();
  args.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);

  try {
    const auth = await options.authFor(model.provider);
    const { Agent: AgentClass } = await agentRuntime();
    const piModel = await piModelFor(model);
    const authOptions = await piAgentAuthOptions(model.provider, auth);

    const tools = createAssistantTools({
      config,
      cms,
      actor,
      page,
      runId,
      plans,
      signal: controller.signal,
      spend: () => {
        if (wrappingUp()) {
          throw new CmsError(wrapUpInstruction, {
            status: 429,
            code: "ai_tool_budget_exhausted",
          });
        }
        spent += 1;
      },
      onMutation: (target, fields) => {
        mutations.push({ target, fields });
        queue.push({ type: "mutation-applied", runId, target, fields });
      },
      onPlan: (plan: AiPlanSummary) => {
        planned += 1;
        queue.push({ type: "approval-required", plan });
      },
    });

    agent = new AgentClass({
      initialState: {
        systemPrompt: assistantSystemPrompt({
          title: config.admin.title ?? "this CMS",
          instructions: assistant.instructions,
          page,
          defaultLocale: config.i18n.defaultLocale,
        }),
        model: piModel,
        thinkingLevel: thinkingLevelFor(piModel, assistant.thinking),
        tools,
        messages: piHistory(history, piModel),
      },
      ...authOptions,
      // The wrap-up, said to the model rather than only enforced on it. The
      // tools would refuse anyway, but a model that has been told it is out
      // of budget answers on this turn instead of spending it on a call that
      // fails. Appended to what the model reads, never to the transcript.
      transformContext: async (
        messages: AgentMessage[],
        signal?: AbortSignal,
      ) => {
        // pi goes on to the next model call after an abort, with the
        // aborted signal; refusing here means that call is never made.
        if (controller.signal.aborted || signal?.aborted) {
          throw new CmsError("The request was cancelled.", {
            status: 499,
            code: "ai_aborted",
          });
        }
        return wrappingUp()
          ? [
              ...messages,
              {
                role: "user",
                content: wrapUpInstruction,
                timestamp: Date.now(),
              } as AgentMessage,
            ]
          : messages;
      },
      // Never parallel. Two tool calls the model issued together could be two
      // writes to the same document, and letting them race would make the
      // revision check decide which of the model's own intentions survives.
      toolExecution: "sequential",
      maxRetryDelayMs: 5_000,
    });

    agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "turn_start": {
          turns += 1;
          stepStarted = Date.now();
          // One turn past the budget is the wrap-up answer; a model that
          // spends that on another tool call too is not going to stop.
          if (turns > maxTurns + 1) {
            overBudget = true;
            agent?.abort();
          }
          return;
        }
        case "message_start": {
          if (event.message.role !== "assistant") return;
          draft = "";
          draftIsAnswer = true;
          return;
        }
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update.type === "toolcall_start") draftIsAnswer = false;
          if (update.type === "text_delta") draft += update.delta;
          return;
        }
        case "message_end": {
          // `message_end` closes every message of the run, not only the
          // model's: the editor's own prompt and each tool result pass
          // through here too. Neither is an answer — the first is an echo,
          // the second is a raw record — and neither may reach the screen.
          if (event.message.role !== "assistant") return;
          usage = addUsage(usage, messageUsage(event.message));
          slowestStep = Math.max(slowestStep, Date.now() - stepStarted);
          const ended = (event.message as { stopReason?: string }).stopReason;
          // An abort closes the message too; what it had written by then is
          // kept for the failure path, everything else starts afresh.
          if (ended === "aborted" && !hasToolCalls(event.message)) {
            draft = assistantText(event.message).trim() || draft;
          } else {
            draft = "";
            draftIsAnswer = false;
          }

          // Only the message that ends the run is the answer. A message
          // that goes on to call a tool is the model talking to itself on
          // the way ("let me look that up"), which is what the progress
          // events are for; streaming it into the reply turned every answer
          // into a transcript of the work. Hence whole messages rather than
          // deltas: whether a message is the answer is only known when it
          // ends.
          const text = assistantText(event.message).trim();
          if (hasToolCalls(event.message)) {
            if (text.length > 0) narration = text;
            return;
          }
          const stopReason = (event.message as { stopReason?: string })
            .stopReason;
          if (stopReason === "error" || stopReason === "aborted") return;
          if (text.length === 0) return;
          queue.push({
            type: "text-delta",
            text: answered ? `\n\n${text}` : text,
          });
          answered = true;
          if (stopReason === "length") {
            queue.push({
              type: "text-delta",
              text: "\n\n[The answer was cut off at the model's output limit.]",
            });
          }
          return;
        }
        case "tool_execution_start": {
          toolNames.push(event.toolName);
          queue.push({
            type: "tool-start",
            id: event.toolCallId,
            label: toolLabel(tools, event.toolName),
          });
          return;
        }
        case "tool_execution_end": {
          queue.push({
            type: "tool-end",
            id: event.toolCallId,
            // Built here, from what the server knows. The raw result is a
            // record the editor may not be allowed to see in full, and the
            // model's own words about it are not evidence of anything.
            summary: summariseTool(event.toolName, event.isError),
          });
          return;
        }
        default:
          return;
      }
    });

    // Checked again, not only reacted to. Resolving credentials and a model
    // involves a dynamic import and is easily slower than somebody closing a
    // tab, and in that window there was no agent for the listener above to
    // stop. Prompting now and aborting a millisecond later would still send
    // the request to the provider.
    if (controller.signal.aborted) {
      throw new CmsError("The request was cancelled.", {
        status: 499,
        code: "ai_aborted",
      });
    }

    const settled = agent
      .prompt(message)
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        queue.close();
      });

    for await (const event of queue) yield event;
    await settled;

    // Said as what it is. Aborting the agent ends the run quietly, as if the
    // model had stopped, which would have been reported as a success with
    // nothing in it.
    if (failure === undefined && overBudget) {
      failure = new CmsError(
        `The assistant used its ${maxTurns} steps without finishing. Try a narrower request, or split it in two.`,
        { status: 429, code: "ai_budget_exhausted" },
      );
    }
    const errorMessage = agent.state.errorMessage;
    if (failure === undefined && errorMessage)
      failure = new Error(errorMessage);

    // A run that ended without a word still owes the editor one. The model's
    // last aside is the best available; failing that, a cards-only answer
    // (a save, a plan) speaks for itself, and anything else is said plainly
    // rather than left as an empty bubble.
    if (failure === undefined && !answered && !controller.signal.aborted) {
      const fallback =
        narration.length > 0
          ? narration
          : mutations.length > 0 || planned > 0
            ? ""
            : noAnswer;
      if (fallback.length > 0) {
        answered = true;
        yield { type: "text-delta", text: fallback };
      }
    }
  } catch (error) {
    failure = error;
    queue.close();
  } finally {
    clearTimeout(deadline);
    args.signal?.removeEventListener("abort", abort);
  }

  const durationMs = Date.now() - started;
  const metadata: JsonObject = {
    runId,
    provider: model.provider,
    model: model.model,
    durationMs,
    tools: toolNames,
    toolCalls: spent,
    mutations: mutations.length,
    usage: usage as unknown as JsonValue,
    ...(args.conversationId === undefined
      ? {}
      : { conversationId: args.conversationId }),
  };

  if (failure !== undefined) {
    const error = timedOut
      ? new CmsError(
          `The assistant ran out of time (${Math.round(timeoutMs / 1000)} s) before it could answer. Try a narrower request.`,
          { status: 504, code: "ai_timeout" },
        )
      : toCmsError(failure, controller.signal.aborted);
    await safely(() =>
      options.record("ai.agent.failed", metadata, actor, error),
    );
    // The deadline landed while the answer was being written. What exists
    // of it is shown, marked, next to the error — rather than throwing away
    // the one part of the run the editor was waiting for.
    const partial = draft.trim();
    if (timedOut && !answered && draftIsAnswer && partial.length > 0) {
      yield {
        type: "text-delta",
        text: `${partial}…\n\n[Ran out of time — this answer is incomplete.]`,
      };
    }
    yield { type: "error", code: error.code, message: error.message };
    return;
  }

  for (const mutation of mutations) {
    await safely(() =>
      options.record(
        "ai.agent.mutation.applied",
        {
          runId,
          target: mutation.target as unknown as JsonValue,
          fields: mutation.fields,
          ...(mutation.target.collection === undefined
            ? {}
            : { collection: mutation.target.collection }),
          documentId: mutation.target.id,
        },
        actor,
      ),
    );
  }
  await safely(() => options.record("ai.agent.completed", metadata, actor));
  yield { type: "done", runId, usage };
}

export interface ApprovePlanOptions {
  args: AiApprovePlanArgs;
  config: ResolvedCmsConfig;
  cms: CmsInstance;
  database: () => Promise<DatabaseAdapter>;
  record: (
    type:
      "ai.agent.completed" | "ai.agent.failed" | "ai.agent.mutation.applied",
    data: JsonObject,
    actor: Actor | null,
    failure?: unknown,
  ) => Promise<void>;
}

/**
 * Executing a plan a human approved.
 *
 * The model is not in this function and that is the whole point. The row is
 * read, the session is checked again, the permissions are checked again by
 * the engine on every write, and the operations run exactly as they were
 * stored. An approval that went back through the model would be an approval
 * of something the editor never saw.
 */
export async function approvePlan(
  options: ApprovePlanOptions,
): Promise<AiApprovePlanResult> {
  const { args, config, cms } = options;
  const actor = args.actor ?? null;
  requireAssistant(config);

  const plans = new PlanStore({ database: options.database });
  const plan = await plans.claim({ planId: args.planId, actor });
  const applied: AiApprovePlanResult["applied"] = [];

  try {
    for (const [index, operation] of plan.operations.entries()) {
      const target = await applyOperation({
        cms,
        config,
        actor,
        runId: plan.runId,
        operation,
        idempotencyKey: `${plan.id}:${index}`,
      });
      if (!target) continue;
      applied.push({ target, fields: operation.fields });
      await safely(() =>
        options.record(
          "ai.agent.mutation.applied",
          {
            runId: plan.runId,
            planId: plan.id,
            target: target as unknown as JsonValue,
            fields: operation.fields,
            ...(target.collection === undefined
              ? {}
              : { collection: target.collection }),
            documentId: target.id,
          },
          actor,
        ),
      );
    }
  } finally {
    // Written whatever happened: a plan that applied three of five operations
    // before a validation error has to be recoverable as "three of five", not
    // replayable from the start.
    await safely(() =>
      plans.complete(plan.id, { applied: applied as unknown as JsonValue }),
    );
  }

  return { planId: plan.id, runId: plan.runId, applied };
}

async function applyOperation(args: {
  cms: CmsInstance;
  config: ResolvedCmsConfig;
  actor: Actor | null;
  runId: string;
  operation: PlanOperation;
  idempotencyKey: string;
}): Promise<AiMutationTarget | null> {
  const { operation } = args;
  const context = { cms: args.cms };
  const common = {
    actor: args.actor,
    source: "ai" as const,
    runId: args.runId,
    idempotencyKey: args.idempotencyKey,
    ...(operation.locale === undefined || operation.locale === null
      ? {}
      : { locale: operation.locale }),
  };

  if (operation.action === "update-global") {
    const global = requireCollection(
      args.config,
      operation.collection ?? "",
      "global",
    );
    const updated = await globalApi(context, global).update({
      ...common,
      data: operation.data ?? {},
      ...(operation.expectedRevision === undefined
        ? {}
        : { expectedRevision: operation.expectedRevision }),
    });
    return updated === null
      ? null
      : {
          kind: "global",
          collection: global.name,
          collectionSlug: global.slug,
          id: String(updated.id),
          locale: operation.locale ?? null,
          revision: Number(updated.revision ?? 0),
        };
  }

  if (operation.action === "update-media") {
    const updated = await args.cms.media.update({
      id: operation.id ?? "",
      actor: args.actor,
      source: "ai",
      ...(operation.data ?? {}),
    });
    return { kind: "media", id: updated.id };
  }

  const collection = requireCollection(
    args.config,
    operation.collection ?? "",
    "collection",
  );
  const api = collectionApi(context, collection);

  const result =
    operation.action === "create"
      ? await api.create({ ...common, data: operation.data ?? {} })
      : operation.action === "update"
        ? await api.update({
            ...common,
            id: operation.id ?? "",
            data: operation.data ?? {},
            ...(operation.expectedRevision === undefined
              ? {}
              : { expectedRevision: operation.expectedRevision }),
          })
        : operation.action === "trash"
          ? await api.delete({ ...common, id: operation.id ?? "" })
          : operation.action === "restore"
            ? await api.restore({ ...common, id: operation.id ?? "" })
            : await api.purge({ ...common, id: operation.id ?? "" });

  return result === null
    ? null
    : {
        kind: "document",
        collection: collection.name,
        collectionSlug: collection.slug,
        id: String(result.id),
        locale: operation.locale ?? null,
        revision: Number(result.revision ?? 0),
      };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireAssistant(config: ResolvedCmsConfig): AiAssistantConfig {
  if (!config.ai) {
    throw new CmsError(
      "This deployment has no `ai` section, so the assistant is switched off.",
      { status: 501, code: "ai_disabled" },
    );
  }
  const assistant = config.ai.assistant ?? {};
  if (assistant.enabled === false) {
    throw new CmsError(
      "The assistant is switched off for this deployment (ai.assistant.enabled).",
      { status: 501, code: "ai_assistant_disabled" },
    );
  }
  return assistant;
}

function normaliseMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw CmsError.validation("A message is required.");
  }
  if (trimmed.length > maxMessageChars) {
    throw CmsError.validation(
      `A message may be at most ${maxMessageChars} characters.`,
    );
  }
  return trimmed;
}

/**
 * The conversation, trimmed from the front.
 *
 * Oldest first, because the recent turns are the ones the next answer depends
 * on. Truncating by character count as well as by message count matters: a
 * client can send twenty messages that are each under the per-message limit
 * and still ask the provider to read a book.
 */
function normaliseHistory(
  history: AiAssistantTurn[],
  message: string,
): AiAssistantTurn[] {
  const turns = history
    .filter(
      (turn) =>
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.text === "string" &&
        turn.text.trim().length > 0,
    )
    .map((turn) => ({
      role: turn.role,
      text: turn.text.slice(0, maxMessageChars),
    }))
    .slice(-maxHistoryMessages);

  let total = message.length;
  const kept: AiAssistantTurn[] = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    if (total + turn.text.length > maxRequestChars) break;
    total += turn.text.length;
    kept.unshift(turn);
  }
  return kept;
}

type PiModel = Awaited<ReturnType<typeof piModelFor>>;
type AgentMessage = import("@mariozechner/pi-agent-core").AgentMessage;

/** The transcript in pi's message shape, with zeroed usage for past turns. */
function piHistory(history: AiAssistantTurn[], model: PiModel): AgentMessage[] {
  const timestamp = Date.now();
  return history.map((turn, index) =>
    turn.role === "user"
      ? ({
          role: "user",
          content: turn.text,
          timestamp: timestamp + index,
        } as AgentMessage)
      : ({
          role: "assistant",
          content: [{ type: "text", text: turn.text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: timestamp + index,
        } as AgentMessage),
  );
}

function assistantText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function hasToolCalls(message: unknown): boolean {
  const content = (message as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "toolCall",
    )
  );
}

type ThinkingLevel = NonNullable<AiAssistantConfig["thinking"]>;

/**
 * How much the model reasons before each step.
 *
 * The configured level when there is one. Otherwise as little as the model
 * allows: for most models that is `off`, but a reasoning model that cannot
 * switch it off (OpenAI's GPT-5 family) reads an absent setting as its own
 * default, `medium` — which turned every lookup into a long, silent wait and
 * spent most of the tokens on thinking about which tool to call. Asking for
 * the lowest level it does support is what "off" means for those.
 */
function thinkingLevelFor(
  model: PiModel,
  configured: ThinkingLevel | undefined,
): ThinkingLevel {
  if (configured !== undefined) return configured;
  if (!model.reasoning) return "off";
  const map = (model as { thinkingLevelMap?: Record<string, unknown> })
    .thinkingLevelMap;
  // `minimal` is skipped on purpose: not every model pi lists as accepting
  // it does, and "low" is the floor every reasoning model shares.
  return (
    (["off", "low", "medium", "high"] as const).find(
      (level) => map?.[level] !== null,
    ) ?? "off"
  );
}

function messageUsage(message: unknown): AiUsage {
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return emptyUsage();
  return toUsage(usage as Parameters<typeof toUsage>[0]);
}

function toolLabel(
  tools: { name: string; label: string }[],
  name: string,
): string {
  return tools.find((tool) => tool.name === name)?.label ?? name;
}

/**
 * What the editor is told a tool did.
 *
 * Written from the tool's name and whether it failed, and nothing else. The
 * result itself can contain a whole document, and a trace that printed it
 * would put content on screen that the surrounding page may be deliberately
 * hiding.
 */
function summariseTool(name: string, isError: boolean): string {
  if (isError) return `${label(name)} — failed`;
  return label(name);
}

function label(name: string): string {
  switch (name) {
    case "describe_cms":
      return "Read the project schema";
    case "get_current_page":
      return "Read the current page";
    case "find_documents":
      return "Searched documents";
    case "get_document":
      return "Read a document";
    case "update_document":
      return "Saved a document";
    case "create_document":
      return "Prepared a new document";
    case "trash_document":
      return "Prepared a deletion";
    case "restore_document":
      return "Prepared a restore";
    case "get_global":
      return "Read a global";
    case "update_global":
      return "Saved a global";
    case "find_media":
      return "Searched the media library";
    case "get_media":
      return "Read a file";
    case "update_media":
      return "Saved a file";
    case "get_activity":
      return "Read the audit trail";
    case "create_mutation_plan":
      return "Prepared a batch of changes";
    default:
      return name;
  }
}

function toCmsError(failure: unknown, aborted: boolean): CmsError {
  if (failure instanceof CmsError) return failure;
  if (aborted) {
    return new CmsError("The request was cancelled.", {
      status: 499,
      code: "ai_aborted",
    });
  }
  const message =
    failure instanceof Error ? failure.message : "The assistant failed.";
  return new CmsError(message, { status: 502, code: "ai_assistant_failed" });
}

/** Telemetry must never be the reason a successful run reports a failure. */
async function safely(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error("[heyo-cms] could not record an AI event", error);
  }
}

/**
 * A bounded hand-off between the agent's callbacks and the generator.
 *
 * `Agent.subscribe` is synchronous and must not be made to wait, so events are
 * buffered rather than awaited. Unbounded buffering would turn a runaway run
 * into a memory leak, so the buffer drops the *oldest* text deltas once it is
 * full: losing the beginning of a paragraph nobody will read is strictly
 * better than losing the mutation event at the end of it.
 */
class EventQueue implements AsyncIterable<AiAssistantEvent> {
  private readonly buffer: AiAssistantEvent[] = [];
  private resolve: (() => void) | null = null;
  private closed = false;
  private static readonly limit = 2_000;

  push(event: AiAssistantEvent): void {
    if (this.closed) return;
    if (this.buffer.length >= EventQueue.limit) {
      const index = this.buffer.findIndex((entry) => entry.type === "text-delta"); // prettier-ignore
      if (index >= 0) this.buffer.splice(index, 1);
      else this.buffer.shift();
    }
    this.buffer.push(event);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AiAssistantEvent> {
    for (;;) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift() as AiAssistantEvent;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    }
  }
}
