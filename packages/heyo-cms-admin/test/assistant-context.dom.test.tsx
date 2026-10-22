import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Before anything else: the panel reads `document` while its modules are
// evaluated, so the DOM has to exist before the first import of the app.
GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"; // prettier-ignore
import type { act as actType } from "react";
import type { Root } from "react-dom/client";

import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, defineGlobal, heyoCms } from "../../heyo-cms/src/config"; // prettier-ignore
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import { media, richText, select, text } from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import { memory } from "../../heyo-cms/src/storage/local";
import type { Actor } from "../../heyo-cms/src/types/actor";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";
import { findControl } from "./controls";

/**
 * The page context, screen by screen.
 *
 * `pageContext` is the only thing that makes "rewrite this" mean anything, so
 * the interesting failures are not in the agent: they are a screen that
 * forgets to say where it is, a navigation that leaves the previous screen's
 * record in the ref, and a locale the assistant was never told about. All of
 * those are invisible in the panel and produce a confident answer about the
 * wrong record, which is the worst failure mode this feature has.
 */

const adapter = sqlite(new Database(":memory:"));
const admin: Actor = {
  id: "usr_admin",
  source: "session",
  roles: ["admin"],
  permissions: ["*"],
};

let cms: CmsInstance;
let root: Root;
let container: HTMLElement;
let act: typeof actType;
let postId = "";
let fileId = "";
const assistantRequests: Record<string, unknown>[] = [];
/** What the next scripted run streams back. Reset per test. */
let assistantScript: unknown[] = [];

interface SentContext {
  kind?: string;
  collectionSlug?: string;
  documentId?: string;
  locale?: string;
  dirtyFields?: string[];
  baselineRevision?: number;
  tab?: string;
  mediaId?: string;
}

function sseResponse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );
}

beforeAll(async () => {
  ({ act } = await import("react"));
  const { createRoot } = await import("react-dom/client");

  cms = heyoCms({
    database: () => adapter,
    admin: {
      path: "/admin",
      title: "Acme",
      auth: cmsUsers({ methods: ["password"] }),
    },
    i18n: { locales: ["en", "de"], defaultLocale: "en" },
    trash: { enabled: true, purgeAfter: "30d" },
    uploads: { storage: memory() },
    ai: {
      auth: { openai: { type: "api-key", token: "sk-test" } },
      defaultModel: { provider: "openai", model: "gpt-4o-mini" },
    },
    globals: {
      site_settings: defineGlobal({
        label: "Site settings",
        fields: { siteName: text({ default: "Acme" }) },
      }),
    },
    collections: {
      posts: defineCollection({
        admin: { useAsTitle: "title" },
        fields: {
          title: text({ required: true, localized: true }),
          notes: text({}),
          status: select({ options: ["draft", "published"], default: "draft" }),
          cover: media({}),
          // Two writing surfaces, so the editor is a tab strip: the case
          // where "rewrite this section" has more than one answer.
          body: richText({ localized: true, label: "Body" }),
          excerpt: richText({ label: "Excerpt" }),
        },
      }),
    },
  }) as unknown as CmsInstance;

  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_ctx"),
  );

  const auth = cms.auth as { actorFromRequest: () => Promise<Actor> };
  auth.actorFromRequest = async () => admin;

  const created = (await (
    cms.api as unknown as {
      posts: {
        create: (args: unknown) => Promise<{ id: string }>;
      };
    }
  ).posts.create({
    data: { title: "The uploads lifecycle", notes: "n" },
    actor: admin,
  })) as { id: string };
  postId = created.id;

  const uploaded = await cms.media.upload({
    file: new Uint8Array([1, 2, 3, 4]),
    filename: "cover.bin",
    contentType: "application/octet-stream",
    actor: admin,
  });
  fileId = uploaded.id;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input), "http://cms.test").href
        : input.url;
    if (url.endsWith("/ai/assistant")) {
      assistantRequests.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      return sseResponse(assistantScript);
    }
    return cms.handler(new Request(url, init));
  }) as typeof fetch;

  document.body.innerHTML =
    '<script type="application/json" id="heyo-cms-panel">' +
    JSON.stringify({
      basePath: "/api/heyo-cms",
      panelPath: "/api/heyo-cms/admin",
      title: "Acme",
    }) +
    "</script>";

  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; // prettier-ignore

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterAll(async () => {
  await act(async () => root.unmount());
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  assistantRequests.length = 0;
  assistantScript = [
    { type: "text-delta", text: "ok" },
    { type: "done", runId: "air_1", usage: { input: 1, output: 1, total: 2, cost: 0 } }, // prettier-ignore
  ];
});

describe("the page context, per screen", () => {
  test("every screen says where it is", async () => {
    const observed: Record<string, SentContext | undefined> = {};
    for (const path of [
      "/",
      "/c/posts",
      `/c/posts/${postId}`,
      "/c/posts/new",
      "/g/site-settings",
      "/media",
      "/trash",
      "/settings",
      "/c/does-not-exist",
    ]) {
      await mount(path);
      await ask(`where am I on ${path}`);
      observed[path] = contextOf(assistantRequests.at(-1));
    }

    expect(observed["/"]?.kind).toBe("dashboard");
    expect(observed["/c/posts"]?.kind).toBe("collection-list");
    expect(observed["/c/posts"]?.collectionSlug).toBe("posts");
    expect(observed[`/c/posts/${postId}`]?.kind).toBe("document");
    expect(observed[`/c/posts/${postId}`]?.documentId).toBe(postId);
    expect(observed[`/c/posts/${postId}`]?.baselineRevision).toBeGreaterThan(0);
    // A form with nothing behind it yet: the id is omitted rather than sent
    // as the panel's word "new", and the server says so in the prompt.
    expect(observed["/c/posts/new"]?.kind).toBe("document");
    expect(observed["/c/posts/new"]?.documentId).toBeUndefined();
    expect(observed["/g/site-settings"]?.kind).toBe("global");
    expect(observed["/g/site-settings"]?.collectionSlug).toBe("site-settings");
    expect(observed["/media"]?.kind).toBe("media");
    expect(observed["/trash"]?.kind).toBe("trash");
    expect(observed["/settings"]?.kind).toBe("settings");
    // A path the panel answers with "nothing here" must not claim to be a
    // list of a collection this deployment does not have.
    expect(observed["/c/does-not-exist"]?.kind).toBe("dashboard");
    expect(observed["/c/does-not-exist"]?.collectionSlug).toBeUndefined();
    // Every screen names the locale the panel is showing, including the ones
    // that have no record: `find_documents` reads it.
    for (const [path, context] of Object.entries(observed)) {
      expect(context?.locale, `${path} sent no locale`).toBe("en");
    }
  });

  test("a navigation replaces the context rather than keeping the old one", async () => {
    await mount(`/c/posts/${postId}`);
    await ask("one");
    expect(contextOf(assistantRequests.at(-1))?.kind).toBe("document");

    await click(sidebarLink("/media"));
    await ask("two");
    const afterMedia = contextOf(assistantRequests.at(-1));
    expect(afterMedia?.kind).toBe("media");
    expect(afterMedia?.documentId).toBeUndefined();
    expect(afterMedia?.collectionSlug).toBeUndefined();

    await click(sidebarLink("/c/posts"));
    await ask("three");
    const afterList = contextOf(assistantRequests.at(-1));
    expect(afterList?.kind).toBe("collection-list");
    expect(afterList?.collectionSlug).toBe("posts");
    expect(afterList?.documentId).toBeUndefined();
  });

  test("the unsaved fields are the ones in the form, not a count", async () => {
    await mount(`/c/posts/${postId}`);
    await typeInto(input("Notes"), "edited notes");
    await ask("what is unsaved");
    const first = contextOf(assistantRequests.at(-1));
    expect(first?.dirtyFields).toEqual(["notes"]);

    // A second field appears, and the assistant has to hear about it: it
    // refuses to write a dirty record, and the field it is not told about is
    // exactly the one it would overwrite.
    await typeInto(input("Title"), "A new title");
    await ask("and now");
    const second = contextOf(assistantRequests.at(-1));
    expect(new Set(second?.dirtyFields)).toEqual(new Set(["notes", "title"]));
  });

  test("the language being edited travels from every screen", async () => {
    window.localStorage.setItem("heyo-cms:locale", "de");
    try {
      for (const path of ["/", "/c/posts", `/c/posts/${postId}`, "/settings"]) {
        await mount(path);
        await ask(`language on ${path}`);
        expect(contextOf(assistantRequests.at(-1))?.locale, path).toBe("de");
      }
    } finally {
      window.localStorage.setItem("heyo-cms:locale", "en");
    }
  });

  test("the writing tab in front is the tab the agent is told about", async () => {
    await mount(`/c/posts/${postId}`);
    await ask("which section");
    expect(contextOf(assistantRequests.at(-1))?.tab).toBe("body");

    // The second writing surface. Switching it is the only signal the editor
    // gives that "this section" now means something else.
    await click(tabTrigger("Excerpt"));
    await ask("and now");
    expect(contextOf(assistantRequests.at(-1))?.tab).toBe("excerpt");
  });

  test("the file open in the media details pane is what \u201cthis image\u201d means", async () => {
    await mount("/media");
    await ask("before selecting");
    const before = contextOf(assistantRequests.at(-1));
    expect(before?.kind).toBe("media");
    expect(before?.mediaId).toBeUndefined();
    expect(before?.tab).toBe("active");

    const card = container.querySelector(
      `[aria-label="Open cover.bin"], [aria-pressed]`,
    ) as unknown as HTMLElement | null;
    if (!card) throw new Error("No file card on the media screen.");
    await click(card);

    await ask("change the alt text of this image");
    const after = contextOf(assistantRequests.at(-1));
    expect(after?.kind).toBe("media");
    expect(after?.mediaId).toBe(fileId);
  });

  test("an unsaved media filename is reported, never sent as a value", async () => {
    await mount("/media");
    const card = container.querySelector("[aria-pressed]") as unknown as HTMLElement | null; // prettier-ignore
    if (!card) throw new Error("No file card on the media screen.");
    await click(card);
    await typeInto(input("Filename"), "unsaved-name.bin");
    await ask("change this image");
    const page = contextOf(assistantRequests.at(-1));
    expect(page?.mediaId).toBe(fileId);
    expect(page?.dirtyFields).toEqual(["filename"]);
    expect(JSON.stringify(assistantRequests.at(-1))).not.toContain(
      "unsaved-name.bin",
    );
  });

  test("a write to the selected file lands in the details pane", async () => {
    assistantScript = [
      {
        type: "mutation-applied",
        runId: "air_2",
        target: { kind: "media", id: fileId, locale: "en" },
        fields: ["filename"],
      },
      { type: "done", runId: "air_2", usage: { input: 1, output: 1, total: 2, cost: 0 } }, // prettier-ignore
    ];

    await mount("/media");
    const card = container.querySelector("[aria-pressed]") as unknown as HTMLElement | null; // prettier-ignore
    if (!card) throw new Error("No file card on the media screen.");
    await click(card);
    expect(container.textContent).toContain("cover.bin");

    // The agent renames the file the pane is showing. Without the broadcast
    // the pane keeps the old name under a card that says it was saved.
    await cms.media.update({
      id: fileId,
      filename: "renamed-by-the-agent.bin",
      actor: admin,
      source: "ai",
    });
    await ask("rename this file");

    expect(container.textContent).toContain("renamed-by-the-agent.bin");
  });

  test("the settings tab is named, so one kind is not eight screens", async () => {
    await mount("/settings");
    await ask("which tab");
    expect(contextOf(assistantRequests.at(-1))?.tab).toBe("users");

    await click(tabTrigger("Languages"));
    await ask("and now");
    const after = contextOf(assistantRequests.at(-1));
    expect(after?.kind).toBe("settings");
    expect(after?.tab).toBe("locales");
  });
});

/** A tab in a segmented strip, by its visible label. */
function tabTrigger(label: string): HTMLElement {
  const match = [...container.querySelectorAll('[role="tab"]')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) {
    throw new Error(
      `No tab labelled "${label}". Found: ${[...container.querySelectorAll('[role="tab"]')].map((element) => element.textContent?.trim()).join(" | ")}`,
    );
  }
  return match as unknown as HTMLElement;
}

/** Bumped per mount: the key has to change even for a repeated path. */
let mounts = 0;

async function mount(path: string): Promise<void> {
  window.history.replaceState({}, "", `/api/heyo-cms/admin${path}`);
  mounts += 1;

  const [
    { App },
    { PanelProvider },
    { RouterProvider },
    { ConfirmProvider },
    { AssistantProvider },
    { api },
  ] = await Promise.all([
    import("../src/app/app"),
    import("../src/app/lib/panel"),
    import("../src/app/lib/router"),
    import("../src/app/components/confirm"),
    import("../src/app/lib/assistant"),
    import("../src/app/lib/api"),
  ]);

  const [config, session] = await Promise.all([
    api.get<never>("/panel"),
    api.get<never>("/auth/session"),
  ]);

  await act(async () => {
    root.render(
      <PanelProvider
        key={`${path}#${mounts}`}
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

function contextOf(
  request: Record<string, unknown> | undefined,
): SentContext | undefined {
  return request?.pageContext as SentContext | undefined;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function input(label: string): HTMLElement {
  const element = findControl(container, label);
  if (!element) throw new Error(`No input labelled "${label}".`);
  return element as unknown as HTMLElement;
}

function sidebarLink(to: string): HTMLElement {
  const match = [...container.querySelectorAll("a")].find(
    (element) => element.getAttribute("href") === `/api/heyo-cms/admin${to}`,
  );
  if (!match) throw new Error(`No sidebar link to "${to}".`);
  return match as unknown as HTMLElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new window.PointerEvent("pointerdown", { bubbles: true }),
    );
    element.dispatchEvent(
      new window.PointerEvent("pointerup", { bubbles: true }),
    );
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function ask(message: string): Promise<void> {
  const composer = container.querySelector(
    'input[aria-label="Ask the assistant"], textarea[aria-label="Ask the assistant"]',
  ) as unknown as HTMLElement | null;
  if (!composer) throw new Error("The assistant composer is not on screen.");
  await typeInto(
    composer,
    message,
    composer instanceof window.HTMLTextAreaElement ? "textarea" : "input",
  );
  const send = container.querySelector(
    'button[aria-label="Send"]',
  ) as unknown as HTMLElement | null;
  if (!send) throw new Error("The assistant has no send button.");
  await click(send);
}

async function typeInto(
  element: HTMLElement,
  value: string,
  kind: "input" | "textarea" = "input",
): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    kind === "textarea"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle();
}
