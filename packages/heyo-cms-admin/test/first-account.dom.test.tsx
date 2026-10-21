import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The panel reads `document` while its modules are evaluated, so the DOM has
// to exist before the first import of the application.
GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { act as actType } from "react";
import type { Root } from "react-dom/client";

import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, heyoCms } from "../../heyo-cms/src/config";
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import { text } from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";
import { findControl } from "./controls";

/**
 * The first five minutes of a deployment.
 *
 * A CMS nobody has an account on used to be a dead end in the browser: the
 * panel asked for credentials that did not exist anywhere, and the only way
 * forward was a shell and `heyo-cms create-admin`. This is the test that the
 * dead end is gone — the sign-in screen offers to create the administrator,
 * the form writes through the real handler, and the screen it offers is no
 * longer offered once somebody has taken it.
 *
 * Nothing is stubbed: a real engine on SQLite, a real `cms.handler`, and the
 * actual React screen driven through DOM events.
 */

const adapter = sqlite(new Database(":memory:"));

let cms: CmsInstance;
let root: Root;
let container: HTMLElement;
let act: typeof actType;

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
    collections: {
      posts: defineCollection({ fields: { title: text({}) } }),
    },
  }) as unknown as CmsInstance;

  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_setup"),
  );

  // No actor stub here, unlike the other DOM suite: being nobody is the whole
  // point, and the claim route is the one route that answers nobody.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(
      typeof input === "string" || input instanceof URL
        ? new URL(String(input), "http://cms.test").href
        : input,
      init,
    );
    return cms.handler(request);
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
  await cms.close();
  await GlobalRegistrator.unregister();
});

describe("a CMS with no accounts", () => {
  test("offers to create the administrator instead of asking for a password", async () => {
    await mount();
    expect(container.textContent).toContain("Nobody has claimed this CMS yet");
    // The sign-in form is not also on the page: there is nobody to sign in as.
    expect(container.textContent).not.toContain("Sign in to edit");
  });

  test("the two passwords are compared on submit, not while typing", async () => {
    await mount();
    await typeInto(input("Email"), "typist@acme.test");
    await typeInto(input("Password"), "correct-horse-battery");

    // Halfway through the second password. Every character so far is a
    // mismatch and none of them is an error: the field is not wrong, it is
    // unfinished.
    await typeInto(input("Repeat password"), "correct-horse");
    expect(container.textContent).not.toContain(
      "The two passwords are not the same",
    );
    expect(button("Create the administrator").hasAttribute("disabled")).toBe(
      false,
    );

    // Pressing it is what turns the mismatch into a fact…
    await click(button("Create the administrator"));
    expect(container.textContent).toContain(
      "The two passwords are not the same",
    );
    expect(await cms.auth.users.byEmail("typist@acme.test")).toBeNull();

    // …and from then on it follows the edit that fixes it.
    await typeInto(input("Repeat password"), "correct-horse-battery");
    expect(container.textContent).not.toContain(
      "The two passwords are not the same",
    );
  });

  test("creating it writes through the real handler and signs it in", async () => {
    await mount();
    await typeInto(input("Email"), "owner@acme.test");
    await typeInto(input("Name"), "Owner");
    await typeInto(input("Password"), "correct-horse-battery");
    await typeInto(input("Repeat password"), "correct-horse-battery");
    await click(button("Create the administrator"));

    const user = await cms.auth.users.byEmail("owner@acme.test");
    expect(user).toMatchObject({
      name: "Owner",
      status: "active",
      roles: ["admin"],
    });
    // A session exists, which is what makes the redirect this screen performs
    // land on the dashboard rather than back here.
    expect(await cms.auth.sessions.list(String(user?.id))).toHaveLength(1);
  });

  test("the offer is withdrawn once somebody has taken it", async () => {
    await mount();
    expect(container.textContent).not.toContain(
      "Nobody has claimed this CMS yet",
    );
    expect(container.textContent).toContain("Sign in to edit");

    // And the route agrees with the screen, which is the part that matters:
    // the panel only ever draws what the server will accept.
    const response = await cms.handler(
      new Request("http://cms.test/api/heyo-cms/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "squatter@acme.test",
          password: "correct-horse-battery",
        }),
      }),
    );
    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Driving the application
// ---------------------------------------------------------------------------

/** The sign-in screen, rendered the way `main.tsx` renders it for nobody. */
async function mount(): Promise<void> {
  const [{ SignIn }, { api }] = await Promise.all([
    import("../src/app/screens/sign-in"),
    import("../src/app/lib/api"),
  ]);

  const config = await api.get<never>("/panel");

  await act(async () => {
    root.render(<SignIn config={config} />);
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

function button(label: string): HTMLElement {
  const match = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().toLowerCase().includes(label.toLowerCase()),
  );
  if (!match) throw new Error(`No button labelled "${label}".`);
  return match as unknown as HTMLElement;
}

function input(label: string): HTMLElement {
  const element = findControl(container, label);
  if (!element) throw new Error(`No input labelled "${label}".`);
  return element as unknown as HTMLElement;
}

/** The whole pointer sequence: Base UI controls commit on `pointerup`. */
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new window.PointerEvent("pointerdown", { bubbles: true }),
    );
    element.dispatchEvent(
      new window.MouseEvent("mousedown", { bubbles: true }),
    );
    element.dispatchEvent(
      new window.PointerEvent("pointerup", { bubbles: true }),
    );
    element.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
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
}
