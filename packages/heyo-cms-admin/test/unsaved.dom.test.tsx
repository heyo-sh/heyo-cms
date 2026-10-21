import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The panel reads `document` while its modules evaluate, so the DOM has to
// exist before the first import of the application.
GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { act as actType } from "react";
import type { Root } from "react-dom/client";

import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, heyoCms } from "../../heyo-cms/src/config";
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import { richText, text } from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import type { Actor } from "../../heyo-cms/src/types/actor";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";
import { findControl } from "./controls";

/**
 * "Unsaved" has to mean unsaved.
 *
 * The badge, the Save button and the leave-confirmation all read one set:
 * the names of the fields that differ from the stored document. Anything
 * that puts a name in it without a person having typed something makes all
 * three lie, and the lie is sticky — the set is only emptied by a save or a
 * reload, so one spurious entry marks a document unsaved for the rest of the
 * session, and the guard then offers to discard work that does not exist.
 *
 * Two ways in, both of them reported by editors as "it says unsaved the
 * moment I save it":
 *
 * 1. **TipTap's `setEditable` emits an `update`.** It has no transaction to
 *    report so it invents one, and the panel calls it on every mount of
 *    every rich-text field.
 * 2. **A JSON column may reorder keys.** A rich-text body is stored as JSON,
 *    and Postgres `jsonb` hands objects back as a sorted map — ProseMirror
 *    writes `{"type":"text","text":"hi"}` and gets `{"text":"hi",…}` back.
 *    Comparing the two with `JSON.stringify` says "edited" about a document
 *    nobody has touched, which is why the comparison is canonical now.
 *
 * The second is reproduced here exactly as Postgres produces it: SQLite
 * stores the JSON text it is given, so a body written with its keys in
 * another order *is* the jsonb case, on the adapter the suites run on.
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
        },
      }),
    },
  }) as unknown as CmsInstance;

  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_unsaved"),
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

test("a document that has just been created is not unsaved", async () => {
  await mount("/c/posts/new");
  await typeInto(input("Title"), "Fresh post");
  await click(button("Save"));

  // The create navigated to the record's own route, so the form on screen is
  // the stored document and there is nothing left to write.
  expect(window.location.pathname).toMatch(/\/c\/posts\/[^/]+$/);
  expect(container.textContent).not.toContain("unsaved");
  expect(button("Save").hasAttribute("disabled")).toBe(true);

  const page = await cms.api.posts.find({ actor: editor });
  expect(page.docs).toHaveLength(1);
});

test("a body whose JSON column reordered its keys is not an edit", async () => {
  const stored = await cms.api.posts.create({
    actor: editor,
    data: {
      title: "Round tripped",
      // Every object's keys in the order `jsonb` would return them —
      // shortest first, then alphabetical — which is not the order TipTap
      // writes them in.
      body: {
        content: [
          { content: [{ text: "Hello", type: "text" }], type: "paragraph" },
        ],
        type: "doc",
      },
    },
  });

  await mount(`/c/posts/${String(stored.id)}`);

  expect((input("Title") as HTMLInputElement).value).toBe("Round tripped");
  expect(container.textContent).toContain("Hello");
  expect(container.textContent).not.toContain("unsaved");
  expect(button("Save").hasAttribute("disabled")).toBe(true);
});

test("typing and undoing it leaves the field clean", async () => {
  const [document] = (await cms.api.posts.find({ actor: editor })).docs;
  await mount(`/c/posts/${String(document?.id)}`);

  const title = input("Title");
  const original = (title as HTMLInputElement).value;

  await typeInto(title, `${original} (draft)`);
  expect(container.textContent).toContain("unsaved");

  // Dirty is a comparison with the stored value, not a record of which
  // controls have spoken: putting the value back puts the badge away.
  await typeInto(title, original);
  expect(container.textContent).not.toContain("unsaved");
  expect(button("Save").hasAttribute("disabled")).toBe(true);
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

/** Lets the effects that fetch — and the editor that mounts — finish. */
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

function button(label: string): HTMLElement {
  const match = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().toLowerCase().includes(label.toLowerCase()),
  );
  if (!match) throw new Error(`No button labelled "${label}".`);
  return match as unknown as HTMLElement;
}
