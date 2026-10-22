import { CmsError } from "../../errors";
import type { AiUsage } from "../../types/ai";

/**
 * `@mariozechner/pi-agent-core`, under the floor.
 *
 * The same arrangement as `pi-ai` in `../pi.ts` and for the same two reasons:
 * a deployment without AI must not carry an agent runtime in its bundle, and
 * the package is an optional peer dependency — a CMS that refused to start
 * because the agent library is missing would make the assistant mandatory in
 * all but name.
 *
 * The one difference is that there is no fallback. `ai.complete` is a real
 * seam for a field action, because a field action is one prompt and one
 * answer. An agent is a tool-call loop, and a single completion cannot
 * emulate one; pretending otherwise would produce an assistant that confidently
 * describes writes it never made. So when the package is absent the endpoint
 * says so, by name.
 */

type AgentModule = typeof import("@mariozechner/pi-agent-core");

export type Agent = InstanceType<AgentModule["Agent"]>;
export type AgentTool = import("@mariozechner/pi-agent-core").AgentTool;
export type AgentEvent = Parameters<Parameters<Agent["subscribe"]>[0]>[0];

let loaded: Promise<AgentModule> | undefined;

export async function agentRuntime(): Promise<AgentModule> {
  loaded ??= import("@mariozechner/pi-agent-core").catch(() => {
    throw new CmsError(
      'The AI assistant needs "@mariozechner/pi-agent-core". Install it alongside "@mariozechner/pi-ai", or remove ai.assistant.',
      { status: 501, code: "ai_assistant_runtime_missing" },
    );
  });
  return loaded;
}

/** What a tool hands back to the model. Text only, by construction. */
export function toolText(text: string): {
  content: { type: "text"; text: string }[];
  details: Record<string, never>;
} {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/** The empty usage a run that never reached a model still has to report. */
export function emptyUsage(): AiUsage {
  return { input: 0, output: 0, total: 0, cost: 0 };
}

export function addUsage(left: AiUsage, right: AiUsage): AiUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    total: left.total + right.total,
    cost: left.cost + right.cost,
  };
}
