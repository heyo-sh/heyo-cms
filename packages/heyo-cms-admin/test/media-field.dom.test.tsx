import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { act as actType } from "react";
import type { Root } from "react-dom/client";

import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, heyoCms } from "../../heyo-cms/src/config";
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import { media, text } from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import type { Actor } from "../../heyo-cms/src/types/actor";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";
import { findControl } from "./controls";

/**
 * One field, one trigger.
 *
 * The media row used to be an input *and* a button, both wired to the same
 * picker: two controls doing one thing, with the larger of the two being the
 * one nobody was told to click. The field is the trigger now, and the only
 * other control in the row is the one that does something different —
 * clearing the reference, which is why it appears only when there is one.
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
          cover: media({ accept: "image/*" }),
        },
      }),
    },
  }) as unknown as CmsInstance;

  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_media"),
  );

  (cms.auth as { actorFromRequest: () => Promise<Actor> }).actorFromRequest =
    async () => editor;

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

test("the media field is the only thing that opens the picker", async () => {
  await mount("/c/posts/new");

  const field = findControl(container, "Cover") as HTMLInputElement;
  expect(field).not.toBeNull();
  expect(field.readOnly).toBe(true);
  expect(field.placeholder).toBe("No file chosen");

  // The row holds the field and nothing else: no second trigger beside it,
  // and no cross either, because there is no reference to clear yet.
  const row = field.closest("div")?.parentElement?.parentElement;
  expect(row?.querySelectorAll("button")).toHaveLength(0);

  // And the field itself opens the library.
  await click(field);
  const dialog = globalThis.document.querySelector('[data-slot="dialog"]');
  expect(dialog?.textContent).toContain("Media");
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
