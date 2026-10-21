import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { defineAiAction } from "../src/ai/index";
import { decryptSecret, encryptSecret } from "../src/ai/crypto";
import { permits } from "../src/access/permissions";
import { defineCollection, heyoCms, systemActor } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { richTextToMarkdown } from "../src/editor/index";
import { CmsConfigError, CmsError } from "../src/errors";
import { media, multiselect, richText, text } from "../src/fields";
import { emptySnapshot } from "../src/schema/snapshot";
import type { Actor } from "../src/types/actor";
import type { AiCompletionRequest, AiCompletionResult } from "../src/types/ai";
import type { AiConfig, HeyoCmsConfig } from "../src/types/config";
import type { CmsEvent } from "../src/types/events";
import type { CmsInstance } from "../src/types/instance";

/**
 * Stage 9: the AI runtime.
 *
 * pi is never called here. The configuration's `ai.complete` is the seam the
 * plan asks for — "pi under the floor, replaceable" — so these tests assert
 * the things the CMS is actually responsible for: that an action exists only
 * where a field declares it, that exactly the named context reaches the
 * prompt and nothing else, that a suggestion is a suggestion rather than a
 * write, and that every call is accounted for as an event.
 */

interface Recorded {
  requests: AiCompletionRequest[];
}

const collections = () => ({
  posts: defineCollection({
    fields: {
      title: text({
        required: true,
        localized: true,
        ai: {
          generate: { prompt: "Write a title.", context: ["body", "notes"] },
          improve: true,
          translate: true,
        },
      }),
      body: richText({
        localized: true,
        ai: { generate: { prompt: "Write the article.", context: ["title"] } },
      }),
      notes: text({}),
      slug: text({
        pattern: "^[a-z0-9-]+$",
        aiGenerate: {
          label: "Suggest slug",
          prompt: "Generate a lowercase URL slug from the title.",
          context: ["title"],
          maxLength: 32,
        },
      }),
      secret: text({
        access: { read: ({ actor }) => permits(actor, "posts:secrets") },
        ai: { improve: true },
      }),
      cover: media({ ai: { alt: true } }),
      tags: multiselect({
        options: ["news", "guide"],
        ai: { tags: { context: ["title"] } },
      }),
      status: text({
        access: { update: ({ actor }) => permits(actor, "posts:publish") },
        ai: { improve: true },
      }),
    },
  }),
});

type Fixture = ReturnType<typeof collections>;

const editor: Actor = {
  id: "usr_editor",
  source: "session",
  roles: ["editor"],
  permissions: ["posts:secrets", "posts:publish"],
};

async function setup(
  answer: string | ((request: AiCompletionRequest) => string) = "A title",
  overrides: Partial<AiConfig> = {},
): Promise<{
  cms: CmsInstance<Fixture>;
  recorded: Recorded;
  events: CmsEvent[];
}> {
  const adapter = sqlite(new Database(":memory:"));
  const recorded: Recorded = { requests: [] };

  const complete = async (
    request: AiCompletionRequest,
  ): Promise<AiCompletionResult> => {
    recorded.requests.push(request);
    const text = typeof answer === "function" ? answer(request) : answer;
    return { text, usage: { input: 10, output: 5, total: 15, cost: 0.0001 } };
  };

  const config: HeyoCmsConfig<Fixture> = {
    database: () => adapter,
    collections: collections(),
    ai: {
      auth: { openai: { type: "api-key", token: "sk-from-config" } },
      defaultModel: { provider: "openai", model: "gpt-4o-mini" },
      complete,
      ...overrides,
    },
  };

  const cms = heyoCms(config);
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_ai"),
  );

  const events: CmsEvent[] = [];
  cms.on("*", (event) => {
    events.push(event);
  });
  return { cms, recorded, events };
}

describe("a field action", () => {
  test("aiGenerate fills only its field from named sibling fields, without saving", async () => {
    const { cms, recorded } = await setup("new-post");
    const result = await cms.ai.run({
      collection: "posts",
      field: "slug",
      action: "generate",
      document: { title: "New Post", notes: "private note" },
      actor: editor,
    });
    expect(result.value).toBe("new-post");
    expect(recorded.requests[0]?.prompt).toContain("New Post");
    expect(recorded.requests[0]?.prompt).not.toContain("private note");
    expect(recorded.requests[0]?.prompt).toContain(
      "Generate a lowercase URL slug",
    );
    const rows = await cms.api.posts.find({ actor: systemActor() });
    expect(rows.docs).toHaveLength(0);
  });

  test("answers with a value and never writes it", async () => {
    const { cms, recorded } = await setup("Everything about uploads");
    const created = await cms.api.posts.create({
      data: { title: "Draft", notes: "mention the lifecycle" },
      actor: systemActor(),
    });

    const result = await cms.ai.run({
      collection: "posts",
      field: "title",
      action: "generate",
      id: created?.id as string,
      actor: editor,
    });

    expect(result.value).toBe("Everything about uploads");
    expect(result.usage.total).toBe(15);
    expect(result.model).toEqual({ provider: "openai", model: "gpt-4o-mini" });

    const stored = await cms.api.posts.findById(created?.id as string, {
      actor: systemActor(),
    });
    expect(stored?.title).toBe("Draft");

    // The prompt saw exactly the named context, with the draft merged over
    // what was stored.
    const prompt = recorded.requests[0]?.prompt ?? "";
    expect(prompt).toContain("mention the lifecycle");
    expect(prompt).toContain("Write a title.");
  });

  test("merges the draft from the browser over the stored document", async () => {
    const { cms, recorded } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Draft", notes: "stored note" },
      actor: systemActor(),
    });

    await cms.ai.run({
      collection: "posts",
      field: "title",
      action: "generate",
      id: created?.id as string,
      document: { notes: "what the editor just typed" },
      actor: editor,
    });

    const prompt = recorded.requests[0]?.prompt ?? "";
    expect(prompt).toContain("what the editor just typed");
    expect(prompt).not.toContain("stored note");
  });

  test("works on a document that has never been saved", async () => {
    const { cms } = await setup("Unsaved but answerable");
    const result = await cms.ai.run({
      collection: "posts",
      field: "title",
      action: "generate",
      document: { notes: "only in the browser" },
      actor: editor,
    });
    expect(result.value).toBe("Unsaved but answerable");
  });

  test("shapes a rich-text answer into a document", async () => {
    const { cms } = await setup("## Heading\n\nAnd a paragraph.");
    const result = await cms.ai.run({
      collection: "posts",
      field: "body",
      action: "generate",
      document: { title: "Uploads" },
      actor: editor,
    });

    expect((result.value as { type: string }).type).toBe("doc");
    expect(richTextToMarkdown(result.value)).toBe(
      "## Heading\n\nAnd a paragraph.",
    );
  });

  test("picks values from the declared set and drops inventions", async () => {
    const { cms } = await setup("news, guide, nonsense");
    const result = await cms.ai.run({
      collection: "posts",
      field: "tags",
      action: "tags",
      document: { title: "Uploads" },
      actor: editor,
    });
    expect(result.value).toEqual(["news", "guide"]);
  });

  test("is absent when the field does not declare it", async () => {
    const { cms } = await setup();
    await expect(
      cms.ai.run({
        collection: "posts",
        field: "notes",
        action: "generate",
        actor: editor,
      }),
    ).rejects.toThrow(/is not configured/);
  });

  test("refuses a field the actor may not write", async () => {
    const { cms, recorded } = await setup();
    const writer: Actor = {
      id: "usr_writer",
      source: "session",
      roles: ["writer"],
      permissions: [],
    };

    await expect(
      cms.ai.run({
        collection: "posts",
        field: "status",
        action: "improve",
        document: { status: "draft" },
        actor: writer,
      }),
    ).rejects.toThrow(CmsError);
    // Refused before a token was spent.
    expect(recorded.requests).toHaveLength(0);
  });

  test("keeps a field the actor may not read out of the prompt", async () => {
    const { cms, recorded } = await setup();
    const stranger: Actor = {
      id: "usr_stranger",
      source: "session",
      roles: [],
      permissions: [],
    };

    defineAiAction({
      id: "with-secret",
      appliesTo: ["text"],
      label: "With secret",
      prompt: "Use everything you can see.",
      run: async (context) => {
        const result = await context.complete({
          system: "test",
          prompt: JSON.stringify(context.context),
        });
        return { value: result.text, preview: result.text, usage: result.usage }; // prettier-ignore
      },
    });

    const adapter = sqlite(new Database(":memory:"));
    const cmsWithSecretAction = heyoCms({
      database: () => adapter,
      ai: {
        defaultModel: { provider: "openai", model: "gpt-4o-mini" },
        auth: { openai: { type: "api-key", token: "sk" } },
        complete: async (request) => {
          recorded.requests.push(request);
          return { text: "ok", usage: { input: 1, output: 1, total: 2, cost: 0 } }; // prettier-ignore
        },
      },
      collections: {
        notes: defineCollection({
          fields: {
            secret: text({
              access: { read: ({ actor }) => permits(actor, "notes:secrets") },
            }),
            summary: text({
              ai: { "with-secret": { context: ["secret"] } },
            }),
          },
        }),
      },
    });
    adapter.useSchema(cmsWithSecretAction.schema);
    await adapter.applyMigration(
      adapter.render(
        adapter.plan(emptySnapshot(), cmsWithSecretAction.schema),
        "0000_secret",
      ),
    );

    await cmsWithSecretAction.ai.run({
      collection: "notes",
      field: "summary",
      action: "with-secret",
      document: { secret: "do not send me" },
      actor: stranger,
    });

    const sent = recorded.requests.at(-1)?.prompt ?? "";
    expect(sent).not.toContain("do not send me");
    await cms.close();
    await cmsWithSecretAction.close();
  });

  test("translate reads the source locale and writes the target one", async () => {
    const { cms, recorded } = await setup("Alles über Uploads");
    const created = await cms.api.posts.create({
      data: { title: "Everything about uploads" },
      locale: "en",
      actor: systemActor(),
    });

    const result = await cms.ai.run({
      collection: "posts",
      field: "title",
      action: "translate",
      id: created?.id as string,
      locale: "de",
      sourceLocale: "en",
      actor: editor,
    });

    expect(result.value).toBe("Alles über Uploads");
    const prompt = recorded.requests[0]?.prompt ?? "";
    expect(prompt).toContain("Everything about uploads");
    expect(prompt).toContain("Target language: de");
  });

  test("records every call as an event, cost included", async () => {
    const { cms, events } = await setup();
    await cms.ai.run({
      collection: "posts",
      field: "title",
      action: "generate",
      document: { notes: "x" },
      actor: editor,
    });
    await cms.drainEvents();

    const completed = events.find((event) => event.type === "ai.task.completed"); // prettier-ignore
    expect(completed?.data).toMatchObject({
      collection: "posts",
      field: "title",
      action: "generate",
      provider: "openai",
    });
    expect((completed?.data.usage as { total: number }).total).toBe(15);
  });

  test("records a failure as one too", async () => {
    const cause = new Error("the provider is down");
    const { cms, events } = await setup(() => {
      throw cause;
    });

    // A model that is down is an upstream failure, not a bug in the CMS: it
    // has to arrive as a 502 the panel can show, because the alternative is
    // the 500 path, which logs a stack and tells the editor "internal server
    // error" about somebody else's rate limit. `ai.complete` is ordinary
    // user code and throws ordinary errors, so the boundary is here.
    const failure = await cms.ai
      .run({
        collection: "posts",
        field: "title",
        action: "generate",
        document: {},
        actor: editor,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CmsError);
    expect(failure).toMatchObject({
      status: 502,
      code: "ai_provider_error",
      message: "the provider is down",
    });
    // The operator keeps the original stack; the response never carries it.
    expect((failure as CmsError).cause).toBe(cause);
    await cms.drainEvents();

    const failed = events.find((event) => event.type === "ai.task.failed");
    expect(failed?.data.error).toBe("the provider is down");
  });
});

describe("provider keys", () => {
  test("round-trip through AES-GCM and nothing else", async () => {
    const secret = "a-secret-long-enough";
    const stored = await encryptSecret("sk-live-1234", secret);
    expect(stored).not.toContain("sk-live");
    expect(await decryptSecret(stored, secret)).toBe("sk-live-1234");
    await expect(decryptSecret(stored, "a-different-secret!!")).rejects.toThrow(
      /could not be decrypted/,
    );
  });

  test("a key stored in the panel is used and never read back", async () => {
    const { cms, recorded } = await setup("done", {
      storage: { secret: "panel-secret-key-0001" },
    });

    await cms.ai.setCredential({ provider: "openai", token: "sk-from-panel" });

    const providers = await cms.ai.providers();
    const openai = providers.find((entry) => entry.provider === "openai");
    expect(openai?.source).toBe("database");
    expect(openai?.hint).toBe("…anel");
    expect(JSON.stringify(providers)).not.toContain("sk-from-panel");

    await cms.ai.run({
      collection: "posts",
      field: "title",
      action: "improve",
      document: { title: "something" },
      actor: editor,
    });
    // The stored key wins over the one in the configuration: it is the more
    // recent decision by whoever could see both.
    expect(recorded.requests.at(-1)?.auth).toEqual({
      type: "api-key",
      token: "sk-from-panel",
    });

    expect(await cms.ai.removeCredential({ provider: "openai" })).toBe(true);
    const after = await cms.ai.providers();
    expect(after.find((entry) => entry.provider === "openai")?.source).toBe(
      "config",
    );
  });

  test("refuses to store one without a secret to encrypt it with", async () => {
    const { cms } = await setup();
    await expect(
      cms.ai.setCredential({ provider: "openai", token: "sk" }),
    ).rejects.toThrow(/ai.storage.secret/);
  });
});

describe("the configuration", () => {
  test("validates aiGenerate context at startup, not on the first click", () => {
    const build = (context: string[]) => () =>
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        collections: {
          pages: defineCollection({
            fields: {
              title: text({}),
              slug: text({ aiGenerate: { context } }),
            },
          }),
        },
      });
    expect(build(["title"])).not.toThrow();
    expect(build(["missing"])).toThrow(/aiGenerate.context.*missing/);
    expect(build(["slug"])).toThrow(/aiGenerate.context.*slug/);
    expect(build(["title", "title"])).toThrow(/aiGenerate.context.*title/);
    expect(() => media({ aiGenerate: { prompt: "Generate a URL" } })).toThrow(
      /generation currently supports/,
    );
    expect(() => text({ aiGenerate: {}, ai: { generate: true } })).toThrow(
      /either aiGenerate/,
    );
  });

  test("refuses translate on a field that is not localized", () => {
    expect(() =>
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        ai: {
          auth: { openai: { type: "api-key", token: "sk" } },
          defaultModel: { provider: "openai", model: "gpt-4o-mini" },
        },
        collections: {
          pages: defineCollection({
            fields: { title: text({ ai: { translate: true } }) },
          }),
        },
      }),
    ).toThrow(CmsConfigError);
  });

  test("refuses an action that does not apply to the field type", () => {
    // The field type rejects an unknown key outright; this is the other
    // half, where the key *is* a registered action and the object looks
    // like a custom one. Only the registry knows it is neither.
    expect(() =>
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        ai: {
          auth: { openai: { type: "api-key", token: "sk" } },
          defaultModel: { provider: "openai", model: "gpt-4o-mini" },
        },
        collections: {
          pages: defineCollection({
            fields: { picture: media({ ai: { generate: { prompt: "Draw." } } }) }, // prettier-ignore
          }),
        },
      }),
    ).toThrow(/does not apply to a media field/);

    // And the field type's own list still catches the typo first.
    expect(() =>
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        collections: {
          pages: defineCollection({
            fields: { picture: media({ ai: { generat: true } }) },
          }),
        },
      }),
    ).toThrow(/unknown AI action/);
  });

  test("accepts a custom action key that brings its own prompt", () => {
    const cms = heyoCms({
      database: () => sqlite(new Database(":memory:")),
      ai: {
        auth: { openai: { type: "api-key", token: "sk" } },
        defaultModel: { provider: "openai", model: "gpt-4o-mini" },
      },
      collections: {
        pages: defineCollection({
          fields: {
            title: text({ ai: { "tone-of-voice": { prompt: "Make it warm." } } }), // prettier-ignore
          },
        }),
      },
    });
    expect(cms.inspect().ai.enabled).toBe(true);
  });

  test("allows no credentials at all when the panel manages them", () => {
    const cms = heyoCms({
      database: () => sqlite(new Database(":memory:")),
      ai: {
        defaultModel: { provider: "openai", model: "gpt-4o-mini" },
        storage: { secret: "panel-secret-key-0001" },
      },
      collections: { pages: defineCollection({ fields: { title: text({}) } }) },
    });
    expect(cms.inspect().ai.panelManagedKeys).toBe(true);
  });

  test("still refuses a default model whose provider has no key anywhere", () => {
    expect(() =>
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        ai: {
          auth: { openai: { type: "api-key", token: "sk" } },
          defaultModel: { provider: "anthropic", model: "claude-sonnet-4" },
        },
        collections: { pages: defineCollection({ fields: { title: text({}) } }) }, // prettier-ignore
      }),
    ).toThrow(/has no entry in ai.auth/);
  });
});

describe("over HTTP", () => {
  test("runs an action and reports the usage", async () => {
    const { cms } = await setup("From the route");
    const created = await cms.api.posts.create({
      data: { title: "Draft" },
      actor: systemActor(),
    });

    const response = await cms.handler(
      new Request(
        `http://localhost/api/heyo-cms/posts/${created?.id}/ai/title/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ document: { notes: "from the body" } }),
        },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { value: string; usage: { total: number } }; // prettier-ignore
    expect(body.value).toBe("From the route");
    expect(body.usage.total).toBe(15);
    await cms.close();
  });

  test("has no AI routes at all without an ai section", async () => {
    const adapter = sqlite(new Database(":memory:"));
    const cms = heyoCms({
      database: () => adapter,
      collections: collections(),
    });
    const paths = cms.inspect().routes.map((route) => route.path);
    expect(paths.some((path) => path.includes("/ai/"))).toBe(false);
    // The document chat is gone, not redirected. A route that 404s is the
    // honest answer; a route that 301s to the assistant would promise a
    // compatible replacement, and the replacement is not compatible.
    expect(paths.some((path) => path.endsWith("/chat"))).toBe(false);
    await cms.close();
  });

  test("lists providers without ever answering with a key", async () => {
    const { cms } = await setup();
    const response = await cms.handler(
      new Request("http://localhost/api/heyo-cms/ai/providers", {
        headers: { authorization: "Bearer nobody" },
      }),
    );
    // No session: an administrative endpoint needs one.
    expect(response.status).toBe(401);
    await cms.close();
  });
});
