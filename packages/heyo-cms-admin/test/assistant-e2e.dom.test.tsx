import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Before anything else: the panel reads `document` while its modules are
// evaluated, so the DOM has to exist before the first import of the app.
GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { act as actType } from "react";
import type { Root } from "react-dom/client";

import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, heyoCms, systemActor } from "../../heyo-cms/src/config"; // prettier-ignore
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import { text } from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import type { Actor } from "../../heyo-cms/src/types/actor";
import type { CmsEvent } from "../../heyo-cms/src/types/events";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";
import { useRealAgent } from "../../heyo-cms/test/support/agent-runtime";
import {
  act as acting,
  call,
  calls,
  fauxAssistantMessage,
  model,
  resetModel,
  say,
  sleep,
} from "../../heyo-cms/test/support/scripted-model";
import { findControl } from "./controls";

/**
 * The assistant, the whole way through.
 *
 * Every other panel suite answers `/ai/assistant` with a scripted stream, and
 * every engine suite checks the stream without a panel reading it. Each half
 * agreed with itself, and the editor still saw their own question echoed back
 * followed by raw JSON: the bug was in what crossed the boundary.
 *
 * Nothing crosses a mock here. The panel posts to the real handler, the
 * handler runs pi's real agent loop with the real tools against a real
 * database, and the only thing that is scripted is what the model says —
 * pi's `faux` provider, streaming in small chunks, reacting to the tool
 * results it is actually given. What is asserted is what an editor sees.
 */

const adapter = sqlite(new Database(":memory:"));
const editor: Actor = {
  id: "usr_editor",
  source: "session",
  roles: ["editor"],
  permissions: ["posts:read", "posts:create", "posts:update", "ai:use"],
};

let cms: CmsInstance;
let root: Root;
let container: HTMLElement;
let act: typeof actType;
const events: CmsEvent[] = [];
/** What the panel posted to `/ai/assistant`, newest last. */
const sent: Record<string, unknown>[] = [];
/** Simulates a proxy dropping the connection after the first frame. */
let cutAfterFirstFrame = false;
let postId = "";
/**
 * What a test leaves running. A failed assertion must stay that test's
 * failure: a run still parked on a gate or a long sleep would otherwise
 * stream into the next suite's DOM.
 */
const connections = new Set<ReadableStreamDefaultReader<Uint8Array>>();
const gates = new Set<() => void>();
/**
 * Bumped when a test ends. A test the runner timed out keeps executing in
 * the background, and a polling loop still calling React's `act()` would
 * then run inside the next suite's renders.
 */
let generation = 0;

beforeAll(async () => {
  useRealAgent();
  ({ act } = await import("react"));
  const { createRoot } = await import("react-dom/client");

  cms = heyoCms({
    database: () => adapter,
    admin: { path: "/admin", title: "Acme", auth: cmsUsers({ methods: ["password"] }) }, // prettier-ignore
    i18n: { locales: ["en", "pl"], defaultLocale: "en" },
    ai: {
      auth: { faux: { type: "api-key", token: "faux-key" } },
      defaultModel: { provider: "faux", model: "scripted" },
      assistant: { enabled: true },
    },
    collections: {
      posts: defineCollection({
        fields: {
          title: text({ required: true, localized: true, label: "Title" }),
          seoTitle: text({ localized: true, label: "SEO title" }),
          notes: text({ label: "Notes" }),
        },
      }),
    },
  }) as unknown as CmsInstance;
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_e2e"),
  );
  cms.on("*", (event) => {
    events.push(event);
  });

  (cms.auth as { actorFromRequest: () => Promise<Actor> }).actorFromRequest =
    async () => editor;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input), "http://cms.test").href
        : input.url;
    // The panel's abort signal belongs to the DOM implementation, and the
    // handler is not a network: the abort is carried across by hand, the way
    // a closed socket reaches a server — as a cancelled body.
    const { signal, ...rest } = init ?? {};
    if (url.endsWith("/ai/assistant")) {
      sent.push(JSON.parse(String(rest.body ?? "{}")) as Record<string, unknown>); // prettier-ignore
    }
    const response = await cms.handler(new Request(url, rest));
    return url.endsWith("/ai/assistant") ? network(response, signal) : response; // prettier-ignore
  }) as typeof fetch;

  document.body.innerHTML =
    '<script type="application/json" id="heyo-cms-panel">' +
    JSON.stringify({
      basePath: "/api/heyo-cms",
      panelPath: "/api/heyo-cms/admin",
      title: "Acme",
    }) + // prettier-ignore
    "</script>";
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; // prettier-ignore

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

beforeEach(async () => {
  resetModel();
  sent.length = 0;
  events.length = 0;
  cutAfterFirstFrame = false;
  const created = await cms.api.posts.create({
    data: { title: "What happens when a payment fails?", notes: "internal" },
    actor: systemActor(),
    locale: "en",
  });
  postId = String(created?.id);
});

afterEach(async () => {
  generation += 1;
  for (const open of gates) open();
  gates.clear();
  for (const connection of connections) {
    await connection.cancel().catch(() => undefined);
  }
  connections.clear();
  await act(async () => root.render(null));
  // Let the aborted runs wind down and record themselves before the next
  // test counts events.
  await sleep(50);
});

afterAll(async () => {
  // In this order, and each step whatever the last one did: the DOM is
  // shared with the next suite, and a teardown that stopped at a database
  // still busy with a broken run would leave it registered for good.
  try {
    await act(async () => root.unmount());
    await Promise.race([cms.close(), sleep(1_000)]);
  } finally {
    await GlobalRegistrator.unregister();
  }
});

/**
 * The response as a browser hands it to the page: aborting the request
 * errors the reader on the page's side and closes the connection on the
 * server's. Optionally drops the connection after the first frame, which is
 * what a proxy with an idle timeout does.
 */
function network(response: Response, signal?: AbortSignal | null): Response {
  const source = response.body?.getReader();
  if (!source) return response;
  connections.add(source);
  let frames = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
      signal?.addEventListener("abort", () => {
        void source.cancel().catch(() => undefined);
        try {
          controller.error(new DOMException("The operation was aborted.", "AbortError")); // prettier-ignore
        } catch {
          // Already closed.
        }
      });
    },
    async pull(pulling) {
      const { done, value } = await source.read().catch(() => ({ done: true, value: undefined })); // prettier-ignore
      if (done || !value) {
        try {
          pulling.close();
        } catch {
          // Errored by an abort.
        }
        return;
      }
      pulling.enqueue(value);
      frames += new TextDecoder().decode(value).split("\n\n").length - 1;
      if (cutAfterFirstFrame && frames >= 1) {
        await source.cancel();
        pulling.close();
      }
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers: response.headers }); // prettier-ignore
}

// ---------------------------------------------------------------------------

describe("asking, as an editor sees it", () => {
  test("Thinking… while it works, then the answer — and nothing of the work", async () => {
    const release = gate();
    model(
      () => acting("Let me read the page first.", call("get_current_page", {})),
      async (turn) => {
        expect(turn.json()).toMatchObject({ documentId: postId, locale: "en" });
        await release.promise;
        return say(
          "It explains that **Stripe** retries the card.\n\n## What the client sees\n- a text message with a link",
        );
      },
    );

    await mount(`/c/posts/${postId}`);
    await ask("O czym jest ten wpis?");
    await until(() => calls.length === 2);

    // Working: one indicator, the question once, a way to stop — and none of
    // the steps, asides or results.
    expect(drawer()).toContain("Thinking…");
    expect(countOf(drawer(), "O czym jest ten wpis?")).toBe(1);
    expect(stopButton()).not.toBeNull();
    for (const leaked of [
      "Read the current page",
      "Let me read",
      "documentId",
      "{",
    ]) {
      expect(drawer()).not.toContain(leaked);
    }

    release.open();
    await until(() => !drawer().includes("Thinking…"));

    const shown = drawer();
    expect(shown).toContain("It explains that Stripe retries the card.");
    expect(shown).toContain("a text message with a link");
    expect(countOf(shown, "O czym jest ten wpis?")).toBe(1);
    // The Markdown a model writes anyway is styled, not printed.
    expect(shown).not.toContain("**");
    expect(shown).not.toContain("##");
    expect(strongTexts()).toEqual(expect.arrayContaining(["Stripe", "What the client sees"])); // prettier-ignore
    for (const leaked of [
      "Read the current page",
      "Let me read",
      "doc_",
      postId,
    ]) {
      expect(shown).not.toContain(leaked);
    }
    expect(stopButton()).toBeNull();

    // And the panel told the server where the editor is.
    expect(sent.at(-1)?.pageContext).toMatchObject({ kind: "document", collectionSlug: "posts", documentId: postId, locale: "en" }); // prettier-ignore
  });

  test("a follow-up carries the conversation as text: the model reads the last answer verbatim", async () => {
    model(() => say("It is about **failed** payments."));
    await mount(`/c/posts/${postId}`);
    await ask("O czym to jest?");
    await until(() => drawer().includes("It is about failed payments."));

    model((turn) => {
      const transcript = turn.messages.map((message) => [
        message.role,
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""), // prettier-ignore
      ]);
      expect(transcript).toEqual([
        ["user", "O czym to jest?"],
        ["assistant", "It is about **failed** payments."],
        ["user", "A krócej?"],
      ]);
      return say("Failed payments.");
    });
    await ask("A krócej?");
    await until(() => drawer().includes("Failed payments.") && !drawer().includes("Thinking…")); // prettier-ignore
    expect(countOf(drawer(), "O czym to jest?")).toBe(1);
    expect(countOf(drawer(), "A krócej?")).toBe(1);
    expect(sent.at(-1)?.history).toEqual([
      { role: "user", text: "O czym to jest?" },
      { role: "assistant", text: "It is about **failed** payments." },
    ]);
  });
});

describe("changing things, from the drawer", () => {
  test("a save lands in the open form and as a Saved card", async () => {
    model(
      () => acting(null, call("get_current_page", {})),
      (turn) => {
        const page = turn.json() as { documentId: string };
        return acting(null, call("update_document", { collection: "posts", id: page.documentId, data: { title: "Failed card payments, explained" } })); // prettier-ignore
      },
      () => say("Saved the new title (English)."),
    );
    await mount(`/c/posts/${postId}`);
    expect((control("Title") as HTMLInputElement).value).toBe("What happens when a payment fails?"); // prettier-ignore

    await ask("Popraw tytuł i zapisz");
    await until(() => drawer().includes("Saved the new title (English)."));
    await until(() => (control("Title") as HTMLInputElement).value === "Failed card payments, explained"); // prettier-ignore

    expect(drawer()).toContain("Saved");
    const stored = await cms.api.posts.findById(postId, { actor: systemActor(), locale: "en" }); // prettier-ignore
    expect(stored?.title).toBe("Failed card payments, explained");
  });

  test("a create waits for the button, and the button creates it", async () => {
    model(
      () => acting(null, call("create_document", { collection: "posts", locale: "en", data: { title: "How to change a card" } })), // prettier-ignore
      () => say("I prepared it; it is waiting for your approval."),
    );
    await mount("/c/posts");
    await ask("Dodaj wpis o zmianie karty");
    await until(() => drawer().includes("waiting for your approval"));
    expect(drawer()).toContain("Needs approval");

    const count = async () => (await cms.api.posts.find({ actor: systemActor(), count: true })).totalDocs; // prettier-ignore
    const before = await count();
    await click(buttonIn(drawerElement(), "Approve"));
    await until(() => drawer().includes("Saved"));
    expect(await count()).toBe((before ?? 0) + 1);
  });
});

describe("when it goes wrong", () => {
  test("Stop ends the run on the server too, and leaves no error behind", async () => {
    model(
      () => acting(null, call("describe_cms", {})),
      async () => {
        await sleep(10_000, calls.at(-1)?.signal);
        return say("too late");
      },
    );
    await mount("/c/posts");
    await ask("zrób coś długiego");
    await until(() => calls.length === 2);

    await click(stopButton() as HTMLElement);
    await until(() => calls[1]?.signal?.aborted === true);
    await until(() => events.some((event) => event.type === "ai.agent.failed"));
    expect(drawer()).not.toContain("Thinking…");
    expect(drawer()).not.toContain("too late");
    expect(drawer()).not.toContain("lost");
    expect(stopButton()).toBeNull();
  });

  test("a provider failure is an error message, not half an answer", async () => {
    model(
      () => acting(null, call("describe_cms", {})),
      () => fauxAssistantMessage("Half an ans", { stopReason: "error", errorMessage: "upstream exploded" }), // prettier-ignore
    );
    await mount("/c/posts");
    await ask("x");
    await until(() => drawer().includes("upstream exploded"));
    expect(drawer()).not.toContain("Half an ans");
    expect(drawer()).not.toContain("Thinking…");
  });

  test("a connection dropped mid-run is reported, not left as an empty bubble", async () => {
    cutAfterFirstFrame = true;
    model(
      () => acting(null, call("describe_cms", {})),
      async () => {
        await sleep(300, calls.at(-1)?.signal);
        return say("never arrives");
      },
    );
    await mount("/c/posts");
    await ask("x");
    await until(() =>
      drawer().includes("connection to the assistant was lost"),
    );
    expect(drawer()).not.toContain("Thinking…");
    // The server noticed too: the run was stopped and accounted for.
    await until(() => events.some((event) => event.type === "ai.agent.failed"));
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => undefined as void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  gates.add(open);
  return { promise, open };
}

function drawerElement(): HTMLElement {
  const element = container.querySelector('[aria-label="AI assistant"]');
  if (!element) throw new Error("The assistant drawer is not on screen.");
  return element as unknown as HTMLElement;
}

function drawer(): string {
  return drawerElement().textContent ?? "";
}

function strongTexts(): string[] {
  return [...drawerElement().querySelectorAll("strong")].map((node) => node.textContent ?? ""); // prettier-ignore
}

function stopButton(): HTMLElement | null {
  return ([...drawerElement().querySelectorAll("button")].find((element) => element.textContent?.trim() === "Stop") ?? null) as HTMLElement | null; // prettier-ignore
}

function buttonIn(scope: HTMLElement, label: string): HTMLElement {
  const match = [...scope.querySelectorAll("button")].find((element) => element.textContent?.trim() === label); // prettier-ignore
  if (!match) throw new Error(`No button "${label}".`);
  return match as unknown as HTMLElement;
}

function control(label: string): HTMLElement {
  const element = findControl(container, label);
  if (!element) throw new Error(`No control labelled "${label}".`);
  return element as unknown as HTMLElement;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Re-renders while waiting, so state the stream sets reaches the DOM. Gives
 * up before the runner's own five-second timeout, so a failure is reported
 * as what was on screen rather than as "timed out".
 */
async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  const mine = generation;
  while (!condition()) {
    if (generation !== mine) throw new Error("The test this wait belonged to has ended."); // prettier-ignore
    if (Date.now() > deadline) {
      throw new Error(`Never happened. The drawer says: ${container.querySelector('[aria-label="AI assistant"]')?.textContent}`); // prettier-ignore
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
}

async function mount(path: string): Promise<void> {
  window.history.replaceState({}, "", `/api/heyo-cms/admin${path}`);
  const [
    { App },
    { PanelProvider },
    { RouterProvider },
    { ConfirmProvider },
    { AssistantProvider },
    { api },
  ] = await Promise.all([
    // prettier-ignore
    import("../src/app/app"),
    import("../src/app/lib/panel"),
    import("../src/app/lib/router"),
    import("../src/app/components/confirm"),
    import("../src/app/lib/assistant"),
    import("../src/app/lib/api"),
  ]);
  const [config, session] = await Promise.all([api.get<never>("/panel"), api.get<never>("/auth/session")]); // prettier-ignore
  await act(async () => {
    root.render(
      <PanelProvider
        key={`${path}:${Math.random()}`}
        config={config}
        initialSession={session}
      >
        <RouterProvider>
          <AssistantProvider>
            <ConfirmProvider>
              <App />
            </ConfirmProvider>
          </AssistantProvider>
        </RouterProvider>
      </PanelProvider>,
    );
  });
  await settle();
}

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })); // prettier-ignore
    element.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true })); // prettier-ignore
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function ask(message: string): Promise<void> {
  const composer = container.querySelector(
    'aside[data-state="open"] textarea[aria-label="Ask the assistant"], [data-state="visible"] input[aria-label="Ask the assistant"]',
  ) as unknown as HTMLElement | null;
  if (!composer) throw new Error("The assistant composer is not on screen.");
  const textarea = composer instanceof window.HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    textarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, // prettier-ignore
    "value",
  )?.set;
  await act(async () => {
    setter?.call(composer, message);
    composer.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle();
  const scope = (textarea ? composer.closest("aside") : composer.closest('[data-slot="assistant-centre-composer"]')) as HTMLElement; // prettier-ignore
  const send = scope.querySelector('button[aria-label="Send"]') as HTMLElement | null; // prettier-ignore
  if (!send) throw new Error("The assistant has no send button.");
  await click(send);
}
