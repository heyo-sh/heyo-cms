import { mock } from "bun:test";

import * as pi from "@mariozechner/pi-ai";

// The class itself, from the file that defines it rather than the package
// entry: Bun's `mock.module` is process-wide and keyed by the resolved file,
// so once any suite has mocked `@mariozechner/pi-agent-core` the entry
// answers with the mock, but `dist/agent.js` is still the real loop.
import { Agent as RealAgent } from "../../node_modules/@mariozechner/pi-agent-core/dist/agent.js";

/**
 * Which agent the assistant runs on, per suite.
 *
 * Bun runs every test file in one process, and a module mock made by one file
 * is still in force for the next. The suites that script the agent by hand
 * and the suites that drive pi's real loop therefore cannot each mock the
 * package their own way — whichever ran first would decide for both. So it is
 * mocked once, here, with a constructor that defers to whichever agent the
 * running suite asked for, and every suite says which one it wants in
 * `beforeAll`. The default is the real one.
 */
type AgentConstructor = new (options: never) => unknown;

let scripted: AgentConstructor | null = null;

export function useScriptedAgent(agent: AgentConstructor): void {
  scripted = agent;
}

export function useRealAgent(): void {
  scripted = null;
}

class Agent {
  constructor(options: never) {
    // A constructor may return another object; `new Agent()` then *is* that
    // object, which is what makes this a switch rather than a wrapper.
    return (scripted ? new scripted(options) : new RealAgent(options)) as Agent;
  }
}

mock.module("@mariozechner/pi-agent-core", () => ({ Agent }));

/**
 * Models pi does not ship, resolvable by `{ provider, model }` like the ones
 * it does: pi's own `faux` provider registers a stream function, but not an
 * entry in the static catalogue that `piModelFor` looks models up in.
 */
const extraModels = new Map<string, pi.Model<pi.Api>>();
const realGetModel = pi.getModel;

export function registerModel(model: pi.Model<pi.Api>): void {
  extraModels.set(`${model.provider}/${model.id}`, model);
}

mock.module("@mariozechner/pi-ai", () => ({
  ...pi,
  getModel: (provider: string, id: string) =>
    extraModels.get(`${provider}/${id}`) ??
    (realGetModel as (provider: string, id: string) => unknown)(provider, id),
}));
