import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Before anything else: the panel reads `document` while its modules are
// evaluated (the mount point is written into the page by the shell), so the
// DOM has to exist before the first import of the application.
GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { act as actType } from "react";
import type { Root } from "react-dom/client";

// The engine, from source rather than from `dist`: this suite runs on a
// checkout where only the panel has been built, and the point of the test is
// the panel against a *real* handler, not against a mock of one.
import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, defineGlobal, heyoCms } from "../../heyo-cms/src/config"; // prettier-ignore
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import {
  boolean,
  date,
  multiselect,
  number,
  richText,
  select,
  text,
} from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import type { Actor } from "../../heyo-cms/src/types/actor";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";
import { findControl } from "./controls";

/**
 * The panel, clicked.
 *
 * Stage 8 is finished when "editor → draft → publish → trash → restore" can
 * be done without touching the API, so the test is that sentence: a real
 * engine on SQLite, a real `cms.handler`, `fetch` pointed at it, and the
 * actual React application driven through DOM events. Nothing is stubbed
 * except the actor, which stands in for a sign-in.
 *
 * It is a slow test by this repository's standards and it is worth it: every
 * other suite proves the API is right, and none of them would notice the
 * panel sending `data` at the wrong nesting level.
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
/**
 * React, imported after the DOM exists.
 *
 * ES imports are hoisted above `GlobalRegistrator.register()`, and react-dom
 * decides what environment it is in while it is being evaluated — imported
 * statically it binds to a world with no `document` and then quietly
 * receives no events. Loading it here is the difference between a suite that
 * clicks and a suite that renders once and lies.
 */
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
    i18n: { locales: ["en", "de"], defaultLocale: "en" },
    trash: { enabled: true, purgeAfter: "30d" },
    globals: {
      settings: defineGlobal({
        label: "Site settings",
        fields: {
          siteName: text({ default: "Acme" }),
          live: boolean({}),
          headline: text({ localized: true }),
        },
      }),
    },
    collections: {
      posts: defineCollection({
        admin: { useAsTitle: "title", defaultColumns: ["title", "status"] },
        fields: {
          title: text({ required: true, localized: true }),
          tagline: text({ localized: true }),
          handle: text({
            generate: ({ fields }) =>
              String(fields.title ?? "")
                .toLowerCase()
                .replaceAll(" ", "-"),
          }),
          status: select({
            options: ["draft", "published"],
            default: "draft",
          }),
          score: number({ integer: true }),
          active: boolean({}),
          publishedAt: date({}),
          tags: multiselect({ options: ["news", "featured", "other"] }),
          body: richText({ localized: true }),
          excerpt: richText({}),
        },
      }),
    },
  }) as unknown as CmsInstance;

  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_panel"),
  );

  // Signed in, without a sign-in: the session mechanics have their own suite
  // and a cookie jar in happy-dom would test happy-dom.
  const auth = cms.auth as { actorFromRequest: () => Promise<Actor> };
  auth.actorFromRequest = async () => editor;

  // Every request the panel makes, into the real handler.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(
      typeof input === "string" || input instanceof URL
        ? new URL(String(input), "http://cms.test").href
        : input,
      init,
    );
    return cms.handler(request);
  }) as typeof fetch;

  // What the shell writes into the page.
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

describe("the panel, end to end", () => {
  test("generates a field from the draft without AI or an implicit save", async () => {
    await mount("/c/posts/new");
    await typeInto(input("Title"), "Hello World");
    const generate = container.querySelector<HTMLButtonElement>(
      '[aria-label="Generate Handle"]',
    );
    expect(generate).not.toBeNull();
    expect(generate?.classList.contains("size-8")).toBe(true);
    const before = (await cms.api.posts.find({ actor: editor })).docs.length;
    await click(generate!);
    expect((input("Handle") as HTMLInputElement).value).toBe("hello-world");
    expect((await cms.api.posts.find({ actor: editor })).docs.length).toBe(
      before,
    );
  });

  test("renders the collections the configuration declares", async () => {
    await mount("/");
    expect(container.textContent).toContain("Posts");
    expect(container.textContent).toContain("Site settings");
  });

  test("API help follows the route and switches between local and HTTP examples", async () => {
    await mount("/c/posts/new");
    const bar = container.querySelector("header");
    const trigger = bar?.querySelector<HTMLButtonElement>(
      'button[aria-label="How to use this API"]',
    );
    expect(trigger).not.toBeNull();
    expect(bar?.lastElementChild).toBe(trigger);
    expect(trigger?.classList.contains("size-6.5")).toBe(true);
    expect(trigger?.textContent?.trim()).toBe("");

    await click(trigger!);
    const sheet = document.querySelector('[data-slot="sheet"]');
    expect(sheet?.textContent).not.toContain("Endpoint");
    expect(sheet?.textContent).not.toContain("Server · local CMS API");
    expect(sheet?.textContent).toContain('cms.api["posts"].create');
    const languageTag = sheet?.querySelector(
      '[data-slot="code-block-bar"] span',
    );
    expect(languageTag?.textContent).toBe("ts");
    expect(languageTag?.classList.contains("uppercase")).toBe(true);
    const strip = sheet?.querySelector(
      '[data-slot="tabs-list"]',
    )?.parentElement;
    expect(strip?.classList.contains("border-b")).toBe(true);
    expect(
      strip?.parentElement?.querySelector('[data-slot="sheet-body"]'),
    ).not.toBeNull();
    const clientTab = [
      ...sheet!.querySelectorAll<HTMLElement>('[role="tab"]'),
    ].find((element) => element.textContent?.trim() === "Client");
    expect(clientTab).not.toBeNull();
    await click(clientTab!);
    expect(sheet?.textContent).toContain('client["posts"].create');
    expect(
      sheet?.querySelector('[data-slot="code-block-bar"] span')?.textContent,
    ).toBe("ts");
    expect(
      sheet?.querySelector(
        '[data-slot="sheet-footer"] a[href="https://heyo.sh"]',
      )?.textContent,
    ).toContain("Full Guide");
    await click(control("Close"));
  });

  test("the integration examples match the selected resource without leaking keys", async () => {
    const { usageExample } = await import("../src/app/components/usage-helper");
    expect(
      usageExample({ kind: "media", status: "orphaned" }, "en").server,
    ).toContain('status: "orphaned"');
    expect(
      usageExample({ kind: "media", status: "active" }, "en").client,
    ).toContain('status: "active"');
    expect(usageExample({ kind: "keys" }, "en").client).toContain(
      "process.env.HEYO_CMS_API_KEY",
    );
    expect(usageExample({ kind: "locales" }, "en").client).toContain(
      "client.locales.list()",
    );
    expect(
      usageExample(
        {
          kind: "document",
          name: "posts",
          slug: "posts",
          id: 'abc"def',
          label: "Posts",
        },
        "de",
      ).client,
    ).toContain('findById("abc\\"def", { locale: "de" })');
    expect(
      usageExample(
        {
          kind: "global",
          name: "site_settings",
          slug: "site-settings",
          label: "Settings",
        },
        "en",
      ).client,
    ).toContain('client.request("/globals/site-settings"');
    expect(
      usageExample(
        {
          kind: "collection",
          name: "blog_posts",
          slug: "blog-posts",
          label: "Posts",
        },
        "en",
      ).client,
    ).toContain('client.request("/blog-posts"');
  });

  test("the sidebar is a mark, a search button and sections that fold", async () => {
    await mount("/");
    const sidebar = container.querySelector('[data-slot="sidebar"]');
    expect(sidebar).not.toBeNull();

    // The mark, and only the mark: the deployment's name is the trail's job.
    const header = sidebar?.querySelector('[data-slot="sidebar-header"]');
    expect(header?.querySelector("svg[role=img]")).not.toBeNull();

    // The search is a button, not an input — there is nothing to type into
    // here — and it carries the shortcut that opens the palette.
    const search = [...(header?.querySelectorAll("button") ?? [])].find(
      (element) => element.textContent?.includes("Search"),
    );
    expect(search).toBeDefined();
    expect(search?.querySelector('[data-slot="kbd-group"]')).not.toBeNull();

    // The AI entry point shares Search's base control height and opens the
    // panel-wide right drawer; it does not depend on an editor being open.
    const assistant = header?.querySelector(
      'button[aria-label="Open AI assistant"]',
    ) as HTMLElement | null;
    expect(assistant?.className).toContain("size-8");
    await click(assistant as HTMLElement);
    expect(
      globalThis.document.querySelector('[aria-label="AI assistant"]'),
    ).not.toBeNull();

    // Collections fold away, so forty of them cannot push Settings off the
    // bottom of the rail.
    const section = sidebar?.querySelector('[data-slot="sidebar-collapsible"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("Content");

    // And the collapse control is the page bar's alone.
    expect(sidebar?.querySelector('[data-slot="sidebar-trigger"]')).toBeNull();
    expect(
      container.querySelector('header [data-slot="sidebar-trigger"]'),
    ).not.toBeNull();
  });

  test("an empty collection says so instead of showing an empty table", async () => {
    await mount("/c/posts");
    expect(container.textContent).toContain("No posts yet");

    // And the row carrying that panel is marked as what it is, so it keeps
    // none of a record's affordances: no hover tint, no leading marker, no
    // pointer. An empty state that lights up under the cursor promises
    // something to click that is not there.
    const row = container.querySelector('tbody [data-slot="table-row"]');
    expect(row?.hasAttribute("data-placeholder")).toBe(true);
    expect(row?.hasAttribute("tabindex")).toBe(false);
  });

  test("creating a document writes it through the real API", async () => {
    await mount("/c/posts/new");

    // Rich-text fields are writing tabs on the left. Every configured
    // non-prose field, including title, stays in the right-side Fields pane.
    expect(container.textContent).toContain("Body");
    expect(container.textContent).toContain("Excerpt");
    const fields = container.querySelector('[aria-label="Document fields"]');
    expect(fields?.textContent).toContain("Title");
    expect(fields?.textContent).toContain("Status");
    expect(container.querySelector("header")?.textContent).toContain("New");

    // The assistant's composer is not part of the document screen any more.
    // It is panel-wide chrome, rendered by the shell on every screen, and it
    // is discoverable even though this deployment has no AI configured — a
    // disabled field that names its reason is fixable, an absent one is not.
    const composer = container.querySelector(
      'input[aria-label="Ask the assistant"]',
    ) as HTMLInputElement | null;
    expect(composer?.disabled).toBe(true);

    await click(button("Excerpt"));
    expect(fields?.textContent).toContain("Title");
    expect(fields?.textContent).toContain("Status");

    const title = input("Title");
    await typeInto(title, "Hello from the panel");
    await click(button("Save"));

    const page = await cms.api.posts.find({ actor: editor });
    expect(page.docs).toHaveLength(1);
    expect(page.docs[0]).toMatchObject({
      title: "Hello from the panel",
      // The default from the field definition, applied by the panel's form
      // rather than invented by it.
      status: "draft",
    });
  });

  test("new and existing document fields fold with AI but remain manually expandable", async () => {
    await mount("/c/posts/new");
    let fields = container.querySelector('[aria-label="Document fields"]');
    expect(fields?.getAttribute("data-state")).toBe("expanded");
    await click(container.querySelector('[aria-label="Open AI assistant"]') as HTMLElement); // prettier-ignore
    expect(fields?.getAttribute("data-state")).toBe("collapsed");
    await click(container.querySelector('[aria-label="Show fields"]') as HTMLElement); // prettier-ignore
    expect(fields?.getAttribute("data-state")).toBe("expanded");
    await click(container.querySelector('[aria-label="Close the assistant"]') as HTMLElement); // prettier-ignore
    expect(fields?.getAttribute("data-state")).toBe("expanded");
    await click(container.querySelector('[aria-label="Hide fields"]') as HTMLElement); // prettier-ignore
    await click(container.querySelector('[aria-label="Open AI assistant"]') as HTMLElement); // prettier-ignore
    await click(container.querySelector('[aria-label="Close the assistant"]') as HTMLElement); // prettier-ignore
    expect(fields?.getAttribute("data-state")).toBe("expanded");

    // Navigate while AI is open: a newly mounted document starts folded.
    await mount("/c/posts");
    await click(container.querySelector('[aria-label="Open AI assistant"]') as HTMLElement); // prettier-ignore
    await click(button("New post"));
    fields = container.querySelector('[aria-label="Document fields"]');
    expect(fields?.getAttribute("data-state")).toBe("collapsed");
    await click(container.querySelector('[aria-label="Close the assistant"]') as HTMLElement); // prettier-ignore
    expect(fields?.getAttribute("data-state")).toBe("expanded");

    // The same mount rule applies to a saved document, not just /new.
    await click(container.querySelector('a[href$="/c/posts"]') as HTMLElement); // prettier-ignore
    await settle();
    await click(container.querySelector('[aria-label="Open AI assistant"]') as HTMLElement); // prettier-ignore
    await click(container.querySelector('tbody [data-slot="table-row"]') as HTMLElement); // prettier-ignore
    await settle();
    fields = container.querySelector('[aria-label="Document fields"]');
    expect(fields?.getAttribute("data-state")).toBe("collapsed");
    await click(container.querySelector('[aria-label="Close the assistant"]') as HTMLElement); // prettier-ignore
    expect(fields?.getAttribute("data-state")).toBe("expanded");
    // Next test starts on /c/posts; give mount() a different provider key.
    await mount("/c/posts/new");
  });

  test("the list shows what the engine has", async () => {
    await mount("/c/posts");
    expect(container.textContent).toContain("Hello from the panel");
    expect(container.textContent).toContain("draft");
  });

  test("the row opens the document, not a link inside it", async () => {
    const [document] = (await cms.api.posts.find({ actor: editor })).docs;
    await mount("/c/posts");

    const row = container.querySelector(
      'tbody [data-slot="table-row"]',
    ) as unknown as HTMLElement;
    // Clickable means reachable: the row is a tab stop and answers Enter,
    // because a pointer-only target is not a target for everybody.
    expect(row.getAttribute("tabindex")).toBe("0");

    await click(row);
    expect(window.location.pathname).toBe(
      `/api/heyo-cms/admin/c/posts/${String(document?.id)}`,
    );
    expect((input("Title") as HTMLInputElement).value).toBe(
      "Hello from the panel",
    );
  });

  test("editing sends only the fields that changed", async () => {
    const [document] = (await cms.api.posts.find({ actor: editor })).docs;
    const id = String(document?.id);

    await mount(`/c/posts/${id}`);
    const title = input("Title");
    expect((title as HTMLInputElement).value).toBe("Hello from the panel");

    await typeInto(title, "Edited in the panel");
    await click(button("Save"));

    const updated = await cms.api.posts.findById(id, { actor: editor });
    expect(updated?.title).toBe("Edited in the panel");
    // Untouched, which is the test: a PATCH carrying the whole document
    // would have rewritten it with the value the form happened to hold.
    expect(updated?.status).toBe("draft");
  });

  test("opening a document does not make it unsaved", async () => {
    const [document] = (await cms.api.posts.find({ actor: editor })).docs;
    const id = String(document?.id);

    await mount(`/c/posts/${id}`);

    // The rich-text editor reports ProseMirror's own normalisation as an
    // update — it rebuilds itself once when the emoji table lands, and
    // parsing a stored document fills in default attributes. Treating that
    // as an edit marked every document unsaved the moment it opened, which
    // made the badge, the Save button and the leave-confirmation all lie.
    expect(container.textContent).not.toContain("unsaved");
    expect(button("Save").hasAttribute("disabled")).toBe(true);
  });

  test("publishing is a write to a field, not an action", async () => {
    const [document] = (await cms.api.posts.find({ actor: editor })).docs;
    const id = String(document?.id);

    await mount(`/c/posts/${id}`);

    // There is no publish button in this panel and no publish endpoint in
    // the API: `status` is a select like any other, in the sidebar where the
    // configuration put it, and publishing is writing to it.
    const status = input("Status");
    expect(status.getAttribute("role")).toBe("combobox");
    expect(status.hasAttribute("disabled")).toBe(false);
    expect(status.textContent).toContain("draft");

    await click(status);
    const option = [
      ...globalThis.document.querySelectorAll('[role="option"]'),
    ].find((element) => element.textContent?.trim() === "published");
    expect(option).toBeDefined();
    await click(option as unknown as HTMLElement);
    await click(button("Save"));

    const published = await cms.api.posts.findById(id, { actor: editor });
    expect(published?.status).toBe("published");
  });

  test("the trash takes a document and gives it back", async () => {
    const [document] = (await cms.api.posts.find({ actor: editor })).docs;
    const id = String(document?.id);

    await mount(`/c/posts/${id}`);
    // Destructive actions live in the ⋯ menu rather than in the header: a
    // writing screen puts Save where the hand is and keeps "delete this"
    // one deliberate step away from it.
    await click(await menuItem("Move to trash"));

    // …and the menu item only opens the question. Nothing is deleted until
    // the dialog is answered, which is the whole point of it replacing
    // `window.confirm`.
    expect(await cms.api.posts.findById(id, { actor: editor })).not.toBeNull();
    await click(dialogButton("Move to trash"));

    const gone = await cms.api.posts.findById(id, { actor: editor });
    expect(gone).toBeNull();

    await mount("/trash");
    expect(container.textContent).toContain("Edited in the panel");
    await click(button("Restore"));

    const restored = await cms.api.posts.findById(id, { actor: editor });
    expect(restored?.title).toBe("Edited in the panel");
  });

  test("a global is the same form with one row", async () => {
    await mount("/g/settings");
    const name = input("Site name");
    await typeInto(name, "Newsroom");
    await click(button("Save"));

    const settings = await cms.globals.settings.get({ actor: editor });
    expect(settings.siteName).toBe("Newsroom");
  });

  test("the language switcher is limited to global and document editors", async () => {
    await mount("/");
    expect(container.querySelector('[aria-label="Language"]')).toBeNull();

    await mount("/g/settings");
    // `i18n.locales` is `["en", "de"]`, and the editor names the current
    // language instead of its implementation code.
    expect(container.textContent).toContain("English");

    await mount("/c/posts/new");
    expect(container.querySelector('[aria-label="Language"]')).not.toBeNull();

    await mount("/settings?tab=locales");
    expect(container.querySelector('[aria-label="Language"]')).toBeNull();
    expect(container.textContent).toContain("German");
    // Configuration, so there is nothing here to press.
    expect(container.textContent).not.toContain("Add language");
  });

  test("creates a missing language only on confirmation and preserves shared fields", async () => {
    window.localStorage.setItem("heyo-cms:locale", "en");
    const original = await cms.api.posts.create({
      actor: editor,
      locale: "en",
      data: {
        title: "Source for copy",
        tagline: "Subtitle",
        status: "published",
        handle: "source-copy",
      },
    });
    const id = String(original.id);
    await mount(`/c/posts/${id}`);
    expect(
      container.querySelectorAll('header [aria-label="Language"]').length,
    ).toBe(1);
    await click(control("Language"));
    await selectOption("German");
    expect(
      document.querySelector('[data-slot="dialog"]')?.textContent,
    ).toContain("Create German version?");
    expect(
      (
        await cms.api.posts.findById(id, {
          actor: editor,
          locale: "de",
          fallbackLocale: false,
        })
      )?.title,
    ).toBeNull();
    await click(dialogButton("Cancel"));
    expect(container.querySelector("header")?.textContent).toContain("English");
    await click(control("Language"));
    await selectOption("German");
    await click(dialogButton("Create version"));
    const german = await cms.api.posts.findById(id, {
      actor: editor,
      locale: "de",
      fallbackLocale: false,
    });
    expect(german?.title).toBe("Source for copy");
    expect(german?.tagline).toBe("Subtitle");
    expect(german?.status).toBe("published");
    expect(container.querySelector("header")?.textContent).toContain("German");
    await click(control("Language"));
    await selectOption("English");
    expect(document.querySelector('[data-slot="dialog"]')).toBeNull();
    window.localStorage.setItem("heyo-cms:locale", "en");
  });

  test("saves unsaved edits before creating a language version", async () => {
    window.localStorage.setItem("heyo-cms:locale", "en");
    const original = await cms.api.posts.create({
      actor: editor,
      locale: "en",
      data: {
        title: "Before switching",
      },
    });
    const id = String(original.id);
    await mount(`/c/posts/${id}`);
    await typeInto(input("Title"), "After switching");
    await click(control("Language"));
    await selectOption("German");
    expect(
      document.querySelector('[data-slot="dialog"]')?.textContent,
    ).toContain("Save before switching languages?");
    await click(dialogButton("Save and continue"));
    expect(
      document.querySelector('[data-slot="dialog"]')?.textContent,
    ).toContain("Create German version?");
    await click(dialogButton("Create version"));
    expect(
      (await cms.api.posts.findById(id, { actor: editor, locale: "en" }))
        ?.title,
    ).toBe("After switching");
    expect(
      (
        await cms.api.posts.findById(id, {
          actor: editor,
          locale: "de",
          fallbackLocale: false,
        })
      )?.title,
    ).toBe("After switching");
    window.localStorage.setItem("heyo-cms:locale", "en");
  });

  test("global localized values create a new language without duplicating shared values", async () => {
    window.localStorage.setItem("heyo-cms:locale", "en");
    await cms.globals.settings.update({
      actor: editor,
      locale: "en",
      data: { headline: "Hello", siteName: "Newsroom" },
    });
    await mount("/g/settings");
    expect(
      container.querySelectorAll('header [aria-label="Language"]').length,
    ).toBe(1);
    await click(control("Language"));
    await selectOption("German");
    expect(
      document.querySelector('[data-slot="dialog"]')?.textContent,
    ).toContain("Create German version?");
    await click(dialogButton("Create version"));
    const german = await cms.globals.settings.get({
      actor: editor,
      locale: "de",
      fallbackLocale: false,
    });
    expect(german.headline).toBe("Hello");
    expect(german.siteName).toBe("Newsroom");
    window.localStorage.setItem("heyo-cms:locale", "en");
  });

  test("a settings tab's primary action lives in the navigation row", async () => {
    await mount("/settings?tab=keys");

    // Not a form card above the table and not a button inside it: the
    // thing that creates what a screen lists sits beside the trail, and
    // what it opens is a dialog.
    const bar = container.querySelector("header");
    expect(bar?.textContent).toContain("New API key");
    expect(
      globalThis.document.querySelector('[data-slot="dialog"]'),
    ).toBeNull();

    await click(button("New API key"));
    const dialog = globalThis.document.querySelector('[data-slot="dialog"]');
    expect(dialog?.textContent).toContain("New API key");
  });

  test("an unknown screen answers in the panel, not in the browser", async () => {
    await mount("/nope");
    expect(container.textContent).toContain("Nothing here");
  });

  test("the collection filter builder queries every supported field through the real API", async () => {
    const corpus = await Promise.all([
      cms.api.posts.create({
        actor: editor,
        data: {
          title: "Filter alpha",
          status: "draft",
          score: 10,
          active: true,
          publishedAt: "2025-01-02T00:00:00.000Z",
          tags: ["news", "featured"],
        },
      }),
      cms.api.posts.create({
        actor: editor,
        data: {
          title: "Filter beta",
          status: "published",
          score: 20,
          active: false,
          publishedAt: "2025-02-02T00:00:00.000Z",
          tags: ["other"],
        },
      }),
      cms.api.posts.create({
        actor: editor,
        data: { title: "Filter unvalued", status: "draft" },
      }),
    ]);

    await cms.api.posts.update({
      id: String(corpus[1]?.id),
      actor: editor,
      locale: "de",
      data: { title: "Filter beta DE" },
    });

    await mount("/c/posts");
    const listed = () => container.querySelector("tbody")?.textContent ?? "";

    // i18n: a language filter finds documents with a stored value in that
    // locale, independently of which locale the list itself is displaying.
    await addFilter("Language");
    await chooseComboboxValue("Language values", "German");
    await click(globalButton("Apply"));
    expect(listed()).toContain("Filter beta");
    expect(listed()).not.toContain("Filter alpha");
    await click(control("Remove Language filter"));

    // Text: the newly-created filter opens directly in its editor. "is" is
    // exact (rather than the old search box's partial match), then editing the
    // chip exercises the null-inclusive negative branch too.
    await addFilter("Title");
    await typeInto(control("Title value"), "Filter alpha");
    await click(globalButton("Apply"));
    expect(listed()).toContain("Filter alpha");
    expect(listed()).not.toContain("Filter beta");

    // Every applied filter owns its own chip and its own remove button; the
    // add button sits beside them rather than being welded into one group.
    const chip = control("Remove Title filter").closest('[role="group"]');
    expect(chip?.querySelectorAll("button").length).toBe(2);
    expect(chip?.className).toContain("ring-heyo-line");
    expect(chip?.parentElement?.className).toContain("gap-2");
    expect(chip?.parentElement?.querySelector('[aria-label="Add filter"]')?.closest('[role="group"]')).toBeNull(); // prettier-ignore

    await addFilter("Score");
    await typeInto(control("Score value"), "10");
    await click(globalButton("Apply"));
    expect(chip?.parentElement?.querySelectorAll('[role="group"]').length).toBe(2); // prettier-ignore
    expect(control("Remove Score filter").closest('[role="group"]')).not.toBe(chip); // prettier-ignore
    await click(control("Remove Score filter"));

    await click(button("Title is Filter alpha"));
    await chooseFilterOperator("Title", "is not");
    await click(globalButton("Apply"));
    expect(listed()).not.toContain("Filter alpha");
    expect(listed()).toContain("Filter unvalued");
    await click(control("Remove Title filter"));

    // Number: comparison works, and its negative form includes an absent
    // score just as the Paragraph control does.
    await addFilter("Score");
    await chooseFilterOperator("Score", "is greater than");
    await typeInto(control("Score value"), "10");
    await click(globalButton("Apply"));
    expect(listed()).toContain("Filter beta");
    expect(listed()).not.toContain("Filter alpha");

    await click(button("Score is greater than 10"));
    await chooseFilterOperator("Score", "is not");
    await typeInto(control("Score value"), "20");
    await click(globalButton("Apply"));
    expect(listed()).not.toContain("Filter beta");
    expect(listed()).toContain("Filter unvalued");
    await click(control("Remove Score filter"));

    // Boolean, datetime, select and multiselect each choose a different
    // editor control but arrive at the same server-side where parser.
    await addFilter("Active");
    await click(control("Active value"));
    await selectOption("False");
    await click(globalButton("Apply"));
    expect(listed()).toContain("Filter beta");
    expect(listed()).not.toContain("Filter alpha");
    await click(control("Remove Active filter"));

    await addFilter("Published At");
    await chooseFilterOperator("Published At", "is after");
    // Dates use the one-piece Heyo UI picker — no parallel native input and
    // calendar-button controls. Choosing a day also exercises its value
    // serialization before the filter reaches the API.
    expect(control("Published At value").tagName).toBe("BUTTON");
    expect(
      globalThis.document.querySelector('[type="datetime-local"]'),
    ).toBeNull();
    await chooseFilterDate("Published At value", new Date(2025, 0, 15));
    await click(globalButton("Apply"));
    expect(listed()).toContain("Filter beta");
    expect(listed()).not.toContain("Filter alpha");
    await click(control("Remove Published At filter"));

    await addFilter("Status");
    await chooseComboboxValue("Status values", "published");
    await click(globalButton("Apply"));
    expect(listed()).toContain("Filter beta");
    expect(listed()).not.toContain("Filter alpha");
    await click(control("Remove Status filter"));

    await addFilter("Tags");
    await chooseComboboxValue("Tags values", "news");
    await click(globalButton("Apply"));
    expect(listed()).toContain("Filter alpha");
    expect(listed()).not.toContain("Filter beta");

    await Promise.all(
      corpus.map((document) =>
        cms.api.posts.delete({
          id: String(document?.id),
          actor: editor,
          permanent: true,
        }),
      ),
    );
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Driving the application
// ---------------------------------------------------------------------------

/** Renders the panel at a path, the way a deep link would arrive. */
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
      // Keyed by the path: the router reads `location` once, when it mounts,
      // exactly as a fresh page load would.
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

/** Lets the effects that fetch finish before anything is asserted. */
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
  if (!match) {
    throw new Error(
      `No button labelled "${label}". Found: ${[...container.querySelectorAll("button")].map((element) => element.textContent?.trim()).join(" | ")}`,
    );
  }
  return match as unknown as HTMLElement;
}

/**
 * A button inside a dialog, which is portalled to `<body>` rather than into
 * the panel's container — so the confirmation this panel now asks before
 * anything destructive cannot be found by looking inside the screen.
 */
function dialogButton(label: string): HTMLElement {
  const dialog = globalThis.document.querySelector('[data-slot="dialog"]');
  if (!dialog) throw new Error(`No dialog open; wanted "${label}".`);
  const match = [...dialog.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().toLowerCase().includes(label.toLowerCase()),
  );
  if (!match) {
    throw new Error(
      `No dialog button labelled "${label}". Found: ${[...dialog.querySelectorAll("button")].map((element) => element.textContent?.trim()).join(" | ")}`,
    );
  }
  return match as unknown as HTMLElement;
}

function input(label: string): HTMLElement {
  const element = findControl(container, label);
  if (!element) throw new Error(`No input labelled "${label}".`);
  return element as unknown as HTMLElement;
}

/** A control in a popup; Base UI portals every popup outside the app root. */
function control(label: string): HTMLElement {
  const element = findControl(globalThis.document, label);
  if (!element) throw new Error(`No control labelled "${label}".`);
  return element as unknown as HTMLElement;
}

function globalButton(label: string): HTMLElement {
  const match = [...globalThis.document.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim().toLowerCase().includes(label.toLowerCase()),
  );
  if (!match) throw new Error(`No global button labelled "${label}".`);
  return match as unknown as HTMLElement;
}

async function selectOption(label: string): Promise<void> {
  const wanted = label.toLowerCase();
  const option = [
    ...globalThis.document.querySelectorAll('[role="option"]'),
  ].find((element) =>
    element.textContent?.trim().toLowerCase().startsWith(wanted),
  );
  if (!option) throw new Error(`No option labelled "${label}".`);
  await click(option as unknown as HTMLElement);
}

async function addFilter(label: string): Promise<void> {
  await click(control("Add filter"));
  const picker = globalThis.document.querySelector('[data-slot="popover"]');
  const field = [...(picker?.querySelectorAll("button") ?? [])].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!field) throw new Error(`No filter field labelled "${label}".`);
  await click(field as HTMLElement);
}

async function chooseFilterOperator(
  field: string,
  operator: string,
): Promise<void> {
  await click(control(`${field} operator`));
  await selectOption(operator);
}

async function chooseComboboxValue(
  label: string,
  value: string,
): Promise<void> {
  const input = control(label);
  await click(input);
  await typeInto(input, value);
  await selectOption(value);
}

/** Picks a calendar day from the public DatePicker control. */
async function chooseFilterDate(label: string, date: Date): Promise<void> {
  await click(control(label));

  const now = new Date();
  const months =
    (date.getFullYear() - now.getFullYear()) * 12 +
    date.getMonth() -
    now.getMonth();
  const navigation = months < 0 ? "Previous month" : "Next month";

  for (let index = 0; index < Math.abs(months); index += 1) {
    const button = globalThis.document.querySelector(
      `button[aria-label="${navigation}"]`,
    );
    if (!(button instanceof window.HTMLElement)) {
      throw new Error(`No calendar button labelled "${navigation}".`);
    }
    await click(button);
  }

  const day = [
    ...(globalThis.document.querySelectorAll('[data-slot="calendar"] button') ??
      []),
  ].find(
    (element) =>
      element.textContent === String(date.getDate()) && element.tabIndex !== -1,
  );
  if (!day) throw new Error(`No calendar day for ${date.toISOString()}.`);
  await click(day as HTMLElement);
}

/**
 * A click, as the browser actually delivers one.
 *
 * The whole pointer sequence rather than a lone `click`, because Base UI —
 * which every control in heyo-ui is built on — commits a selection on
 * `pointerup`. A bare `click` opens a `Select` and then silently picks
 * nothing, which is a passing test of a broken panel.
 */
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
  if (!item) {
    throw new Error(
      `No menu item labelled "${label}". Found: ${[...globalThis.document.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent?.trim()).join(" | ")}`,
    );
  }
  return item as unknown as HTMLElement;
}

/**
 * Types, the way React notices.
 *
 * Assigning `.value` bypasses React's value tracker and the change is
 * swallowed; going through the prototype's setter and dispatching `input` is
 * what a keystroke actually looks like to it.
 */
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
