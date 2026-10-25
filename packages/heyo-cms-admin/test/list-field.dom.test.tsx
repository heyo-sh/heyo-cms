import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { act as actType } from "react";
import type { Root } from "react-dom/client";

import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, heyoCms } from "../../heyo-cms/src/config";
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import { list, richText, text, textarea } from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import type { Actor } from "../../heyo-cms/src/types/actor";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";
import { findControl } from "./controls";

/**
 * A `list` field in the panel: rows of the same fields, added, filled in,
 * reordered and removed in place, and saved as the array the API stores.
 *
 * The collection has a rich-text body, so the list sits in the property pane
 * beside the writing surface — the narrow place it has to work in.
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
          body: richText({}),
          faq: list({
            label: "FAQ",
            fields: {
              question: text({ required: true }),
              answer: textarea({ description: "Markdown." }),
            },
          }),
        },
      }),
    },
  }) as unknown as CmsInstance;

  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_list"),
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

test("rows are added, filled in, reordered and saved as the stored array", async () => {
  await mount("/c/posts/new");
  await typeInto(control(container, "Title"), "With questions");
  expect(faq().textContent).toContain("No rows yet.");

  await click(button("Add row"));
  await typeInto(control(row(1), "Question"), "First?");
  await typeInto(control(row(1), "Answer"), "One.");
  expect(row(1).textContent).toContain("Markdown.");

  await click(button("Add row"));
  await typeInto(control(row(2), "Question"), "Second?");
  await click(button("Move row 2 up"));
  // The row moved with what was typed in it, not just its position.
  expect((control(row(1), "Question") as HTMLInputElement).value).toBe("Second?"); // prettier-ignore
  expect((control(row(2), "Answer") as HTMLTextAreaElement).value).toBe("One.");

  await click(button("Save"));
  const [stored] = (await cms.api.posts.find({ actor: editor })).docs;
  expect(stored?.faq).toEqual([
    { question: "Second?", answer: null },
    { question: "First?", answer: "One." },
  ]);
});

test("a removed row is gone from what is saved, and the last one empties the field", async () => {
  const [stored] = (await cms.api.posts.find({ actor: editor })).docs;
  await mount(`/c/posts/${String(stored?.id)}`);
  expect((control(row(2), "Question") as HTMLInputElement).value).toBe("First?"); // prettier-ignore

  await click(button("Remove row 1"));
  await click(button("Save"));
  expect((await cms.api.posts.findById(String(stored?.id)))?.faq).toEqual([
    { question: "First?", answer: "One." },
  ]);

  await click(button("Remove row 1"));
  expect(faq().textContent).toContain("No rows yet.");
  await click(button("Save"));
  expect((await cms.api.posts.findById(String(stored?.id)))?.faq).toBeNull();
});

test("a row the server refuses says which row and which field", async () => {
  await mount("/c/posts/new");
  await typeInto(control(container, "Title"), "Unanswered");
  await click(button("Add row"));
  await click(button("Save"));
  // `question` is required in every row: the refusal is a toast (outside the
  // form), it names the row and the field, and nothing was created.
  expect(document.body.textContent).toContain("faq #1 question: is required");
  expect((await cms.api.posts.find({ actor: editor })).docs).toHaveLength(1);
});

/* -------------------------------------------------------------------------- */

function faq(): HTMLElement {
  const group = container.querySelector('[role="group"][aria-label="FAQ"]');
  if (!group) throw new Error("No FAQ list on the page.");
  return group as HTMLElement;
}

function row(number: number): HTMLElement {
  const item = faq().querySelector(`li[aria-label="FAQ, row ${number}"]`);
  if (!item) throw new Error(`No row ${number}.`);
  return item as HTMLElement;
}

function control(scope: ParentNode, label: string): HTMLElement {
  const element = findControl(scope, label);
  if (!element) throw new Error(`No control labelled "${label}".`);
  return element as HTMLElement;
}

function button(label: string): HTMLElement {
  const match = [...container.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label ||
      element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button "${label}".`);
  return match as HTMLElement;
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
    { Toaster },
  ] = await Promise.all([
    import("../src/app/app"),
    import("../src/app/lib/panel"),
    import("../src/app/lib/router"),
    import("../src/app/components/confirm"),
    import("../src/app/lib/assistant"),
    import("../src/app/lib/api"),
    // Mounted by `main.tsx` in the real panel; a refused save is a toast.
    import("@heyo-sh/heyo-ui"),
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
              <Toaster />
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

/** Types the way React notices: through the prototype setter, then `input`. */
async function typeInto(element: HTMLElement, value: string): Promise<void> {
  const prototype =
    element instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle();
}
