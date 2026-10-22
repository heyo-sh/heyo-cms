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

  let agent: Agent | undefined;
  let failure: unknown;

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
  const deadline = setTimeout(abort, timeoutMs);

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
        spent += 1;
        if (spent > maxToolCalls) {
          throw new CmsError(
            `This request has used its ${maxToolCalls} tool calls. Summarise what you have and stop.`,
            { status: 429, code: "ai_tool_budget_exhausted" },
          );
        }
      },
      onMutation: (target, fields) => {
        mutations.push({ target, fields });
        queue.push({ type: "mutation-applied", runId, target, fields });
      },
      onPlan: (plan: AiPlanSummary) => {
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
        thinkingLevel: "off",
        tools,
        messages: piHistory(history, piModel),
      },
      ...authOptions,
      // Never parallel. Two tool calls the model issued together could be two
      // writes to the same document, and letting them race would make the
      // revision check decide which of the model's own intentions survives.
      toolExecution: "sequential",
      maxRetryDelayMs: 5_000,
    });

    let turns = 0;
    let streamedText = false;

    agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "turn_start": {
          turns += 1;
          if (turns > maxTurns) agent?.abort();
          return;
        }
        case "message_start": {
          if (event.message.role === "assistant") streamedText = false;
          return;
        }
        case "message_update": {
          if (event.assistantMessageEvent.type !== "text_delta") return;
          streamedText = true;
          queue.push({
            type: "text-delta",
            text: event.assistantMessageEvent.delta,
          });
          return;
        }
        case "message_end": {
          const text = assistantText(event.message);
          // A provider that does not stream deltas still owes the editor the
          // answer; without this the conversation would simply be blank.
          if (!streamedText && text.length > 0) {
            queue.push({ type: "text-delta", text });
          }
          usage = addUsage(usage, messageUsage(event.message));
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

    const errorMessage = agent.state.errorMessage;
    if (failure === undefined && errorMessage)
      failure = new Error(errorMessage);
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
    const error = toCmsError(failure, controller.signal.aborted);
    await safely(() =>
      options.record("ai.agent.failed", metadata, actor, error),
    );
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
