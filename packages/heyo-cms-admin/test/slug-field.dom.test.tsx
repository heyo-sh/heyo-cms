import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { act as actType } from "react";
import type { Root } from "react-dom/client";

import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, heyoCms } from "../../heyo-cms/src/config";
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import { slug, text } from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import type { Actor } from "../../heyo-cms/src/types/actor";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";
import { findControl } from "./controls";

/**
 * The slug field in the panel: a text box whose empty state says what will
 * happen on save, and under it the document's previous slugs — the old URLs
 * that still lead here — which an editor can add to (a merge) and remove
 * from (freeing an address) without saving the document.
 */

const adapter = sqlite(new Database(":memory:"));
const editor: Actor = {
  id: "usr_editor",
  source: "session",
  roles: ["admin"],
  permissions: ["*"],
};

let cms: CmsInstance;
let root: Root;
let container: HTMLElement;
let act: typeof actType;
let postId: string;

beforeAll(async () => {
  ({ act } = await import("react"));
  const { createRoot } = await import("react-dom/client");

  cms = heyoCms({
    database: () => adapter,
    admin: { path: "/admin", auth: cmsUsers({ methods: ["password"] }) },
    collections: {
      posts: defineCollection({
        admin: { useAsTitle: "title" },
        fields: {
          title: text({ required: true }),
          slug: slug({ from: "title", history: true }),
        },
      }),
    },
  }) as unknown as CmsInstance;

  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_slug"),
  );

  (cms.auth as { actorFromRequest: () => Promise<Actor> }).actorFromRequest =
    async () => editor;

  const posts = (cms.api as Record<string, typeof cms.api.posts>).posts!;
  const post = await posts.create({ data: { title: "First name" }, actor: editor }); // prettier-ignore
  postId = String(post!.id);
  await posts.update({ id: postId, data: { slug: "second-name" }, actor: editor }); // prettier-ignore

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    cms.handler(
      new Request(
        typeof input === "string" || input instanceof URL
          ? new URL(String(input), "http://cms.test").href
          : input,
        init,
      ),
    )) as typeof fetch;

  document.body.innerHTML =
    '<script type="application/json" id="heyo-cms-panel">' +
    JSON.stringify({
      basePath: "/api/heyo-cms",
      panelPath: "/api/heyo-cms/admin",
      title: "CMS",
    }) +
    "</script>";

  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterAll(async () => {
  await act(async () => root.unmount());
  await GlobalRegistrator.unregister();
});

test("a new document says where its slug will come from", async () => {
  await mount("/c/posts/new");
  const input = findControl(container, "Slug") as HTMLInputElement;
  expect(input).not.toBeNull();
  expect(input.placeholder).toBe("Made from title when saved empty");
  // No document yet, so no previous slugs to show.
  expect(container.textContent).not.toContain("Previous slugs");
});

test("an existing document lists its previous slugs, and they can be edited", async () => {
  await mount(`/c/posts/${postId}`);
  const input = findControl(container, "Slug") as HTMLInputElement;
  expect(input.value).toBe("second-name");
  expect(container.textContent).toContain("Previous slugs");
  expect(container.textContent).toContain("first-name");

  // Merge: another page's old address now leads here.
  const add = container.querySelector(
    '[aria-label="Add a previous slug"]',
  ) as HTMLInputElement;
  await type(add, "Merged Post");
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Add",
  )!;
  await click(button);
  expect(container.textContent).toContain("merged-post");
  const posts = (cms.api as Record<string, typeof cms.api.posts>).posts!;
  expect((await posts.resolveSlug("merged-post"))?.id).toBe(postId);

  // And removing one frees the address.
  await click(
    [...container.querySelectorAll("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") ===
        'Stop "first-name" leading here',
    )!,
  );
  expect(container.textContent).not.toContain("first-name");
  expect(await posts.resolveSlug("first-name")).toBeNull();
});

/* -------------------------------------------------------------------------- */

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
  await act(async () =>
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
    ),
  );
  await settle();
}

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function type(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle();
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    for (const [event, Constructor] of [
      ["pointerdown", window.PointerEvent],
      ["mousedown", window.MouseEvent],
      ["pointerup", window.PointerEvent],
      ["mouseup", window.MouseEvent],
      ["click", window.MouseEvent],
    ] as const) {
      element.dispatchEvent(new Constructor(event, { bubbles: true }));
    }
  });
  await settle();
}
