import type {
  AiAssistantEvent,
  AiMutationTarget,
  AiPageContext,
  AiPlanSummary,
} from "@heyo-sh/heyo-cms/types";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { api, ApiError, mount } from "./api";
import { routePageContext } from "./page-context";
import { usePanel } from "./panel";
import { useRouter } from "./router";

/**
 * The assistant's state, above the router.
 *
 * Mounted once, outside `App`, and that placement is the whole point: the
 * editor asks a question on `/c/posts/abc`, navigates to `/media` to check
 * something, and comes back. A conversation that lived inside a screen would
 * be unmounted twice in that sentence.
 *
 * Nothing is persisted. The history is in memory for this tab only — no
 * `sessionStorage`, no server-side transcript. A reload loses the
 * conversation, which is a real cost, paid deliberately: the alternative is
 * CMS content sitting in browser storage on a shared machine.
 */

export interface AssistantTurn {
  role: "user" | "assistant";
  text: string;
  /** Tool activity, in the order it happened. Assistant turns only. */
  steps?: AssistantStep[];
  mutations?: { target: AiMutationTarget; fields: string[] }[];
  plans?: AiPlanSummary[];
  error?: { code: string; message: string };
}

export interface AssistantStep {
  id: string;
  label: string;
  summary?: string;
}

/** Announced to screens when the agent writes something they may be showing. */
export interface AssistantMutationNotice {
  target: AiMutationTarget;
  fields: string[];
  at: number;
}

interface AssistantValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  turns: AssistantTurn[];
  streaming: boolean;
  /** `null` when the assistant can run; otherwise why it cannot. */
  unavailable: string | null;
  send: (message: string) => void;
  stop: () => void;
  clear: () => void;
  approve: (planId: string) => Promise<void>;
  /** Screens register what they are showing, so the agent can be told. */
  setPageContext: (context: AiPageContext | null) => void;
  /**
   * The sub-surface in front, registered by whatever draws the tabs.
   *
   * A second, narrower channel rather than a field of `setPageContext`,
   * because the two facts have different owners: the screen knows which
   * record is open, and the component with the tab strip inside it knows
   * which tab is. One ref for both would have them overwrite each other on
   * every render, and the loser would be whichever happened to be deeper in
   * the tree.
   */
  setPageTab: (tab: string | null) => void;
  /** Screens subscribe to writes the agent made. Returns an unsubscribe. */
  onMutation: (
    listener: (notice: AssistantMutationNotice) => void,
  ) => () => void;
}

const AssistantContext = createContext<AssistantValue | null>(null);

export function useAssistant(): AssistantValue {
  const value = useContext(AssistantContext);
  if (!value) {
    throw new Error(
      "useAssistant() is only available inside AssistantProvider.",
    );
  }
  return value;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { config, locale } = usePanel();
  const { path } = useRouter();

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [streaming, setStreaming] = useState(false);

  const abort = useRef<AbortController | null>(null);
  const conversationId = useRef(createConversationId());
  // A ref rather than state: a screen re-registering its context must not
  // re-render the whole panel, and the value is only ever read at send time.
  const pageContext = useRef<AiPageContext | null>(null);
  const pageTab = useRef<string | null>(null);
  const listeners = useRef(
    new Set<(notice: AssistantMutationNotice) => void>(),
  );
  // The transcript, as the server needs it. Kept alongside `turns` because
  // `turns` carries UI-only detail the model must not be sent.
  const history = useRef<{ role: "user" | "assistant"; text: string }[]>([]);

  const unavailable = !config.ai.configured
    ? "AI is not configured for this deployment. Add a provider key and a default model first."
    : !config.ai.assistant
      ? "The assistant is switched off for this deployment (ai.assistant.enabled)."
      : null;

  // Leaving a document screen without replacing the context would leave the
  // agent reading a stale "you are on doc_123" forever.
  useEffect(() => {
    return () => {
      pageContext.current = null;
      pageTab.current = null;
    };
  }, [path]);

  const setPageContext = useCallback((context: AiPageContext | null) => {
    pageContext.current = context;
  }, []);

  const setPageTab = useCallback((tab: string | null) => {
    pageTab.current = tab;
  }, []);

  const onMutation = useCallback(
    (listener: (notice: AssistantMutationNotice) => void) => {
      listeners.current.add(listener);
      return () => {
        listeners.current.delete(listener);
      };
    },
    [],
  );

  const announce = useCallback((notice: AssistantMutationNotice) => {
    for (const listener of listeners.current) listener(notice);
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setStreaming(false);
  }, []);

  const clear = useCallback(() => {
    stop();
    setTurns([]);
    history.current = [];
    conversationId.current = createConversationId();
  }, [stop]);

  const send = useCallback(
    (message: string) => {
      const text = message.trim();
      if (text.length === 0 || unavailable || streaming) return;

      // Opening on the first message rather than on a button: the composer is
      // the entry point, and a panel that opened empty would ask the editor to
      // do two things before anything happens.
      setOpen(true);
      setStreaming(true);
      setTurns((current) => [
        ...current,
        { role: "user", text },
        { role: "assistant", text: "", steps: [] },
      ]);

      const sentHistory = [...history.current];
      history.current = [...sentHistory, { role: "user", text }];

      const controller = new AbortController();
      abort.current = controller;
      // Accumulated here rather than read back out of `turns` afterwards: a
      // state updater is not a place for a side effect, because React is
      // allowed to run one more than once for a single update.
      let answer = "";

      // Where the editor is, with the route as the floor under it. A send
      // can happen before the screen's effect has registered anything, and
      // some paths have no screen that would — the panel's own "nothing
      // here". Sending nothing at all is the one answer that is wrong
      // everywhere: the server reads an absent context as the dashboard in
      // the default language.
      const page = pageContext.current ?? routePageContext(path, config);

      void stream({
        body: {
          conversationId: conversationId.current,
          message: text,
          history: sentHistory,
          pageContext: {
            ...page,
            // The tab belongs to whatever drew the tab strip, and nothing
            // else is allowed to have an opinion about it.
            ...(pageTab.current === null ? {} : { tab: pageTab.current }),
            // The panel edits one language at a time and this is it. A
            // screen that knows better (it is reading a different locale)
            // keeps its own, which is why this is a default and not an
            // override.
            locale: page.locale ?? locale,
          },
        },
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text-delta") answer += event.text;
          setTurns((current) => apply(current, event));
          if (event.type === "mutation-applied") {
            announce({
              target: event.target,
              fields: event.fields,
              at: Date.now(),
            });
          }
        },
      })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setTurns((current) =>
            apply(current, {
              type: "error",
              code: error instanceof ApiError ? error.code : "request_failed",
              message:
                error instanceof Error
                  ? error.message
                  : "The assistant could not be reached.",
            }),
          );
        })
        .finally(() => {
          if (abort.current === controller) abort.current = null;
          setStreaming(false);
          // A run that only called tools, or that failed, has nothing to add
          // to the transcript; sending an empty assistant turn back would
          // teach the model that empty answers are acceptable.
          if (answer.length > 0) {
            history.current = [
              ...history.current,
              { role: "assistant", text: answer },
            ];
          }
        });
    },
    [announce, config, locale, path, streaming, unavailable],
  );

  const approve = useCallback(
    async (planId: string) => {
      const result = await api.post<{
        applied: { target: AiMutationTarget; fields: string[] }[];
      }>(`/ai/assistant/plans/${planId}/approve`);

      // Only the turn that was holding the plan. Appending the result to
      // every turn would put a "Saved" card on answers that had nothing to do
      // with it, which is a lie about what each of them did.
      setTurns((current) =>
        current.map((turn) => {
          if (!turn.plans?.some((plan) => plan.id === planId)) return turn;
          return {
            ...turn,
            plans: turn.plans.filter((plan) => plan.id !== planId),
            mutations: [...(turn.mutations ?? []), ...(result.applied ?? [])],
          };
        }),
      );
      for (const entry of result.applied ?? []) {
        announce({
          target: entry.target,
          fields: entry.fields,
          at: Date.now(),
        });
      }
    },
    [announce],
  );

  const value = useMemo<AssistantValue>(
    () => ({
      open,
      setOpen,
      turns,
      streaming,
      unavailable,
      send,
      stop,
      clear,
      approve,
      setPageContext,
      setPageTab,
      onMutation,
    }),
    [
      approve,
      clear,
      onMutation,
      open,
      send,
      setPageContext,
      setPageTab,
      stop,
      streaming,
      turns,
      unavailable,
    ],
  );

  return (
    <AssistantContext.Provider value={value}>
      {children}
    </AssistantContext.Provider>
  );
}

/**
 * Reads `text/event-stream` with `fetch`, not `EventSource`.
 *
 * `EventSource` is GET-only and cannot send a body, a header or an abort —
 * and this request needs all three. The parser is small because the server's
 * format is small: one `data:` line per event, blank line between.
 */
async function stream(options: {
  body: unknown;
  signal: AbortSignal;
  onEvent: (event: AiAssistantEvent) => void;
}): Promise<void> {
  const response = await fetch(`${mount.basePath}/ai/assistant`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-heyo-cms-client": "admin",
    },
    body: JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    throw new ApiError(
      payload?.error?.message ?? `The assistant answered ${response.status}.`,
      response.status,
      payload?.error?.code ?? "request_failed",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (payload.length > 0) {
        try {
          options.onEvent(JSON.parse(payload) as AiAssistantEvent);
        } catch {
          // A frame we cannot parse is a frame from a newer server. Dropping
          // it is better than ending a conversation that is otherwise fine.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

/** One event, folded into the assistant turn that is being built. */
// eslint-disable-next-line complexity
function apply(
  turns: AssistantTurn[],
  event: AiAssistantEvent,
): AssistantTurn[] {
  const index = turns.length - 1;
  const last = turns[index];
  if (!last || last.role !== "assistant") return turns;

  const next = (patch: Partial<AssistantTurn>): AssistantTurn[] => {
    const updated = [...turns];
    updated[index] = { ...last, ...patch };
    return updated;
  };

  switch (event.type) {
    case "text-delta":
      return next({ text: last.text + event.text });
    case "tool-start":
      return next({
        steps: [...(last.steps ?? []), { id: event.id, label: event.label }],
      });
    case "tool-end":
      return next({
        steps: (last.steps ?? []).map((step) =>
          step.id === event.id ? { ...step, summary: event.summary } : step,
        ),
      });
    case "mutation-applied":
      return next({
        mutations: [
          ...(last.mutations ?? []),
          { target: event.target, fields: event.fields },
        ],
      });
    case "approval-required":
      return next({ plans: [...(last.plans ?? []), event.plan] });
    case "error":
      return next({ error: { code: event.code, message: event.message } });
    default:
      // `done` carries the usage, which the panel does not show, and a frame
      // from a newer server carries something this version has never heard
      // of. Both leave the transcript alone.
      return turns;
  }
}

function createConversationId(): string {
  return `conv_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
