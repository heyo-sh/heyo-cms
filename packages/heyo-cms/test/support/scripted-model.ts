import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type AssistantMessage,
  type Context,
  type Message,
  type StreamOptions,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";

import type { JsonObject } from "../../src/types/json";
import { registerModel } from "./agent-runtime";

/**
 * A model that is a script, for driving pi's real agent loop.
 *
 * pi's own `faux` provider underneath, so the loop, the streaming, the tool
 * argument validation and the abort handling are all pi's; only what the
 * model *says* is written by the test. Each step sees the context the loop
 * built for that call — system prompt, history, tool results — and can both
 * assert on it and answer from it, the way a real model reads an id out of a
 * search result before it asks for the record.
 *
 * `{ provider: "faux", model: "scripted" }` is an ordinary model;
 * `"scripted-reasoner"` is a reasoning model that cannot switch reasoning
 * off, like OpenAI's GPT-5 family.
 */

export const faux = registerFauxProvider({
  provider: "faux",
  models: [
    { id: "scripted", reasoning: false },
    { id: "scripted-reasoner", reasoning: true },
  ],
  // Small chunks, so every message arrives as many deltas the way a real
  // provider streams it: an aside that leaked would leak in pieces.
  tokenSize: { min: 1, max: 4 },
});
registerModel(faux.getModel("scripted") as never);
// A reasoning model that cannot switch reasoning off, like OpenAI's GPT-5.
registerModel({
  ...faux.getModel("scripted-reasoner"),
  thinkingLevelMap: { off: null },
} as never);

/**
 * The same script, streamed slowly: about eighty characters a second, so a
 * test can have the deadline land in the middle of an answer. Provider
 * `faux-slow`, model `scripted`.
 */
export const slowFaux = registerFauxProvider({
  provider: "faux-slow",
  models: [{ id: "scripted", reasoning: false }],
  tokenSize: { min: 1, max: 1 },
  tokensPerSecond: 20,
});
registerModel(slowFaux.getModel("scripted") as never);

/** What one model call was given. */
export interface Call {
  context: Context;
  options: StreamOptions & { reasoning?: string };
  signal: AbortSignal | undefined;
  /** Made after the run was already stopped: a request nobody wanted. */
  abortedAtCall: boolean;
}

/** Every model call of the current script, in order. */
export const calls: Call[] = [];

export type Step = (turn: Turn) => AssistantMessage | Promise<AssistantMessage>;

/** One model call, with the helpers a script reads its context through. */
export class Turn {
  constructor(
    readonly context: Context,
    readonly options: Call["options"],
  ) {}

  get messages(): Message[] {
    return this.context.messages;
  }

  /** The results of the tool calls made in the previous model message. */
  results(): ToolResultMessage[] {
    let lastAssistant = -1;
    this.messages.forEach((message, index) => {
      if (message.role === "assistant") lastAssistant = index;
    });
    return this.messages
      .slice(lastAssistant + 1)
      .filter((message): message is ToolResultMessage => message.role === "toolResult"); // prettier-ignore
  }

  /** A tool result's text, parsed as the JSON every tool answers with. */
  json(index = 0): JsonObject {
    return JSON.parse(this.text(index)) as JsonObject;
  }

  text(index = 0): string {
    const result = this.results()[index];
    if (!result) throw new Error(`the model was given no tool result #${index}`); // prettier-ignore
    return result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }

  /** The last message the model reads, flattened to text. */
  lastText(): string {
    const last = this.messages.at(-1);
    if (!last) return "";
    if (typeof last.content === "string") return last.content;
    return last.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }

  toldToWrapUp(): boolean {
    const last = this.messages.at(-1);
    return last?.role === "user" && /No more tool calls/.test(this.lastText());
  }
}

/** Queues a script: one step per model call, in order. */
export function model(...steps: Step[]): void {
  calls.length = 0;
  const responses = () =>
    steps.map(
      (step) =>
        async (context: Context, options: StreamOptions | undefined) => {
          // Copied, because the loop keeps appending to the same array and an
          // assertion made later would see messages from the future.
          const snapshot = structuredClone({
            systemPrompt: context.systemPrompt,
            messages: context.messages,
            tools: context.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), // prettier-ignore
          }) as Context;
          calls.push({ context: snapshot, options: (options ?? {}) as Call["options"], signal: options?.signal, abortedAtCall: options?.signal?.aborted === true }); // prettier-ignore
          return step(new Turn(snapshot, (options ?? {}) as Call["options"]));
        },
    );
  // Both providers get the script; a test uses one of them.
  faux.setResponses(responses());
  slowFaux.setResponses(responses());
}

/** The same step, as many times as the loop might ask. */
export function repeat(step: Step, times = 12): Step[] {
  return Array.from({ length: times }, () => step);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export const call = fauxToolCall;
export const say = (text: string) => fauxAssistantMessage(text);
export const act = (aside: string | null, ...tools: ReturnType<typeof fauxToolCall>[]) => // prettier-ignore
  fauxAssistantMessage([...(aside ? [fauxText(aside)] : []), ...tools], { stopReason: "toolUse" }); // prettier-ignore

/** No script, no calls: what every test starts from. */
export function resetModel(): void {
  calls.length = 0;
  faux.setResponses([]);
  slowFaux.setResponses([]);
}

export { fauxAssistantMessage, fauxText };
