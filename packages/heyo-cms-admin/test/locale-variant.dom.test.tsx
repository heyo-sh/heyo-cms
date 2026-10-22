import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { act as Act } from "react";
import type { Root } from "react-dom/client";
import { cmsUsers } from "../../heyo-cms/src/auth";
import { defineCollection, heyoCms } from "../../heyo-cms/src/config";
import { sqlite } from "../../heyo-cms/src/db/sqlite";
import { richText, text, select } from "../../heyo-cms/src/fields";
import { emptySnapshot } from "../../heyo-cms/src/schema/snapshot";
import type { Actor } from "../../heyo-cms/src/types/actor";
import type { CmsInstance } from "../../heyo-cms/src/types/instance";

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
let act: typeof Act;
let failTranslation = false;
const prompts: string[] = [];

beforeAll(async () => {
  ({ act } = await import("react"));
  const { createRoot } = await import("react-dom/client");
  cms = heyoCms({
    database: () => adapter,
    admin: { path: "/admin", auth: cmsUsers({ methods: ["password"] }) },
    i18n: { locales: ["en", "de", "fr"], defaultLocale: "en" },
    ai: {
      auth: { openai: { type: "api-key", token: "sk-test" } },
      defaultModel: { provider: "openai", model: "test" },
      complete: async (request) => {
        prompts.push(request.prompt);
        if (failTranslation) throw new Error("Translation unavailable");
        return {
          text: request.prompt.includes("Hello AI")
            ? "Hallo AI"
            : "Deutscher Text",
          usage: { input: 1, output: 1, total: 2, cost: 0 },
        };
      },
    },
    collections: {
      posts: defineCollection({
        fields: {
          title: text({ required: true, localized: true }),
          tagline: text({ localized: true }), // no ai.translate configured
          summary: text({ localized: true, default: "Default blurb" }),
          body: richText({ localized: true }),
          status: select({ options: ["draft", "published"] }),
        },
      }),
    },
  }) as unknown as CmsInstance;
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_variants"),
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

async function settle() {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
}
async function click(element: Element) {
  await act(async () => {
    for (const [event, Constructor] of [
      ["pointerdown", window.PointerEvent],
      ["mousedown", window.MouseEvent],
      ["pointerup", window.PointerEvent],
      ["mouseup", window.MouseEvent],
      ["click", window.MouseEvent],
    ] as const)
      element.dispatchEvent(new Constructor(event, { bubbles: true }));
  });
  await settle();
}
async function mount(path: string) {
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
async function chooseGerman() {
  await chooseLanguage("German");
}
async function chooseLanguage(name: string) {
  const language = container.querySelector('header [aria-label="Language"]');
  if (!language) throw new Error("Missing language switcher");
  await click(language);
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (entry) => entry.textContent?.includes(name),
  );
  if (!option) throw new Error(`Missing ${name} option`);
  await click(option);
}

test("AI creates a complete locale variant via real panel and API, without changing the original", async () => {
  window.localStorage.setItem("heyo-cms:locale", "en");
  const original = await cms.api.posts.create({
    actor: editor,
    locale: "en",
    data: {
      title: "Hello AI",
      tagline: "Other sentence",
      status: "published",
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "A paragraph",
                marks: [
                  {
                    type: "link",
                    attrs: { href: "https://example.com/article" },
                  },
                ],
              },
            ],
          },
          {
            type: "image",
            attrs: { src: "/cat.png", mediaId: "med_cat", alt: "A cat" },
          },
        ],
      },
    },
  });
  const id = String(original.id);
  const before = await cms.api.posts.findById(id, {
    actor: editor,
    locale: "de",
    fallbackLocale: false,
  });
  expect(before?.summary).toBe("Default blurb");
  expect(before?._localeFields).not.toContain("summary");
  await mount(`/c/posts/${id}`);
  await chooseGerman();
  if (
    document
      .querySelector('[data-slot="dialog"]')
      ?.textContent?.includes("Save before switching languages?")
  ) {
    const save = [
      ...document.querySelectorAll('[data-slot="dialog"] button'),
    ].find((entry) => entry.textContent?.includes("Save and continue"));
    if (!save) throw new Error("Missing save action");
    await click(save);
  }
  const dialog = document.querySelector('[data-slot="dialog"]');
  expect(dialog?.textContent).toContain("Create German version?");
  const checkbox = dialog?.querySelector('[role="checkbox"]');
  if (!checkbox) throw new Error("Missing AI checkbox");
  await click(checkbox.parentElement!);
  const create = [...(dialog?.querySelectorAll("button") ?? [])].find((entry) =>
    entry.textContent?.includes("Create and translate"),
  );
  if (!create) throw new Error("Missing translate action");
  await click(create);
  const german = await cms.api.posts.findById(id, {
    actor: editor,
    locale: "de",
    fallbackLocale: false,
  });
  expect(german?.title).toBe("Hallo AI");
  expect(german?.tagline).toBe("Deutscher Text");
  expect(german?.summary).toBe("Deutscher Text");
  expect(JSON.stringify(german?.body)).toContain("Deutscher Text");
  expect(JSON.stringify(german?.body)).toContain("med_cat");
  expect(JSON.stringify(german?.body)).toContain("https://example.com/article");
  expect(german?.status).toBe("published");
  expect(
    (await cms.api.posts.findById(id, { actor: editor, locale: "en" }))?.title,
  ).toBe("Hello AI");
  expect(document.querySelector('[data-slot="dialog"]')).toBeNull();
});

test("a partial source also translates fields that fall back to the default language", async () => {
  prompts.length = 0;
  window.localStorage.setItem("heyo-cms:locale", "de");
  const original = await cms.api.posts.create({
    actor: editor,
    locale: "en",
    data: {
      title: "Hello AI",
      tagline: "English tagline",
    },
  });
  const id = String(original.id);
  await cms.api.posts.update({
    id,
    actor: editor,
    locale: "de",
    data: { title: "German headline" },
  });
  await mount(`/c/posts/${id}`);
  await chooseLanguage("French");
  const dialog = document.querySelector('[data-slot="dialog"]');
  expect(dialog?.textContent).toContain("Create French version?");
  const checkbox = dialog?.querySelector('[role="checkbox"]');
  if (!checkbox) throw new Error("Missing AI checkbox");
  await click(checkbox.parentElement!);
  const create = [...(dialog?.querySelectorAll("button") ?? [])].find((entry) =>
    entry.textContent?.includes("Create and translate"),
  );
  if (!create) throw new Error("Missing translate action");
  await click(create);
  const french = await cms.api.posts.findById(id, {
    actor: editor,
    locale: "fr",
    fallbackLocale: false,
  });
  expect(french?.title).toBe("Deutscher Text");
  expect(french?.tagline).toBe("Deutscher Text");
  expect(
    prompts.some(
      (prompt) =>
        prompt.includes("Source language: de.") &&
        prompt.includes("German headline"),
    ),
  ).toBe(true);
  expect(
    prompts.some(
      (prompt) =>
        prompt.includes("Source language: en.") &&
        prompt.includes("English tagline"),
    ),
  ).toBe(true);
  expect(
    prompts.some(
      (prompt) =>
        prompt.includes("Source language: en.") &&
        prompt.includes("Default blurb"),
    ),
  ).toBe(true);
});

test("an AI failure does not save a partial language variant", async () => {
  window.localStorage.setItem("heyo-cms:locale", "en");
  const original = await cms.api.posts.create({
    actor: editor,
    locale: "en",
    data: {
      title: "Hello AI",
      tagline: "Other sentence",
    },
  });
  const id = String(original.id);
  await mount(`/c/posts/${id}`);
  await chooseGerman();
  const dialog = document.querySelector('[data-slot="dialog"]');
  const checkbox = dialog?.querySelector('[role="checkbox"]');
  if (!checkbox) throw new Error("Missing AI checkbox");
  await click(checkbox.parentElement!);
  failTranslation = true;
  try {
    const create = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (entry) => entry.textContent?.includes("Create and translate"),
    );
    if (!create) throw new Error("Missing translate action");
    await click(create);
    expect(
      (
        await cms.api.posts.findById(id, {
          actor: editor,
          locale: "de",
          fallbackLocale: false,
        })
      )?.title,
    ).toBeNull();
    expect(document.querySelector('[data-slot="dialog"]')).not.toBeNull();
  } finally {
    failTranslation = false;
  }
});
