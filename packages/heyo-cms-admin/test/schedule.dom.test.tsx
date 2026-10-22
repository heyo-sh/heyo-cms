import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { act as actType } from "react";
import type { Root } from "react-dom/client";

import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, heyoCms } from "../../heyo-cms/src/config";
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import { text } from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import type { Actor } from "../../heyo-cms/src/types/actor";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";
import { findControl } from "./controls";

/**
 * Scheduling a change: a month and a clock, not a `datetime-local`.
 *
 * The question the dialog asks is "which day", and a day is a grid — the
 * same `Calendar` the collection filters open, in the same panel, rather
 * than three native spin boxes whose order changes with the platform. The
 * time is the only part a grid cannot express, so it is the only text field
 * left, and the dialog reads back the instant it has understood before
 * anything is committed.
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
        fields: { title: text({ required: true }) },
      }),
    },
  }) as unknown as CmsInstance;

  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_schedule"),
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

test("a change is scheduled from the calendar, not from a native picker", async () => {
  const stored = await cms.api.posts.create({
    actor: editor,
    data: { title: "Before" },
  });
  const id = String(stored.id);

  await mount(`/c/posts/${id}`);

  // A schedule with an empty patch would do nothing at the appointed hour,
  // so the edit comes first.
  await typeInto(input("Title"), "After");
  await click(await menuItem("Schedule this change"));

  const dialog = globalThis.document.querySelector('[data-slot="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.querySelector('[data-slot="calendar"]')).not.toBeNull();
  expect(dialog?.querySelector('[type="datetime-local"]')).toBeNull();

  // Opened on a day rather than on nothing: the dialog is immediately
  // answerable, and the calendar has something selected to show.
  const selected = dialog?.querySelector("[data-selected]");
  expect(selected).not.toBeNull();

  const time = findControl(globalThis.document, "Time") as HTMLElement;
  await typeInto(time, "08:30");

  // Pick a different day from the grid — the first enabled cell after the
  // one that is selected — and the readout follows it.
  const days = [
    ...(dialog?.querySelectorAll("tbody button:not([disabled])") ?? []),
  ] as unknown as HTMLElement[];
  const next = days[days.indexOf(selected as unknown as HTMLElement) + 1];
  expect(next).toBeDefined();
  await click(next!);

  // The readout is the panel's own date format, so it is "8:30 AM" or
  // "08:30" depending on the locale the suite runs in — both of which are
  // the time that was typed.
  expect(dialog?.textContent).toMatch(/\b0?8:30/);

  await click(dialogButton("Schedule 1 field"));

  const scheduled = await cms.api.posts.findById(id, { actor: editor });
  expect(scheduled?.scheduledAt).toBeTruthy();
  const at = new Date(String(scheduled?.scheduledAt));
  expect(at.getHours()).toBe(8);
  expect(at.getMinutes()).toBe(30);
  // Scheduled, not applied: the document still holds its stored value and
  // the panel no longer has unsaved work in it.
  expect(scheduled?.title).toBe("Before");
  expect(container.textContent).not.toContain("unsaved");
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

async function typeInto(element: HTMLElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle();
}

function input(label: string): HTMLElement {
  const element = findControl(container, label);
  if (!element) throw new Error(`No input labelled "${label}".`);
  return element as unknown as HTMLElement;
}

/** The ⋯ menu's items, which only exist once it is open. */
async function menuItem(label: string): Promise<HTMLElement> {
  const trigger = [...container.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === "Document actions",
  );
  if (!trigger) throw new Error("No document actions menu.");
  await click(trigger as unknown as HTMLElement);

  const item = [
    ...globalThis.document.querySelectorAll('[role="menuitem"]'),
  ].find((element) =>
    element.textContent?.trim().toLowerCase().includes(label.toLowerCase()),
  );
  if (!item) throw new Error(`No menu item labelled "${label}".`);
  return item as unknown as HTMLElement;
}

function dialogButton(label: string): HTMLElement {
  const dialog = globalThis.document.querySelector('[data-slot="dialog"]');
  if (!dialog) throw new Error(`No dialog open; wanted "${label}".`);
  const match = [...dialog.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().toLowerCase().includes(label.toLowerCase()),
  );
  if (!match) throw new Error(`No dialog button labelled "${label}".`);
  return match as unknown as HTMLElement;
}
