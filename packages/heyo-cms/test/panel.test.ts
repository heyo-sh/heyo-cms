import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { permits } from "../src/access/permissions";
import { cmsUsers } from "../src/auth";
import { defineCollection, defineGlobal, heyoCms } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { CmsConfigError } from "../src/errors";
import {
  boolean,
  date,
  media,
  number,
  relation,
  richText,
  select,
  text,
} from "../src/fields";
import { describePanel } from "../src/panel";
import { emptySnapshot } from "../src/schema/snapshot";
import { memory } from "../src/storage/local";
import type { Actor } from "../src/types/actor";
import type { AdminAssets, AdminMountContext } from "../src/types/config";
import type { PanelCollection, PanelConfig } from "../src/types/panel";

/**
 * Stage 8: what the panel is told.
 *
 * The panel is one static bundle that has to render every deployment, so
 * `GET /panel` is the whole of its knowledge about this one. Two properties
 * matter and are asserted here:
 *
 * 1. **It is derived, not maintained.** Everything in the payload comes from
 *    the configuration, so a field added to a collection appears without
 *    anybody editing the panel.
 * 2. **It leaks nothing and decides nothing.** No provider tokens, no signing
 *    secrets, no closures; the per-actor flags are advisory and the engine
 *    still answers every real read and write.
 */

const collections = () => ({
  posts: defineCollection({
    admin: { useAsTitle: "title", defaultColumns: ["title", "status"], group: "Editorial" }, // prettier-ignore
    fields: {
      title: text({ required: true, localized: true, aiGenerate: { label: "Suggest a title" } }), // prettier-ignore
      body: richText({ localized: true }),
      status: select({
        options: ["draft", "published"],
        default: "draft",
        // The whole of "who may publish" is who may write this field, and
        // the panel has to be able to draw that as a disabled select.
        access: { update: ({ actor }) => permits(actor, "posts:publish") },
      }),
      views: number({ integer: true, min: 0 }),
      secret: text({ access: { read: ({ actor }) => permits(actor, "posts:secrets") } }), // prettier-ignore
      cover: media({ accept: "image/*" }),
      author: relation("cms_users"),
      publishedAt: date({ mode: "date" }),
      featured: boolean({}),
    },
    access: {
      read: () => true,
      create: ({ actor }) => permits(actor, "posts:create"),
      update: ({ actor }) => permits(actor, "posts:update"),
      delete: ({ actor }) => permits(actor, "posts:delete"),
    },
  }),
});

const globals = () => ({
  settings: defineGlobal({
    label: "Site settings",
    fields: { siteName: text({ default: "Acme" }) },
  }),
});

const editor: Actor = {
  id: "usr_editor",
  source: "session",
  roles: ["editor"],
  permissions: ["posts:create", "posts:update", "posts:delete", "posts:publish", "posts:secrets"], // prettier-ignore
};

const writer: Actor = {
  id: "usr_writer",
  source: "session",
  roles: ["writer"],
  permissions: ["posts:create", "posts:update"],
};

function build(overrides: Record<string, unknown> = {}) {
  const adapter = sqlite(new Database(":memory:"));
  const cms = heyoCms({
    database: () => adapter,
    admin: {
      path: "/admin",
      title: "Acme",
      auth: cmsUsers({ methods: ["password", "magic-link"], twoFactor: true }),
    },
    rbac: {
      roles: { admin: ["*"], writer: ["posts:read"] },
      customRoles: true,
    },
    i18n: { locales: ["en", "de"], defaultLocale: "en" },
    uploads: {
      storage: memory(),
      limits: { maxFileSize: "25mb", accept: ["image/*"] },
      images: {
        focalPoint: true,
        crop: true,
        variants: { mode: "on-demand", sizes: { thumb: { width: 320 } } },
      },
      retention: { purgeAfter: "30d" },
    },
    trash: { enabled: true, purgeAfter: "7d" },
    collections: collections(),
    globals: globals(),
    ...overrides,
  });
  return { cms, adapter };
}

function describeFor(actor: Actor | null): PanelConfig {
  const { cms } = build();
  return describePanel(cms._config, actor, []);
}

function postsOf(config: PanelConfig): PanelCollection {
  const posts = config.collections.find((entry) => entry.slug === "posts");
  if (!posts) throw new Error("posts missing from the description");
  return posts;
}

describe("describePanel", () => {
  test("describes the collections the configuration declares", () => {
    const config = describeFor(editor);
    const posts = postsOf(config);

    expect(config.title).toBe("Acme");
    expect(config.panelPath).toBe("/api/heyo-cms/admin");
    expect(posts.label).toBe("Posts");
    expect(posts.group).toBe("Editorial");
    expect(posts.useAsTitle).toBe("title");
    expect(posts.defaultColumns).toEqual(["title", "status"]);
    expect(config.globals.map((entry) => entry.slug)).toEqual(["settings"]);
  });

  test("carries the field options the panel renders with", () => {
    const posts = postsOf(describeFor(editor));
    const status = posts.fields.find((field) => field.name === "status");
    const views = posts.fields.find((field) => field.name === "views");
    const cover = posts.fields.find((field) => field.name === "cover");
    const author = posts.fields.find((field) => field.name === "author");

    expect(status?.options.options).toEqual(["draft", "published"]);
    expect(status?.defaultValue).toBe("draft");
    expect(views?.options).toMatchObject({ integer: true, min: 0 });
    expect(cover?.options.accept).toBe("image/*");
    expect(author?.options.relationTo).toBe("cms_users");
  });

  test("drops everything that is not data", () => {
    const posts = postsOf(describeFor(editor));
    for (const field of posts.fields) {
      const serialised = JSON.stringify(field);
      expect(serialised).not.toContain("=>");
      expect(serialised).not.toContain("function");
    }
  });

  test("field access is answered for the caller", () => {
    const forEditor = postsOf(describeFor(editor));
    const forWriter = postsOf(describeFor(writer));
    const forNobody = postsOf(describeFor(null));

    const status = (collection: PanelCollection) =>
      collection.fields.find((field) => field.name === "status");
    const secret = (collection: PanelCollection) =>
      collection.fields.find((field) => field.name === "secret");

    expect(status(forEditor)?.access.update).toBe(true);
    // No `posts:publish`: the select is drawn, and drawn disabled.
    expect(status(forWriter)?.access.update).toBe(false);
    expect(status(forNobody)?.access.update).toBe(false);

    expect(secret(forEditor)?.access.read).toBe(true);
    expect(secret(forWriter)?.access.read).toBe(false);
  });

  test("collection rules decide whether a button is drawn", () => {
    expect(postsOf(describeFor(editor)).can).toMatchObject({
      read: true,
      create: true,
      update: true,
      delete: true,
    });
    expect(postsOf(describeFor(writer)).can).toMatchObject({
      create: true,
      delete: false,
    });
    // A global has nothing to create and nothing to delete.
    const settings = describeFor(editor).globals[0];
    expect(settings?.can.create).toBe(false);
    expect(settings?.can.delete).toBe(false);
  });

  test("durations arrive parsed, so a countdown cannot re-derive them wrongly", () => {
    const config = describeFor(editor);
    expect(config.trash).toMatchObject({
      enabled: true,
      purgeAfter: "7d",
      purgeAfterMs: 604_800_000,
    });
    expect(config.media.purgeAfterMs).toBe(2_592_000_000);
    expect(config.media.maxFileSizeBytes).toBe(26_214_400);
  });

  test("media settings describe what the panel may offer", () => {
    const media = describeFor(editor).media;
    expect(media).toMatchObject({
      enabled: true,
      variants: ["thumb"],
      variantMode: "on-demand",
      focalPoint: true,
      crop: true,
      accept: ["image/*"],
    });
  });

  test("a sign-in door that does not exist is not offered", () => {
    // The magic-link route is registered only when `deliverToken` is, so the
    // panel must not render a button that answers 404.
    expect(describeFor(null).auth).toMatchObject({
      methods: ["password", "magic-link"],
      twoFactor: true,
      magicLink: false,
      passwordReset: false,
    });

    const { cms } = build({
      admin: {
        path: "/admin",
        auth: cmsUsers({
          methods: ["password", "magic-link"],
          deliverToken: () => undefined,
        }),
      },
    });
    const described = describePanel(cms._config, null, []);
    expect(described.auth.magicLink).toBe(true);
    expect(described.auth.passwordReset).toBe(true);
  });

  test("whether the CMS still needs its first account is a fact, not a setting", () => {
    // No configuration can answer this one, so it arrives as state and the
    // description simply reports it. The safe default is "somebody is already
    // here", which hides the form rather than opening it.
    expect(describeFor(null).auth.setupRequired).toBe(false);

    const { cms } = build({});
    expect(
      describePanel(cms._config, null, [], { setupRequired: true }).auth
        .setupRequired,
    ).toBe(true);
  });

  // The panel-wide assistant has no per-collection description to carry: what
  // it may read and write is decided at runtime from the live configuration
  // and the actor, not from a whitelist the bundle was told about.
  test("the assistant is a single flag, not a per-collection whitelist", () => {
    const config = describeFor(editor);
    expect(config.ai.assistant).toBe(false);
    expect(config.ai.assistantSettings).toBeNull();
    expect(postsOf(config)).not.toHaveProperty("chat");
  });

  test("AI menus are described without a single credential", () => {
    const { cms } = build({
      ai: {
        auth: { openai: { type: "api-key", token: "sk-secret-value" } },
        defaultModel: { provider: "openai", model: "gpt-4o-mini" },
        assistant: {
          enabled: true,
          model: { provider: "openai", model: "gpt-4o" },
          maxTurns: 4,
          instructions: "private editorial instructions",
        },
      },
    });
    const config = describePanel(cms._config, editor, []);

    expect(config.ai).toMatchObject({
      configured: true,
      // Stage 9 registers the routes behind the menus, so a configured
      // deployment is an answerable one.
      runtime: true,
      assistant: true,
      assistantSettings: {
        model: { provider: "openai", model: "gpt-4o" },
        maxTurns: 4,
        maxToolCalls: 16,
        timeoutMs: 90_000,
        customInstructions: true,
      },
      managedKeys: false,
    });
    // The registry travels so the panel can tell a disabled action from an
    // unknown one; the keys never do.
    expect(config.ai.actions).toContain("translate");
    expect(JSON.stringify(config)).not.toContain("sk-secret-value");
    expect(JSON.stringify(config)).not.toContain(
      "private editorial instructions",
    );

    const defaults = describePanel(
      build({
        ai: {
          auth: { openai: { type: "api-key", token: "sk-secret-value" } },
          defaultModel: { provider: "openai", model: "gpt-4o-mini" },
        },
      }).cms._config,
      editor,
      [],
    ).ai.assistantSettings;
    expect(defaults).toMatchObject({
      model: { provider: "openai", model: "gpt-4o-mini" },
      maxTurns: 8,
      maxToolCalls: 16,
      timeoutMs: 90_000,
      customInstructions: false,
    });

    const title = postsOf(config).fields.find(
      (field) => field.name === "title",
    );
    expect(title?.ai.map((action) => action.key)).toEqual(["generate"]);
    expect(title?.ai[0]?.label).toBe("Suggest a title");
    expect(JSON.stringify(title)).not.toContain("aiGenerate");
  });

  test("webhook signing secrets are not in the payload either", () => {
    const { cms } = build({
      webhooks: {
        enabled: true,
        signing: { algorithm: "hmac-sha256", secret: "shhh-secret" },
        managedInAdmin: true,
      },
    });
    const config = describePanel(cms._config, editor, []);
    expect(config.webhooks).toMatchObject({
      enabled: true,
      managedInAdmin: true,
      runtime: true,
    });
    // The catalogue travels so the subscription form is a picker rather
    // than a free-text field nobody can spell into.
    expect(config.webhooks.events).toContain("document.field.changed");
    expect(JSON.stringify(config)).not.toContain("shhh-secret");
  });
});

describe("GET /panel", () => {
  async function serve(actor: Actor | null = null) {
    const { cms, adapter } = build();
    adapter.useSchema(cms.schema);
    await adapter.applyMigration(
      adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_panel"),
    );
    const auth = cms.auth as { actorFromRequest: (request: Request) => Promise<Actor | null> }; // prettier-ignore
    auth.actorFromRequest = async () => actor;

    const response = await cms.handler(
      new Request("http://cms.test/api/heyo-cms/panel"),
    );
    return {
      cms,
      status: response.status,
      body: (await response.json()) as PanelConfig,
    };
  }

  test("answers an anonymous caller, because the sign-in screen needs it", async () => {
    const { status, body } = await serve(null);
    expect(status).toBe(200);
    expect(body.auth.methods).toContain("password");
    expect(postsOf(body).can.create).toBe(false);
  });

  test("answers the configured languages, named", async () => {
    const { body } = await serve(editor);
    expect(body.i18n.locales.map((locale) => locale.code)).toEqual(["en", "de"]); // prettier-ignore
    // The switcher shows a language, not a code.
    expect(body.i18n.locales.map((locale) => locale.name)).toEqual(["English", "German"]); // prettier-ignore
    expect(body.i18n.defaultLocale).toBe("en");
  });

  test("is in the generated OpenAPI document", async () => {
    const { cms } = await serve(editor);
    const response = await cms.handler(
      new Request("http://cms.test/api/heyo-cms/openapi.json"),
    );
    const document = (await response.json()) as { paths: Record<string, unknown> }; // prettier-ignore
    expect(document.paths["/panel"]).toBeDefined();
  });

  test("survives a database with no schema", async () => {
    // The first thing somebody does on a broken deployment is open the
    // panel. A database that cannot be counted must not hide the sign-in
    // screen behind the problem it is needed to fix.
    const { cms } = build();
    const response = await cms.handler(
      new Request("http://cms.test/api/heyo-cms/panel"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as PanelConfig;
    expect(body.i18n.locales.map((locale) => locale.code)).toEqual(["en", "de"]); // prettier-ignore
  });
});

describe("the panel's mount", () => {
  test("the bundle is told where it is served from", async () => {
    const seen: AdminMountContext[] = [];
    const assets: AdminAssets = {
      id: "test-bundle",
      configure: (context) => seen.push(context),
      asset: async (path) =>
        path === ""
          ? { body: "<!doctype html><html></html>", contentType: "text/html" }
          : null,
    };

    const { cms } = build({
      basePath: "/cms",
      admin: { path: "/panel-ui", title: "Acme", assets },
    });
    const response = await cms.handler(new Request("http://cms.test/cms/panel-ui")); // prettier-ignore

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      { basePath: "/cms", panelPath: "/cms/panel-ui", title: "Acme" },
    ]);
  });

  test("`cms.inspect().admin` prints which bundle is installed", () => {
    const assets: AdminAssets = {
      id: "heyo-cms-admin@1234",
      asset: async () => null,
    };
    const { cms } = build({ admin: { path: "/admin", assets } });
    expect(cms.inspect().admin).toEqual({
      path: "/api/heyo-cms/admin",
      panel: "heyo-cms-admin@1234",
    });
  });

  test("a collection cannot be called `panel`", () => {
    expect(() =>
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        collections: { panel: defineCollection({ fields: { title: text({}) } }) }, // prettier-ignore
      }),
    ).toThrow(CmsConfigError);
  });
});
