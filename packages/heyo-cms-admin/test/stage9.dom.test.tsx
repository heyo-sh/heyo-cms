import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Before anything else, for the same reason as `panel.dom.test.tsx`: the
// panel reads `document` while its modules are evaluated.
GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { act as actType } from "react";
import type { Root } from "react-dom/client";

import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, heyoCms } from "../../heyo-cms/src/config";
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import { select, text } from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import type { Actor } from "../../heyo-cms/src/types/actor";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";
import type { PanelConfig } from "../../heyo-cms/src/types/panel";
import { findControl } from "./controls";

/**
 * Stage 9, from the panel.
 *
 * The three things this stage adds to the screen are an AI menu that
 * actually answers, a webhook screen that can subscribe and replay, and a
 * way for a plugin to render its own field in a bundle it was not compiled
 * into. All three are driven here against a real `cms.handler`, because the
 * interesting failures are between the panel's URL and the router's — a
 * suite with a mocked API would have agreed with itself about both.
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
const sentWebhooks: string[] = [];
/** What the panel posted to `/ai/assistant`, newest last. */
const assistantRequests: Record<string, unknown>[] = [];
/** What the next assistant request answers with. */
let assistantScript: unknown[] = [];
/** Plan approvals the panel posted, and what they answer with. */
const approvals: string[] = [];
let approvalResult: unknown = { planId: "", runId: "", applied: [] };

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
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
    webhooks: {
      enabled: true,
      signing: { algorithm: "hmac-sha256", secret: "a-secret-long-enough!!" },
    },
    ai: {
      auth: { openai: { type: "api-key", token: "sk-test" } },
      defaultModel: { provider: "openai", model: "gpt-4o-mini" },
      storage: { secret: "panel-managed-secret-01" },
      complete: async () => ({
        text: "A title the model suggested",
        usage: { input: 4, output: 6, total: 10, cost: 0 },
      }),
    },
    collections: {
      posts: defineCollection({
        fields: {
          title: text({
            required: true,
            generate: ({ fields }) =>
              String(fields.notes ?? "").replaceAll(" ", "-"),
            aiGenerate: { prompt: "Write a title.", context: ["notes"] },
          }),
          notes: text({}),
          handle: text({ unique: true }),
          status: select({ options: ["draft", "published"], default: "draft" }),
        },
      }),
    },
  }) as unknown as CmsInstance;

  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_stage9"),
  );

  const auth = cms.auth as { actorFromRequest: () => Promise<Actor> };
  auth.actorFromRequest = async () => admin;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input), "http://cms.test").href
        : input.url;
    // A webhook delivery leaves through the same `fetch`; it is not a panel
    // request, so it is answered here rather than handed to the handler.
    if (!url.startsWith("http://cms.test/api/heyo-cms")) {
      sentWebhooks.push(url);
      return new Response("ok", { status: 200 });
    }
    // The assistant's stream is scripted here rather than served by the
    // handler, which would start a real agent and call a real provider. What
    // the panel owes is the SSE parser, the drawer and the broadcast to the
    // screens; what the agent owes is tested in `ai-assistant.test.ts`.
    if (url.includes("/ai/assistant/plans/")) {
      approvals.push(url);
      return Response.json(approvalResult);
    }
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
  window.confirm = () => true;

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterAll(async () => {
  await act(async () => root.unmount());
  await GlobalRegistrator.unregister();
});

describe("AI, from the form", () => {
  test("a suggestion is offered and inserted only when asked for", async () => {
    await mount("/c/posts/new");

    await typeInto(input("Notes"), "the uploads lifecycle");
    const deterministic = container.querySelector(
      '[aria-label="Generate Title"]',
    ) as HTMLButtonElement;
    const ai = container.querySelector(
      '[aria-label="AI generate Title"]',
    ) as HTMLButtonElement;
    expect(deterministic).not.toBeNull();
    expect(ai).not.toBeNull();
    expect(
      deterministic.compareDocumentPosition(ai) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await click(deterministic);
    expect((input("Title") as HTMLInputElement).value).toBe(
      "the-uploads-lifecycle",
    );
    const pageBeforeAi = await cms.api.posts.find({ actor: admin });
    expect(pageBeforeAi.docs).toHaveLength(0);
    await click(ai);

    // The suggestion is shown, and the field is still what the editor typed.
    const dialog = globalThis.document.body.textContent ?? "";
    expect(dialog).toContain("A title the model suggested");
    expect((input("Title") as HTMLInputElement).value).toBe(
      "the-uploads-lifecycle",
    );

    await click(dialogButton("Insert"));
    expect((input("Title") as HTMLInputElement).value).toBe(
      "A title the model suggested",
    );

    // And still nothing is stored: a suggestion is not a write.
    const page = await cms.api.posts.find({ actor: admin });
    expect(page.docs).toHaveLength(0);
  });
});

/**
 * The assistant, from the panel.
 *
 * Everything asserted here is the panel's own responsibility: that the
 * composer exists on every screen, that the conversation and the open drawer
 * survive a navigation, that a write the agent reports reaches the screen
 * showing that record, and that an approval is a button rather than a
 * sentence the model wrote.
 */
describe("the assistant, from the panel", () => {
  test("the composer is on every screen, not only on a document", async () => {
    for (const path of ["/", "/c/posts", "/media", "/settings"]) {
      await mount(path);
      const composer = container.querySelector(
        'input[aria-label="Ask the assistant"]',
      );
      expect(composer).toBeDefined();
      expect(composer).not.toBeNull();
    }
  });

  test("screens reserve space below the closed composer, except document editors", async () => {
    for (const path of ["/", "/c/posts", "/media", "/settings", "/unknown"]) {
      await mount(path);
      expect(container.querySelector('[data-slot="sidebar-inset"]')?.className).toContain("pb-20"); // prettier-ignore
    }

    await click(container.querySelector('[aria-label="Open AI assistant"]') as HTMLElement); // prettier-ignore
    expect(container.querySelector('[data-slot="sidebar-inset"]')?.className).not.toContain("pb-20"); // prettier-ignore
    await click(container.querySelector('[aria-label="Close the assistant"]') as HTMLElement); // prettier-ignore
    expect(container.querySelector('[data-slot="sidebar-inset"]')?.className).toContain("pb-20"); // prettier-ignore

    for (const path of ["/c/posts/new", "/c/posts/doc_1"]) {
      await mount(path);
      expect(container.querySelector('[data-slot="sidebar-inset"]')?.className).not.toContain("pb-20"); // prettier-ignore
    }
  });

  test("sending opens the drawer, and the conversation survives navigating", async () => {
    assistantScript = [
      { type: "tool-start", id: "t1", label: "Search documents" },
      { type: "tool-end", id: "t1", summary: "Searched documents" },
      { type: "text-delta", text: "Znalaz" },
      { type: "text-delta", text: "łem dwa artykuły." },
      { type: "done", runId: "air_1", usage: { input: 1, output: 1, total: 2, cost: 0 } }, // prettier-ignore
    ];
    assistantRequests.length = 0;

    await mount("/c/posts");
    await ask("znajdź artykuł o uploadach");

    // The drawer opened by itself: the composer is the entry point, and a
    // panel that opened empty would ask for two actions before anything
    // happened.
    const drawer = container.querySelector('[aria-label="AI assistant"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.textContent).toContain("znajdź artykuł o uploadach");
    expect(drawer?.textContent).toContain("Znalazłem dwa artykuły.");
    // The trace is the server's summary, never the tool's arguments.
    expect(drawer?.textContent).toContain("Searched documents");

    // The page context travels, so "this article" has something to resolve.
    const sent = assistantRequests.at(-1) as {
      pageContext?: { kind?: string; collectionSlug?: string };
    };
    expect(sent.pageContext?.kind).toBe("collection-list");
    expect(sent.pageContext?.collectionSlug).toBe("posts");

    // And now the headline: navigate. The provider lives above the router, so
    // the drawer stays open and the conversation stays in it. A chat that
    // belonged to a screen would have been thrown away by this click.
    await click(sidebarLink("/settings"));
    expect(window.location.pathname).toBe("/api/heyo-cms/admin/settings");

    const after = container.querySelector('[aria-label="AI assistant"]');
    expect(after).not.toBeNull();
    expect(after?.textContent).toContain("znajdź artykuł o uploadach");
    expect(after?.textContent).toContain("Znalazłem dwa artykuły.");
  });

  test("an approval is a button, and the plan shows names rather than values", async () => {
    assistantScript = [
      {
        type: "approval-required",
        plan: {
          id: "aip_1",
          runId: "air_2",
          summary: "Create one Post",
          operations: [
            {
              action: "create",
              target: { kind: "document", collection: "posts", id: "" },
              label: "New Post",
              fields: ["title"],
            },
          ],
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      },
      { type: "done", runId: "air_2", usage: { input: 1, output: 1, total: 2, cost: 0 } }, // prettier-ignore
    ];

    await mount("/c/posts");
    await ask("napisz nowy post");

    const drawer = container.querySelector('[aria-label="AI assistant"]');
    expect(drawer?.textContent).toContain("Needs approval");
    expect(drawer?.textContent).toContain("1 record");
    expect(drawer?.textContent).toContain("Fields: title");
    // Nothing was written, and the panel does not claim it was.
    expect(drawer?.textContent).not.toContain("Saved");

    // A second exchange, so the conversation has two assistant turns and
    // "reported on the right one" is a different sentence from "reported".
    assistantScript = [
      { type: "text-delta", text: "A nawiasem mówiąc, masz 3 posty." },
      { type: "done", runId: "air_3", usage: { input: 1, output: 1, total: 2, cost: 0 } }, // prettier-ignore
    ];
    await ask("ile mam postów?");
    expect(
      container.querySelector('[aria-label="AI assistant"]')?.textContent,
    ).toContain("masz 3 posty");

    // Approving posts to the endpoint and reports back on the turn that was
    // holding the plan — and only that turn.
    approvals.length = 0;
    approvalResult = {
      planId: "aip_1",
      runId: "air_2",
      applied: [
        {
          target: {
            kind: "document",
            collection: "posts",
            collectionSlug: "posts",
            id: "doc_new",
          },
          fields: ["title"],
        },
      ],
    };
    await click(button("Approve"));

    expect(approvals).toEqual([
      "http://cms.test/api/heyo-cms/ai/assistant/plans/aip_1/approve",
    ]);
    const settled = container.querySelector('[aria-label="AI assistant"]');
    expect(settled?.textContent).not.toContain("Needs approval");
    // Exactly one "Saved" card, on the one turn that proposed the change.
    expect(
      settled?.querySelectorAll('[data-slot="badge"]') ?? [],
    ).toBeDefined();
    expect(countOf(settled?.textContent ?? "", "Saved")).toBe(1);
  });

  test("a write the agent reports lands on the document screen showing it", async () => {
    const created = await cms.api.posts.create({
      data: { title: "Before the agent" },
      actor: admin,
    });
    const id = String(created?.id);

    assistantScript = [
      {
        type: "mutation-applied",
        runId: "air_3",
        target: {
          kind: "document",
          collection: "posts",
          collectionSlug: "posts",
          id,
          locale: "en",
          revision: 2,
        },
        fields: ["title"],
      },
      { type: "done", runId: "air_3", usage: { input: 1, output: 1, total: 2, cost: 0 } }, // prettier-ignore
    ];

    await mount(`/c/posts/${id}`);
    expect((input("Title") as HTMLInputElement).value).toBe("Before the agent");

    // The agent writes the record out from under the form. A clean form
    // catches up rather than showing a stale value the editor would then
    // save back over the top.
    await cms.api.posts.update({
      id,
      data: { title: "After the agent" },
      actor: admin,
      source: "ai",
    });

    await ask("popraw tytuł");

    expect((input("Title") as HTMLInputElement).value).toBe("After the agent");
    const drawer = container.querySelector('[aria-label="AI assistant"]');
    expect(drawer?.textContent).toContain("Saved");
  });

  test("the form sends the revision it was loaded from", async () => {
    const created = await cms.api.posts.create({
      data: { title: "Precondition" },
      actor: admin,
    });
    const id = String(created?.id);
    // Somebody else saves while the tab is open.
    await cms.api.posts.update({
      id,
      data: { title: "Another editor" },
      actor: admin,
    });

    await mount(`/c/posts/${id}`);
    // The form holds revision 2 now; make it stale by writing again.
    await cms.api.posts.update({
      id,
      data: { title: "And again" },
      actor: admin,
    });

    await typeInto(input("Title"), "Mine");
    await click(button("Save"));

    // Refused rather than silently winning, and the screen says what to do.
    expect(container.textContent).toContain("conflict");
    const stored = await cms.api.posts.findById(id, { actor: admin });
    expect(stored?.title).toBe("And again");
  });

  test("a value another document has is refused without claiming somebody else saved", async () => {
    await cms.api.posts.create({
      data: { title: "Owner", handle: "taken" },
      actor: admin,
    });
    const created = await cms.api.posts.create({
      data: { title: "Mine" },
      actor: admin,
    });
    const id = String(created?.id);

    await mount(`/c/posts/${id}`);
    await typeInto(input("Handle"), "taken");
    await click(button("Save"));

    // A 409 as well, but not a stale form: reloading "theirs" would throw
    // the edit away and fix nothing. (The toast that names the field is the
    // server's message, asserted in `http.test.ts`.)
    expect(container.textContent).not.toContain("changed since you opened it");
    expect(container.textContent).toContain("unsaved");
    const stored = await cms.api.posts.findById(id, { actor: admin });
    expect(stored?.handle ?? null).toBeNull();
  });
});

describe("the settings screen", () => {
  test("the trail says Settings and the tabs say which one", async () => {
    await mount("/settings?tab=webhooks");

    // One answer per question: the segmented control already says which
    // section is open, so the trail does not repeat it as a second crumb.
    const trail = container.querySelector('[data-slot="breadcrumb"]');
    expect(trail?.textContent?.trim()).toBe("Settings");

    const tabs = container.querySelector('[data-slot="tabs"]');
    expect(tabs?.getAttribute("data-variant")).toBe("segmented");
    expect(tabs?.querySelector('[data-slot="tabs-list"]')?.parentElement?.className).toContain("h-[3.0625rem]"); // prettier-ignore
    const selected = container.querySelector('[data-slot="tabs-tab"][aria-selected="true"]'); // prettier-ignore
    expect(selected?.textContent?.trim()).toBe("Webhooks");
  });

  test("shows effective AI settings without exposing instructions or credentials", async () => {
    await mount("/settings?tab=ai");
    expect(container.textContent).toContain("AI configuration");
    expect(container.textContent).toContain("openai · gpt-4o-mini");
    expect(container.textContent).toContain(
      "8 turns · 16 tool calls · 90s timeout",
    );
    expect(container.textContent).not.toContain("sk-test");
    expect(
      container.querySelector('button[aria-label="How to use this API"]'),
    ).toBeNull();
  });

  test("shows each code-owned deployment section as a read-only table", async () => {
    await mount("/settings?tab=deployment");
    const tables = [...container.querySelectorAll('[data-slot="data-table"]')];
    expect(tables).toHaveLength(2); // No plugins configured in this deployment.
    expect(tables[0]?.textContent).toContain("Access & sign-in");
    expect(tables[1]?.textContent).toContain("Storage & retention");
    for (const table of tables) {
      expect([...table.querySelectorAll("th")].map((header) => header.textContent?.trim())).toEqual(["Setting", "Value"]); // prettier-ignore
      expect(table.className).toContain("[&_table]:table-fixed");
      expect([...table.querySelectorAll("th")].map((header) => header.className.includes("w-1/2"))).toEqual([true, true]); // prettier-ignore
      expect([...table.querySelectorAll("tbody tr:first-child td")].map((cell) => cell.className.includes("w-1/2"))).toEqual([true, true]); // prettier-ignore
      expect(table.querySelectorAll("button, input")).toHaveLength(0);
    }
    expect(tables[0]?.textContent).toContain("Change them in code and");
    expect(tables[0]?.querySelector("tbody")?.textContent).toContain(
      "password",
    );
    expect(tables[1]?.querySelector("tbody")?.textContent).toContain(
      "Media uploads",
    );
    expect(
      container.querySelector('button[aria-label="How to use this API"]'),
    ).toBeNull();
  });

  test("renders MIME types, variant names and plugin IDs as separate code values", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input.url,
        "http://cms.test",
      );
      const response = await originalFetch(input, init);
      if (!url.pathname.endsWith("/panel")) return response;
      const config = (await response.json()) as PanelConfig;
      return Response.json({
        ...config,
        auth: { ...config.auth, sso: "https://example.test/sso" },
        media: {
          ...config.media,
          enabled: true,
          accept: ["image/*", "video/mp4", "application/pdf"],
          variants: ["thumbnail", "hero"],
          variantMode: "on-demand",
        },
        plugins: [
          { id: "reviews", navItems: [], scripts: [], fields: [] },
          { id: "analytics", navItems: [], scripts: [], fields: [] },
        ],
      });
    }) as typeof fetch;
    try {
      await mount("/settings?tab=deployment");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const tables = [...container.querySelectorAll('[data-slot="data-table"]')];
    expect(tables).toHaveLength(3);
    expect(tables[2]?.textContent).toContain("Plugins");
    expect(tables[0]?.querySelector("tbody code")?.textContent).toBe("https://example.test/sso"); // prettier-ignore
    expect([...tables[1]!.querySelectorAll("tbody code")].map((code) => code.textContent)).toEqual(["image/*", "video/mp4", "application/pdf", "thumbnail", "hero", "on-demand"]); // prettier-ignore
    expect([...tables[2]!.querySelectorAll("tbody code")].map((code) => code.textContent)).toEqual(["reviews", "analytics"]); // prettier-ignore
  });
});

describe("webhooks, from the settings screen", () => {
  test("subscribe, send a test delivery, then replay it", async () => {
    await mount("/settings?tab=webhooks");
    expect(container.textContent).toContain("No subscriptions");

    await click(button("Subscribe"));
    await typeInto(dialogInput("URL"), "https://example.test/hooks/cms");
    await click(dialogButton("Subscribe"));

    expect(container.textContent).toContain("https://example.test/hooks/cms");
    const subscriptions = await cms.webhooks.list();
    expect(subscriptions).toHaveLength(1);

    await click(button("Send test"));
    expect(sentWebhooks).toContain("https://example.test/hooks/cms");

    const delivered = await cms.webhooks.deliveries({});
    expect(delivered.entries[0]?.status).toBe("delivered");
    expect(container.textContent).toContain("webhook.test");

    await click(button("Replay"));
    const after = await cms.webhooks.deliveries({});
    expect(after.entries).toHaveLength(2);
    // Same event, new attempt: a consumer's idempotency key still matches.
    expect(after.entries[0]?.eventId).toBe(after.entries[1]?.eventId);
  });

  test("a provider key can be stored and is never answered with", async () => {
    await mount("/settings?tab=ai");
    expect(container.textContent).toContain("openai");

    // "Set key" while the configuration's own key is the only one; it
    // becomes "Replace" once a key is stored here.
    await click(button("Set key"));
    await typeInto(dialogInput("Provider key"), "sk-typed-into-the-panel");
    await click(dialogButton("Store"));

    const providers = await cms.ai.providers();
    expect(providers[0]).toMatchObject({ source: "database", hint: "…anel" });
    expect(container.textContent).not.toContain("sk-typed-into-the-panel");
  });
});

describe("a plugin's own field control", () => {
  test("is used for a field type the panel has never heard of", async () => {
    const [{ loadPanelExtensions, fieldComponent }, React] = await Promise.all([
      import("../src/app/lib/extensions"),
      import("react"),
    ]);

    // Exactly what a plugin's script does, minus the network: the panel
    // installs the global, the script registers against it.
    const failures = await loadPanelExtensions(
      {
        basePath: "/api/heyo-cms",
        plugins: [{ id: "reviews", navItems: [], scripts: ["/reviews/panel.js"], fields: ["stars"] }], // prettier-ignore
      } as never,
      {
        react: React,
        load: async () => {
          const api = (
            globalThis as {
              heyoCmsPanel?: {
                registerField: (type: string, component: unknown) => void;
              };
            }
          ).heyoCmsPanel;
          api?.registerField("stars", () => null);
        },
      },
    );

    expect(failures).toEqual([]);
    expect(fieldComponent("stars")).toBeDefined();
    // A built-in is untouched: the registry only answers for what it was
    // given.
    expect(fieldComponent("text")).toBeUndefined();
  });

  test("a script that fails to load is reported, not fatal", async () => {
    const { loadPanelExtensions } = await import("../src/app/lib/extensions");
    const failures = await loadPanelExtensions(
      {
        basePath: "/api/heyo-cms",
        plugins: [{ id: "broken", navItems: [], scripts: ["/gone.js"], fields: [] }], // prettier-ignore
      } as never,
      {
        load: async () => {
          throw new Error("404");
        },
      },
    );
    expect(failures).toEqual(["broken: /api/heyo-cms/gone.js"]);
  });
});

describe("the media details pane", () => {
  test("centres previews and keeps the three detail sections collapsible", async () => {
    const filename =
      "u5636419389_1980s_anime_style_aerial_view_of_a_winding_river__e4f646fd-c47c-4c40-9a0e-72c330edecba_3.png";
    const file = {
      id: "med_preview",
      filename,
      mimeType: "image/png",
      size: 1024,
      width: 100,
      height: 100,
      storageKey: "preview.png",
      checksum: null,
      alt: { en: "" },
      focalPoint: null,
      crop: null,
      status: "active",
      orphanedAt: null,
      purgeAfter: null,
      purgeError: null,
      metadata: {},
      variants: [],
      createdBy: null,
      createdAt: null,
      updatedAt: null,
      url: "/preview.png",
    };
    const extraFile = { ...file, id: "med_extra", filename: "another.png" };
    const secondFile = {
      ...file,
      id: "med_second",
      filename: "second-page.png",
    };
    const cursors: (string | null)[] = [];
    const searches: (string | null)[] = [];
    const patches: Record<string, unknown>[] = [];
    const deleted = new Set<string>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input.url,
        "http://cms.test",
      );
      if (url.pathname.endsWith("/panel")) {
        return originalFetch(input, init).then(async (response) => {
          const config = (await response.json()) as {
            media: { enabled: boolean };
          };
          return Response.json({
            ...config,
            media: { ...config.media, enabled: true },
          });
        });
      }
      if (url.pathname.endsWith("/media") && url.searchParams.has("status")) {
        const cursor = url.searchParams.get("cursor");
        const search = url.searchParams.get("search");
        cursors.push(cursor);
        searches.push(search);
        const docs =
          url.searchParams.get("status") === "orphaned"
            ? []
            : cursor === "next-page"
              ? [secondFile]
              : [file, extraFile];
        const filtered = docs.filter(
          (item) =>
            !deleted.has(item.id) &&
            (!search || item.filename.toLowerCase().includes(search.toLowerCase())),
        ); // prettier-ignore
        return Promise.resolve(
          Response.json({
            docs: filtered,
            limit: 48,
            hasNextPage: !search && !deleted.has(secondFile.id) && cursor === null && url.searchParams.get("status") === "active", // prettier-ignore
            cursor: !search && !deleted.has(secondFile.id) && cursor === null ? "next-page" : null, // prettier-ignore
          }),
        );
      }
      if (
        url.pathname.endsWith(`/media/${file.id}`) &&
        init?.method === "PATCH"
      ) {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push(patch);
        return Promise.resolve(
          Response.json({ ...file, filename: patch.filename }),
        );
      }
      if (
        [file.id, extraFile.id, secondFile.id].some((id) =>
          url.pathname.endsWith(`/media/${id}`),
        ) &&
        init?.method === "DELETE"
      ) {
        deleted.add(url.pathname.split("/").at(-1)!);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (
        [file.id, extraFile.id, secondFile.id].some((id) =>
          url.pathname.endsWith(`/media/${id}/usages`),
        )
      ) {
        return Promise.resolve(Response.json({ usages: [] }));
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      // The conversation survives navigation; arriving on Media with AI
      // already open must start its (as yet unselected) pane folded.
      await mount("/c/posts");
      await click(container.querySelector('[aria-label="Open AI assistant"]') as HTMLElement); // prettier-ignore
      await click(container.querySelector('a[href$="/media"]') as HTMLElement); // prettier-ignore
      await settle();
      expect(container.querySelector('[aria-label="AI assistant"]')?.getAttribute("data-state")).toBe("open"); // prettier-ignore
      expect(container.querySelector('[data-slot="sidebar-header"]')?.textContent).toContain("Search"); // prettier-ignore
      expect(container.querySelector('[data-slot="tabs"]')?.parentElement?.className).toContain("h-[3.0625rem]"); // prettier-ignore
      expect(container.querySelector('[aria-label="Open ' + filename + ' details"]')?.parentElement?.className).not.toContain("ring-1"); // prettier-ignore
      expect(container.querySelector('input[aria-label="Search media"]')).not.toBeNull(); // prettier-ignore
      expect(container.textContent).not.toContain("Select all on this page");
      const emptyPane = container.querySelector('[aria-label="Media details"]');
      expect(emptyPane?.getAttribute("data-state")).toBe("empty");
      expect(emptyPane?.hasAttribute("inert")).toBe(true);
      await click(button(filename));
      const pane = container.querySelector('[aria-label="Media details"]');
      expect(pane?.getAttribute("data-state")).toBe("collapsed");
      await click(container.querySelector('[aria-label="Show media details"]') as HTMLElement); // prettier-ignore
      expect(pane?.getAttribute("data-state")).toBe("expanded");
      await click(container.querySelector('[aria-label="Close the assistant"]') as HTMLElement); // prettier-ignore
      expect(pane).not.toBeNull();
      expect(pane?.textContent).not.toContain("The frames below are what a variant will actually look like."); // prettier-ignore
      expect(pane?.querySelector('div.flex-wrap.justify-center')?.textContent).toContain("Portrait"); // prettier-ignore
      expect(pane?.querySelector('div.flex-wrap.justify-center')?.parentElement?.className).toContain("mt-4"); // prettier-ignore
      expect(pane?.textContent).not.toContain("Alt text");
      const accordion = pane?.querySelector('[data-slot="accordion"]');
      expect(accordion?.className).toContain("border-y");
      expect(accordion?.parentElement?.className).not.toContain("px-4");
      expect([...accordion!.querySelectorAll('[data-slot="accordion-trigger"]')].every((node) => node.className.includes("px-4"))).toBe(true); // prettier-ignore
      expect([...accordion!.querySelectorAll('[data-slot="accordion-content"]')].every((node) => node.className.includes("px-4"))).toBe(true); // prettier-ignore
      const filenameTitle = pane?.querySelector('section [title="' + filename + '"]'); // prettier-ignore
      expect(filenameTitle?.className).toContain("truncate");
      expect(filenameTitle?.textContent?.length).toBeLessThan(filename.length);
      expect(filenameTitle?.textContent).toEndWith(filename.slice(-12));
      expect(pane?.querySelector('[data-slot="scroll-area"]')?.className).toContain("[&_[data-slot=scroll-area-content]]:!min-w-0"); // prettier-ignore
      const triggers = [...(pane?.querySelectorAll('[data-slot="accordion-trigger"]') ?? [])]; // prettier-ignore
      expect(triggers.map((trigger) => trigger.textContent?.trim())).toEqual([
        "Properties",
        "File information",
        "Used in0",
      ]);
      const filenameInput = pane?.querySelector('input[title="' + filename + '"]') as HTMLInputElement | null; // prettier-ignore
      expect(filenameInput?.className).toContain("h-8");
      expect(filenameInput?.value).toBe(filename);
      expect(filenameInput?.closest(".space-y-4")).not.toBeNull();
      expect(pane?.getAttribute("data-state")).toBe("expanded");
      expect(
        pane?.querySelector('[aria-label="Hide media details"]'),
      ).not.toBeNull();
      await typeInto(filenameInput as HTMLElement, "draft-name.png");

      // The document fields contract: automatic folds happen only when AI
      // changes state; manual reopening alongside chat is always available.
      await click(container.querySelector('[aria-label="Hide media details"]') as HTMLElement); // prettier-ignore
      expect(pane?.getAttribute("data-state")).toBe("collapsed");
      expect(pane?.getAttribute("aria-hidden")).toBe("false");
      expect(pane?.className).toContain("max-md:hidden");
      expect(pane?.className).toContain("lg:data-[state=collapsed]:w-(--heyo-sidebar-width-icon)"); // prettier-ignore
      expect(pane?.querySelector('[data-slot="scroll-area"]')?.hasAttribute("inert")).toBe(true); // prettier-ignore
      expect(pane?.querySelector("footer")?.hasAttribute("inert")).toBe(true);
      expect((filenameInput as HTMLInputElement).value).toBe("draft-name.png");
      await click(button(filename)); // The same tile also reopens it on phones.
      expect(pane?.getAttribute("data-state")).toBe("expanded");
      await click(container.querySelector('[aria-label="Open AI assistant"]') as HTMLElement); // prettier-ignore
      expect(pane?.getAttribute("data-state")).toBe("collapsed");
      expect(pane?.querySelector('[aria-label="Show media details"]')).not.toBeNull(); // prettier-ignore
      expect(container.querySelector('[aria-label="AI assistant"]')?.getAttribute("data-state")).toBe("open"); // prettier-ignore
      await click(container.querySelector('[aria-label="Show media details"]') as HTMLElement); // prettier-ignore
      expect(pane?.getAttribute("data-state")).toBe("expanded");
      expect(container.querySelector('[aria-label="AI assistant"]')?.getAttribute("data-state")).toBe("open"); // prettier-ignore
      expect((filenameInput as HTMLInputElement).value).toBe("draft-name.png");
      await click(container.querySelector('[aria-label="Close the assistant"]') as HTMLElement); // prettier-ignore
      expect(pane?.getAttribute("data-state")).toBe("expanded");
      expect((button("Save changes") as HTMLButtonElement).disabled).toBe(
        false,
      );
      await click(button("Save changes"));
      expect(patches).toHaveLength(1);
      expect(patches[0]).toMatchObject({ filename: "draft-name.png" });
      expect(patches[0]).not.toHaveProperty("alt");
      expect(patches[0]).not.toHaveProperty("locale");
      expect(file.alt).toEqual({ en: "" });
      await click(container.querySelector('[aria-label="Hide media details"]') as HTMLElement); // prettier-ignore
      expect(pane?.getAttribute("data-state")).toBe("collapsed");
      await click(container.querySelector('[aria-label="Open AI assistant"]') as HTMLElement); // prettier-ignore
      expect(pane?.getAttribute("data-state")).toBe("collapsed");
      await click(container.querySelector('[aria-label="Close the assistant"]') as HTMLElement); // prettier-ignore
      expect(pane?.getAttribute("data-state")).toBe("expanded");

      // Choosing another file while AI is open is like navigating to a new
      // document: start folded, then restore this file when the chat closes.
      await click(container.querySelector('[aria-label="Open AI assistant"]') as HTMLElement); // prettier-ignore
      await click(button("another.png"));
      expect(pane?.getAttribute("data-state")).toBe("collapsed");
      expect((pane?.querySelector('input[title="another.png"]') as HTMLInputElement).value).toBe("another.png"); // prettier-ignore
      await click(container.querySelector('[aria-label="Close the assistant"]') as HTMLElement); // prettier-ignore
      expect(pane?.getAttribute("data-state")).toBe("expanded");
      await click(button(filename));
      expect((pane?.querySelector('input[title="' + filename + '"]') as HTMLInputElement).value).toBe(filename); // prettier-ignore
      await click(pane?.querySelectorAll('[data-slot="accordion-trigger"]')[1] as HTMLElement); // prettier-ignore
      expect(pane?.textContent).toContain("Dimensions");
      await click(pane?.querySelectorAll('[data-slot="accordion-trigger"]')[2] as HTMLElement); // prettier-ignore
      expect(pane?.textContent).toContain("Nothing points at it yet.");

      // Selecting a tile is separate from opening it; the toolbar takes the
      // same bulk-action state as a document table. Only the visible page is
      // ever selected, and Previous uses the saved keyset cursor.
      await click(container.querySelector('[aria-label="Close media details"]') as HTMLElement); // prettier-ignore
      await click(container.querySelector('[aria-label="Select ' + filename + '"]') as HTMLElement); // prettier-ignore
      expect(pane?.getAttribute("data-state")).toBe("empty");
      expect(pane?.hasAttribute("inert")).toBe(true);
      expect(container.textContent).toContain("Delete 1");
      expect(container.querySelector('[aria-label="Select every file on this page"]')?.hasAttribute("data-indeterminate")).toBe(true); // prettier-ignore
      await click(button("Next"));
      expect(cursors.at(-1)).toBe("next-page");
      expect(container.textContent).toContain("second-page.png");
      expect(container.textContent).toContain("Page 2 · 1 shown");
      expect(container.textContent).not.toContain("Delete 1");
      expect((button("Next") as HTMLButtonElement).disabled).toBe(true);
      await click(button("Previous"));
      expect(cursors.at(-1)).toBeNull();
      expect(container.textContent).toContain(filename);
      await click(button("Next"));
      await typeInto(container.querySelector('input[aria-label="Search media"]') as HTMLElement, "another"); // prettier-ignore
      await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
      await settle();
      expect(searches.at(-1)).toBe("another");
      expect(cursors.at(-1)).toBeNull();
      expect((button("Previous") as HTMLButtonElement).disabled).toBe(true);
      expect(container.querySelector('[aria-label="Open another.png details"]')).not.toBeNull(); // prettier-ignore
      expect(container.querySelector('[aria-label="Open ' + filename + ' details"]')).toBeNull(); // prettier-ignore
      await click(container.querySelector('[aria-label="Clear media search"]') as HTMLElement); // prettier-ignore
      await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
      await settle();
      expect(searches.at(-1)).toBeNull();
      expect(container.textContent).toContain(filename);
      await typeInto(container.querySelector('input[aria-label="Search media"]') as HTMLElement, "missing"); // prettier-ignore
      await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
      await settle();
      expect(container.textContent).toContain("Nothing matches");
      await click(container.querySelector('[aria-label="Clear media search"]') as HTMLElement); // prettier-ignore
      await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
      await settle();
      await click(button("Next"));
      await click(button("Unused"));
      expect(cursors.at(-1)).toBeNull();
      expect((button("Previous") as HTMLButtonElement).disabled).toBe(true);
      await click(button("Library"));
      expect(container.textContent).toContain(filename);

      // Deleting the only file on a later page returns to the previous page
      // rather than stranding the user at an empty keyset cursor.
      await click(button("Next"));
      await click(button("second-page.png"));
      await click(button("Delete"));
      await click(dialogButton("Delete"));
      expect(container.textContent).toContain("Page 1 · 2 shown");
      expect(container.querySelector('[aria-label="Open second-page.png details"]')).toBeNull(); // prettier-ignore

      await click(container.querySelector('[aria-label="Select every file on this page"]') as HTMLElement); // prettier-ignore
      expect(container.textContent).toContain("Delete 2");
      await click(button("Delete 2"));
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(filename); // prettier-ignore
      await click(dialogButton("Delete 2"));
      expect(container.textContent).toContain("The library is empty");
      expect(container.querySelector('[aria-label="Open ' + filename + ' details"]')).toBeNull(); // prettier-ignore
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Driving the application
// ---------------------------------------------------------------------------

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
      <PanelProvider key={path} config={config} initialSession={session}>
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

/** A button inside the rendered panel. */
function button(label: string): HTMLElement {
  const match = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().toLowerCase().includes(label.toLowerCase()),
  );
  if (!match) {
    throw new Error(
      `No button labelled "${label}". Found: ${[...container.querySelectorAll("button")].map((element) => element.textContent?.trim()).join(" | ")}`,
    );
  }
  return match as unknown as HTMLElement;
}

/** Radix renders dialogs and menus into a portal, outside the container. */
function dialogButton(label: string): HTMLElement {
  const match = [
    ...globalThis.document.querySelectorAll('[role="dialog"] button'),
  ].find((element) => element.textContent?.trim() === label);
  if (!match) throw new Error(`No dialog button labelled "${label}".`);
  return match as unknown as HTMLElement;
}

function dialogInput(label: string): HTMLElement {
  const field = [
    ...globalThis.document.querySelectorAll('[role="dialog"] label'),
  ].find((element) =>
    element.textContent?.trim().toLowerCase().startsWith(label.toLowerCase()),
  );
  const id = field?.getAttribute("for");
  const element = id
    ? globalThis.document.querySelector(`[id="${id}"]`)
    : globalThis.document.querySelector('[role="dialog"] input');
  if (!element) throw new Error(`No dialog input labelled "${label}".`);
  return element as unknown as HTMLElement;
}

function menuTrigger(label: string): HTMLElement {
  const match = container.querySelector(`[aria-label="${label}"]`);
  if (!match) throw new Error(`No menu trigger labelled "${label}".`);
  return match as unknown as HTMLElement;
}

function input(label: string): HTMLElement {
  const element = findControl(container, label);
  if (!element) throw new Error(`No input labelled "${label}".`);
  return element as unknown as HTMLElement;
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

/** How many times a word appears, for "exactly one card" assertions. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A navigation link in the sidebar, by the path it points at. */
function sidebarLink(to: string): HTMLElement {
  const match = [...container.querySelectorAll("a")].find(
    (element) => element.getAttribute("href") === `/api/heyo-cms/admin${to}`,
  );
  if (!match) throw new Error(`No sidebar link to "${to}".`);
  return match as unknown as HTMLElement;
}

/** Types into the assistant's composer and presses its send button. */
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

  // Icon-only, so it is found by its accessible name rather than its text —
  // which is the same way somebody using a screen reader finds it.
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
