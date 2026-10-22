import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { expandRoles, permits } from "../src/access/permissions";
import { defineCollection, defineGlobal, heyoCms, systemActor } from "../src/config"; // prettier-ignore
import { sqlite } from "../src/db/sqlite";
import { richTextToMarkdown } from "../src/editor/index";
import { media, richText, select, text } from "../src/fields";
import { memory } from "../src/storage/local";
import { emptySnapshot } from "../src/schema/snapshot";
import type { Actor } from "../src/types/actor";
import type { AiAssistantConfig } from "../src/types/config";
import type { AiAssistantEvent, AiPageContext } from "../src/types/ai";
import type { CmsEvent } from "../src/types/events";
import type { CmsInstance } from "../src/types/instance";
import type { JsonObject } from "../src/types/json";

/**
 * The panel-wide assistant.
 *
 * No provider is called anywhere in this file. The agent library is replaced
 * by a scripted double that invokes the tools the CMS registered, which is
 * exactly the right seam: everything this project is responsible for lives in
 * those tools and in the run loop around them — what the model may see, what
 * it may write, what it is refused, and what the panel is told happened.
 *
 * What a real model would decide is not our bug to test, and a test that
 * depended on it would fail for reasons nobody can fix.
 */

// ---------------------------------------------------------------------------
// The agent double
// ---------------------------------------------------------------------------

interface ScriptedCall {
  tool: string;
  args: JsonObject;
}

interface Script {
  calls: ScriptedCall[];
  reply?: string;
  /** Thrown from `prompt()`, the way a provider failure surfaces. */
  fail?: string;
  /** Runs until something aborts it, like a model that will not stop. */
  hang?: boolean;
}

let script: Script = { calls: [] };
/** What the double was constructed with, so a test can read the prompt. */
let constructed: { systemPrompt: string; tools: { name: string }[] } | null =
  null;
/** Tool failures, recorded the way the real loop reports them to the model. */
let toolErrors: { tool: string; message: string }[] = [];
/** Whether anything actually told the agent to stop. */
let aborted = false;
/** Agent runs still in flight. The number that has to be zero at the end. */
let running = 0;

class FakeAgent {
  state: {
    systemPrompt: string;
    model: unknown;
    tools: {
      name: string;
      label: string;
      execute: (
        id: string,
        args: unknown,
      ) => Promise<{ content: { type: string; text: string }[] }>;
    }[];
    messages: unknown[];
    errorMessage?: string;
  };

  private listeners: ((event: unknown) => void)[] = [];
  private aborted = false;

  constructor(options: { initialState: FakeAgent["state"] }) {
    this.state = options.initialState;
    constructed = {
      systemPrompt: this.state.systemPrompt,
      tools: this.state.tools,
    };
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => undefined;
  }

  abort(): void {
    this.aborted = true;
    aborted = true;
    this.onAbort?.();
  }

  private onAbort: (() => void) | undefined;

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(): Promise<void> {
    this.emit({ type: "turn_start" });
    if (script.fail) {
      this.state.errorMessage = script.fail;
      return;
    }
    if (script.hang) {
      running += 1;
      try {
        await new Promise<void>((resolve) => {
          if (this.aborted) {
            resolve();
            return;
          }
          this.onAbort = resolve;
        });
      } finally {
        running -= 1;
      }
      this.state.errorMessage = "aborted";
      return;
    }

    for (const [index, call] of script.calls.entries()) {
      if (this.aborted) return;
      const tool = this.state.tools.find((entry) => entry.name === call.tool);
      if (!tool) throw new Error(`the CMS registered no tool "${call.tool}"`);
      const id = `call_${index}`;
      this.emit({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: call.tool,
        args: call.args,
      });
      try {
        const result = await tool.execute(id, call.args);
        this.emit({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: call.tool,
          result,
          isError: false,
        });
      } catch (error) {
        // The real loop turns a thrown tool into an error result the model
        // reads and may recover from; it does not end the run.
        toolErrors.push({
          tool: call.tool,
          message: error instanceof Error ? error.message : String(error),
        });
        this.emit({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: call.tool,
          result: null,
          isError: true,
        });
      }
    }

    const message = {
      role: "assistant",
      content: [{ type: "text", text: script.reply ?? "Done." }],
      usage: {
        input: 100,
        output: 20,
        totalTokens: 120,
        cost: { total: 0.002 },
      },
    };
    this.emit({ type: "message_start", message });
    this.emit({ type: "message_end", message });
  }
}

mock.module("@mariozechner/pi-agent-core", () => ({ Agent: FakeAgent }));

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Spelled out rather than wildcarded, and that is the point of the fixture:
 * the editor may do everything ordinary and is missing exactly two grants —
 * `posts:publish` and `posts:secrets` — so "the assistant respects field
 * access" is testable without inventing a second access system for it.
 */
const roles = {
  admin: ["*"],
  editor: [
    "posts:read",
    "posts:create",
    "posts:update",
    "posts:delete",
    "settings:read",
    "settings:update",
    "ai:use",
    "activity:read",
  ],
  reader: ["*:read", "ai:use"],
  // Signed in, and allowed nothing to do with AI.
  outsider: ["posts:read"],
};

function actorWith(role: keyof typeof roles): Actor {
  return {
    id: `usr_${role}`,
    source: "session",
    roles: [role],
    permissions: expandRoles([role], roles),
  };
}

const collections = () => ({
  posts: defineCollection({
    fields: {
      title: text({ required: true, localized: true }),
      body: richText({ localized: true }),
      seoTitle: text({ localized: true }),
      status: select({
        options: ["draft", "published"],
        default: "draft",
        // Publishing is a permission, and the assistant has no way around it:
        // it writes through the same field-access check a form does.
        access: { update: ({ actor }) => permits(actor, "posts:publish") },
      }),
      internalNotes: text({
        access: { read: ({ actor }) => permits(actor, "posts:secrets") },
      }),
      cover: media({}),
    },
  }),
});

const globals = () => ({
  settings: defineGlobal({
    fields: { tagline: text({ localized: true }) },
  }),
});

/** Hook calls, so an AI write can be shown to go through the same pipeline. */
let hookCalls: string[] = [];

async function setup(
  assistant: Partial<AiAssistantConfig> = {},
  /** Media is off unless a test is about it: it changes the tool list. */
  withUploads = false,
): Promise<{
  cms: CmsInstance<ReturnType<typeof collections>, ReturnType<typeof globals>>;
  events: CmsEvent[];
}> {
  const adapter = sqlite(new Database(":memory:"));
  hookCalls = [];
  const cms = heyoCms({
    database: () => adapter,
    collections: collections(),
    globals: globals(),
    ...(withUploads ? { uploads: { storage: memory() } } : {}),
    databaseHooks: {
      posts: {
        update: {
          before: async ({ data }) => {
            hookCalls.push(`before:${Object.keys(data).join(",")}`);
            return undefined;
          },
          after: async () => {
            hookCalls.push("after");
          },
        },
      },
    },
    rbac: { roles },
    i18n: { locales: ["en", "pl"], defaultLocale: "en" },
    ai: {
      auth: { openai: { type: "api-key", token: "sk-test-value" } },
      defaultModel: { provider: "openai", model: "gpt-4o-mini" },
      assistant: { instructions: "Always answer in Polish.", ...assistant },
    },
  });
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_assistant"),
  );

  const events: CmsEvent[] = [];
  cms.on("*", (event) => {
    events.push(event);
  });
  return { cms, events };
}

/** Drains one run into an array, which is what every assertion here wants. */
async function run(
  cms: CmsInstance,
  args: Parameters<CmsInstance["ai"]["runAssistant"]>[0],
): Promise<AiAssistantEvent[]> {
  const collected: AiAssistantEvent[] = [];
  for await (const event of cms.ai.runAssistant(args)) collected.push(event);
  return collected;
}

/**
 * `get_current_page`, as the model would read it.
 *
 * Runs a real turn so the tools are built with the real context, then calls
 * the one tool under test and parses its text. Asserting on the payload
 * rather than on the event is the point: the event only says the tool ran,
 * and every bug in this area is in what it answered.
 */
async function currentPage(
  cms: CmsInstance,
  pageContext: AiPageContext,
): Promise<JsonObject> {
  script = { calls: [] };
  await run(cms, {
    message: "where am I",
    actor: actorWith("editor"),
    pageContext,
  });
  const tool = constructed?.tools.find(
    (entry) => entry.name === "get_current_page",
  ) as unknown as { execute: (id: string, args: unknown) => Promise<{ content: { text: string }[] }> }; // prettier-ignore
  return JSON.parse(
    (await tool.execute("t", {})).content[0]?.text ?? "{}",
  ) as JsonObject;
}

function eventsOfType<T extends AiAssistantEvent["type"]>(
  events: AiAssistantEvent[],
  type: T,
): Extract<AiAssistantEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<AiAssistantEvent, { type: T }> =>
      event.type === type,
  );
}

/** Polls a condition, so a timing assertion is not a sleep-and-hope. */
async function waitUntil(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("The condition never became true.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The wire format, read back the way the panel's parser reads it. */
function parseSse(body: string): AiAssistantEvent[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map(
      (frame) =>
        JSON.parse(
          frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join(""),
        ) as AiAssistantEvent,
    );
}

beforeEach(() => {
  script = { calls: [] };
  constructed = null;
  toolErrors = [];
  aborted = false;
  running = 0;
});

// ---------------------------------------------------------------------------

describe("orientation", () => {
  test("the schema the model sees is the live one, minus what the actor cannot read", async () => {
    const { cms } = await setup();
    script = { calls: [{ tool: "describe_cms", args: {} }] };

    const events = await run(cms, {
      message: "What is in this project?",
      actor: actorWith("editor"),
    });

    expect(eventsOfType(events, "done")).toHaveLength(1);
    const tool = constructed?.tools.find(
      (entry) => entry.name === "describe_cms",
    ) as unknown as { execute: (id: string, args: unknown) => Promise<{ content: { text: string }[] }> }; // prettier-ignore
    const described = JSON.parse(
      (await tool.execute("t", {})).content[0]?.text ?? "{}",
    ) as {
      collections: { name: string; fields: { name: string; writable: boolean }[] }[]; // prettier-ignore
      globals: { name: string }[];
      locales: string[];
    };

    const posts = described.collections.find((entry) => entry.name === "posts");
    expect(posts).toBeDefined();
    expect(described.globals.map((entry) => entry.name)).toEqual(["settings"]);
    expect(described.locales).toEqual(["en", "pl"]);

    // `internalNotes` needs `posts:secrets`, which this editor does not have.
    // It is absent entirely rather than present-and-forbidden: the *name* of
    // a field is the fact a read rule was written to withhold.
    expect(posts?.fields.map((field) => field.name)).not.toContain(
      "internalNotes",
    );
    // `status` needs `posts:publish`. The editor may read it, so it is
    // described — as not writable.
    expect(
      posts?.fields.find((field) => field.name === "status")?.writable,
    ).toBe(false);
    expect(
      posts?.fields.find((field) => field.name === "title")?.writable,
    ).toBe(true);
    await cms.close();
  });

  test("an admin sees the field an editor cannot", async () => {
    const { cms } = await setup();
    script = { calls: [{ tool: "describe_cms", args: {} }] };
    await run(cms, { message: "schema", actor: actorWith("admin") });

    const tool = constructed?.tools.find(
      (entry) => entry.name === "describe_cms",
    ) as unknown as { execute: (id: string, args: unknown) => Promise<{ content: { text: string }[] }> }; // prettier-ignore
    const described = (await tool.execute("t", {})).content[0]?.text ?? "";
    expect(described).toContain("internalNotes");
    await cms.close();
  });

  test('"this article" resolves through the page, not through a question', async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Uploads explained", body: null },
      actor: systemActor(),
    });

    script = { calls: [{ tool: "get_current_page", args: {} }] };
    const events = await run(cms, {
      message: "Summarise this article",
      actor: actorWith("editor"),
      pageContext: {
        kind: "document",
        collectionSlug: "posts",
        documentId: String(created?.id),
        locale: "en",
      },
    });

    expect(eventsOfType(events, "tool-end")[0]?.summary).toBe(
      "Read the current page",
    );
    expect(eventsOfType(events, "error")).toHaveLength(0);

    const page = await currentPage(cms, {
      kind: "document",
      collectionSlug: "posts",
      documentId: String(created?.id),
      locale: "en",
    });
    expect(page.documentId).toBe(String(created?.id));
    expect(String(page.record)).toContain("Uploads explained");
    await cms.close();
  });

  /**
   * The screens where "this" has no answer, and the ones where it has an
   * answer the panel already knows.
   *
   * Every one of these used to come back as the same four keys, which is the
   * shape a model reads as "there is a record here, you just did not get
   * it" — and the recovery it reaches for is a plausible id.
   */
  test("a list screen says there is no record here, and which collection", async () => {
    const { cms } = await setup();
    const page = await currentPage(cms, {
      kind: "collection-list",
      collectionSlug: "posts",
    });
    expect(page.collection).toBe("posts");
    expect(page.note).toContain("not at one record");
    expect(page.note).toContain("find_documents");
    expect(page.documentId).toBeUndefined();
    await cms.close();
  });

  test("a new document says nothing has been created yet", async () => {
    const { cms } = await setup();
    const page = await currentPage(cms, {
      kind: "document",
      collectionSlug: "posts",
    });
    expect(page.documentId).toBeNull();
    expect(page.note).toContain("has not been created yet");
    expect(page.note).toContain("Do not guess an id");
    await cms.close();
  });

  test("a note never overwrites another one that is also true", async () => {
    const { cms } = await setup();
    // A new form being typed into is both "nothing exists yet" and "there are
    // unsaved changes". Either sentence alone leads somewhere wrong: the
    // first invites a write, the second invites a search for an id.
    const page = await currentPage(cms, {
      kind: "document",
      collectionSlug: "posts",
      dirtyFields: ["title", "body"],
    });
    expect(page.unsavedFields).toEqual(["title", "body"]);
    expect(page.note).toContain("unsaved changes");
    expect(page.note).toContain("has not been created yet");
    await cms.close();
  });

  test("the open tab travels, so \u201cthis section\u201d has one answer", async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Two surfaces" },
      actor: systemActor(),
    });
    const page = await currentPage(cms, {
      kind: "document",
      collectionSlug: "posts",
      documentId: String(created?.id),
      tab: "body",
    });
    expect(page.tab).toBe("body");
    expect(constructed?.systemPrompt).toContain('on the "body" tab');
    await cms.close();
  });

  test("the file in the media details pane is re-read, not trusted", async () => {
    const { cms } = await setup({}, true);
    const file = await cms.media.upload({
      file: new Uint8Array([1, 2, 3]),
      filename: "cover.bin",
      contentType: "application/octet-stream",
      alt: { en: "A cover" },
      actor: systemActor(),
    });

    const page = await currentPage(cms, {
      kind: "media",
      mediaId: file.id,
      tab: "active",
    });
    expect(page.mediaId).toBe(file.id);
    expect(page.file).toMatchObject({ filename: "cover.bin" });
    expect(page.tab).toBe("active");

    // An id that no longer resolves is a sentence, not a crash: the pane may
    // have been showing a file somebody else deleted a second ago.
    const gone = await currentPage(cms, { kind: "media", mediaId: "med_nope" });
    expect(gone.note).toContain("no longer readable");

    // And with nothing selected, the honest answer is "ask which file".
    const empty = await currentPage(cms, { kind: "media" });
    expect(empty.note).toContain("no file selected");
    await cms.close();
  });

  test("searching media follows the visible orphaned tab, unless asked otherwise", async () => {
    const { cms } = await setup({}, true);
    const orphan = await cms.media.upload({
      file: new Uint8Array([1]),
      filename: "orphan.bin",
      actor: systemActor(),
    });
    const active = await cms.media.upload({
      file: new Uint8Array([2]),
      filename: "active.bin",
      actor: systemActor(),
    });
    const post = await cms.api.posts.create({
      data: { title: "Referenced", cover: orphan.id },
      actor: systemActor(),
    });
    await cms.api.posts.update({
      id: String(post?.id),
      data: { cover: null },
      actor: systemActor(),
    });
    expect((await cms.media.get(orphan.id))?.status).toBe("orphaned");

    await currentPage(cms, { kind: "media", tab: "orphaned" });
    const tool = constructed?.tools.find((entry) => entry.name === "find_media") as unknown as { execute: (id: string, args: unknown) => Promise<{ content: { text: string }[] }> }; // prettier-ignore
    const search = async (args: object) =>
      JSON.parse((await tool.execute("t", args)).content[0]?.text ?? "{}") as {
        status: string;
        results: { id: string }[];
      };
    const onTab = await search({});
    expect(onTab.status).toBe("orphaned");
    expect(onTab.results.map((file) => file.id)).toEqual([orphan.id]);
    const overridden = await search({ status: "active" });
    expect(overridden.results.map((file) => file.id)).toEqual([active.id]);
    await cms.close();
  });

  test("the assistant cannot write a file while its details form is dirty", async () => {
    const { cms } = await setup({}, true);
    const file = await cms.media.upload({
      file: new Uint8Array([1, 2, 3]),
      filename: "cover.bin",
      actor: systemActor(),
    });
    script = {
      calls: [
        {
          tool: "update_media",
          args: { id: file.id, filename: "changed.bin" },
        },
      ],
    };
    const events = await run(cms, {
      message: "rename this image",
      actor: actorWith("admin"),
      pageContext: {
        kind: "media",
        mediaId: file.id,
        dirtyFields: ["filename"],
      },
    });
    expect(toolErrors[0]?.message).toContain("unsaved changes");
    expect(eventsOfType(events, "mutation-applied")).toHaveLength(0);
    expect((await cms.media.get(file.id))?.filename).toBe("cover.bin");
    await cms.close();
  });

  test("a media screen in a deployment without uploads says so", async () => {
    const { cms } = await setup();
    const page = await currentPage(cms, { kind: "media", mediaId: "med_1" });
    expect(page.note).toContain("no uploads configured");
    await cms.close();
  });

  test("the language the caller is working in is used when no page says one", async () => {
    const { cms } = await setup();
    script = { calls: [{ tool: "get_current_page", args: {} }] };
    await run(cms, {
      message: "co tu jest",
      actor: actorWith("editor"),
      locale: "pl",
    });
    // `locale` used to be declared on the arguments and read by nothing, so a
    // caller with no page context silently got the project default.
    const tool = constructed?.tools.find(
      (entry) => entry.name === "get_current_page",
    ) as unknown as { execute: (id: string, args: unknown) => Promise<{ content: { text: string }[] }> }; // prettier-ignore
    const payload = JSON.parse(
      (await tool.execute("t", {})).content[0]?.text ?? "{}",
    ) as { locale: string };
    expect(payload.locale).toBe("pl");
    await cms.close();
  });
});

describe("choosing a record", () => {
  test("a search hands back candidates, and no tool in that path can write", async () => {
    const { cms } = await setup();
    await cms.api.posts.create({
      data: { title: "Uploads, part one" },
      actor: systemActor(),
    });
    await cms.api.posts.create({
      data: { title: "Uploads, part two" },
      actor: systemActor(),
    });

    script = {
      calls: [
        {
          tool: "find_documents",
          args: { collection: "posts", query: "Uploads" },
        },
      ],
      reply: "Dwa artykuły pasują. Który z nich?",
    };
    const streamed = await run(cms, {
      message: "popraw SEO artykułu o uploadach",
      actor: actorWith("editor"),
    });

    // Two candidates and nothing written. The agent cannot pick the first by
    // accident, because finding and writing are different tools and the
    // finding one has no write path at all.
    expect(eventsOfType(streamed, "mutation-applied")).toHaveLength(0);
    const first = await cms.api.posts.find({ actor: systemActor() });
    expect(first.docs.every((document) => !document.seoTitle)).toBe(true);
    await cms.close();
  });

  test("a search returns ids and a gist, never the full record", async () => {
    const { cms } = await setup();
    await cms.api.posts.create({
      data: {
        title: "Short title",
        internalNotes: "a secret that must not travel",
      },
      actor: systemActor(),
    });

    script = { calls: [] };
    await run(cms, { message: "x", actor: actorWith("editor") });
    const tool = constructed?.tools.find(
      (entry) => entry.name === "find_documents",
    ) as unknown as { execute: (id: string, args: unknown) => Promise<{ content: { text: string }[] }> }; // prettier-ignore

    const result =
      (await tool.execute("t", { collection: "posts" })).content[0]?.text ?? "";
    expect(result).toContain("Short title");
    // The full record is `get_document`'s job, after the agent has decided
    // which one it wants. A list that carried every field would pay for the
    // whole collection in tokens, and would leak a field this actor cannot
    // read into the bargain.
    expect(result).not.toContain("a secret that must not travel");
    await cms.close();
  });
});

describe("writing", () => {
  test("saves through the ordinary write path: hooks, events, activity, source ai", async () => {
    const { cms, events } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Before" },
      actor: systemActor(),
    });
    const id = String(created?.id);
    const actor = actorWith("editor");

    script = {
      calls: [
        {
          tool: "update_document",
          args: {
            collection: "posts",
            id,
            expectedRevision: 1,
            locale: "en",
            data: { title: "After", seoTitle: "After — a guide" },
          },
        },
      ],
      reply: "Zapisano.",
    };

    const streamed = await run(cms, {
      message: "Popraw SEO tego artykułu",
      actor,
      pageContext: {
        kind: "document",
        collectionSlug: "posts",
        documentId: id,
      },
    });

    const applied = eventsOfType(streamed, "mutation-applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]?.fields.sort()).toEqual(["seoTitle", "title"]);
    expect(applied[0]?.target).toMatchObject({
      kind: "document",
      collection: "posts",
      id,
      revision: 2,
    });

    const stored = await cms.api.posts.findById(id, { actor: systemActor() });
    expect(stored?.title).toBe("After");
    expect(stored?.revision).toBe(2);

    // The ordinary document event fired, so every existing subscriber hears
    // an AI write the way it hears any other.
    await cms.drainEvents();
    expect(events.map((event) => event.type)).toContain("document.updated");
    expect(events.map((event) => event.type)).toContain(
      "ai.agent.mutation.applied",
    );
    expect(events.map((event) => event.type)).toContain("ai.agent.completed");

    // The audit trail names the human and the machine separately.
    const trail = await cms.activity.list({ documentId: id });
    const entry = trail.entries.find(
      (line) => line.action === "document.updated",
    );
    expect(entry?.actorId).toBe(actor.id);
    expect(entry?.source).toBe("ai");
    expect(typeof entry?.changes?.runId).toBe("string");
    await cms.close();
  });

  test("an agent write runs the collection's hooks, like any other write", async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Hooked" },
      actor: systemActor(),
    });
    hookCalls = [];

    script = {
      calls: [
        {
          tool: "update_document",
          args: {
            collection: "posts",
            id: String(created?.id),
            expectedRevision: 1,
            data: { seoTitle: "Hooked — a guide" },
          },
        },
      ],
    };
    await run(cms, { message: "seo", actor: actorWith("editor") });

    // The hooks are the whole argument for routing a tool through `cms.api`
    // rather than through the adapter: a deployment that validates, slugifies
    // or notifies on update must do all three for an agent write too.
    expect(hookCalls).toEqual(["before:seoTitle", "after"]);
    await cms.close();
  });

  test("rich text arrives as Markdown and is stored as a document", async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Body" },
      actor: systemActor(),
    });
    const id = String(created?.id);

    script = {
      calls: [
        {
          tool: "update_document",
          args: {
            collection: "posts",
            id,
            expectedRevision: 1,
            data: { body: "## Heading\n\nA paragraph." },
          },
        },
      ],
    };
    await run(cms, { message: "write the body", actor: actorWith("editor") });

    const stored = await cms.api.posts.findById(id, { actor: systemActor() });
    expect((stored?.body as { type: string }).type).toBe("doc");
    expect(richTextToMarkdown(stored?.body as never)).toContain("## Heading");
    await cms.close();
  });

  test("a stale revision is a conflict, not an overwrite", async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "First" },
      actor: systemActor(),
    });
    const id = String(created?.id);
    // Somebody else saves between the agent's read and its write.
    await cms.api.posts.update({
      id,
      data: { title: "Somebody else" },
      actor: systemActor(),
    });

    script = {
      calls: [
        {
          tool: "update_document",
          args: {
            collection: "posts",
            id,
            expectedRevision: 1,
            data: { title: "The agent's version" },
          },
        },
      ],
    };
    await run(cms, { message: "rename it", actor: actorWith("editor") });

    expect(toolErrors[0]?.message).toMatch(/changed since you read it/);
    const stored = await cms.api.posts.findById(id, { actor: systemActor() });
    expect(stored?.title).toBe("Somebody else");
    await cms.close();
  });

  test("a dirty form is never written underneath the editor", async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Open in a tab" },
      actor: systemActor(),
    });
    const id = String(created?.id);

    script = {
      calls: [
        {
          tool: "update_document",
          args: {
            collection: "posts",
            id,
            expectedRevision: 1,
            data: { title: "From the agent" },
          },
        },
      ],
    };
    const streamed = await run(cms, {
      message: "change the title",
      actor: actorWith("editor"),
      pageContext: {
        kind: "document",
        collectionSlug: "posts",
        documentId: id,
        dirtyFields: ["title"],
        baselineRevision: 1,
      },
    });

    expect(toolErrors[0]?.message).toMatch(/unsaved changes/);
    expect(eventsOfType(streamed, "mutation-applied")).toHaveLength(0);
    const stored = await cms.api.posts.findById(id, { actor: systemActor() });
    expect(stored?.title).toBe("Open in a tab");
    await cms.close();
  });

  test("a field the actor may not write is refused, whatever the model asked for", async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Draft" },
      actor: systemActor(),
    });
    const id = String(created?.id);

    script = {
      calls: [
        {
          tool: "update_document",
          args: {
            collection: "posts",
            id,
            expectedRevision: 1,
            data: { status: "published" },
          },
        },
      ],
    };
    await run(cms, { message: "publish it", actor: actorWith("editor") });

    expect(toolErrors[0]?.message).toMatch(/may not write posts.status/);
    const stored = await cms.api.posts.findById(id, { actor: systemActor() });
    expect(stored?.status).toBe("draft");
    await cms.close();
  });

  test("a field the actor may not read is refused as if it did not exist", async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Draft" },
      actor: systemActor(),
    });

    script = {
      calls: [
        {
          tool: "update_document",
          args: {
            collection: "posts",
            id: String(created?.id),
            expectedRevision: 1,
            data: { internalNotes: "guessed the name" },
          },
        },
      ],
    };
    await run(cms, { message: "note something", actor: actorWith("editor") });

    // Identical to the message for a field that genuinely does not exist. A
    // "you may not write it" would confirm the guess.
    expect(toolErrors[0]?.message).toMatch(/is not a field of posts/);
    await cms.close();
  });

  test("an invented field is refused with the way to find the real ones", async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Draft" },
      actor: systemActor(),
    });

    script = {
      calls: [
        {
          tool: "update_document",
          args: {
            collection: "posts",
            id: String(created?.id),
            expectedRevision: 1,
            data: { metaDescription: "invented" },
          },
        },
      ],
    };
    await run(cms, { message: "seo", actor: actorWith("editor") });
    expect(toolErrors[0]?.message).toMatch(/describe_cms/);
    await cms.close();
  });

  test("a global is written with the same precondition as a document", async () => {
    const { cms } = await setup();
    script = {
      calls: [
        {
          tool: "update_global",
          args: {
            global: "settings",
            expectedRevision: 1,
            locale: "pl",
            data: { tagline: "Nowy tagline" },
          },
        },
      ],
    };
    const streamed = await run(cms, {
      message: "zmień tagline",
      actor: actorWith("editor"),
    });

    expect(eventsOfType(streamed, "mutation-applied")[0]?.target.kind).toBe(
      "global",
    );
    const stored = await cms.globals.settings.get({
      actor: systemActor(),
      locale: "pl",
    });
    expect(stored.tagline).toBe("Nowy tagline");
    await cms.close();
  });
});

describe("approval", () => {
  test("creating does not write; it parks a plan and says so", async () => {
    const { cms } = await setup();
    script = {
      calls: [
        {
          tool: "create_document",
          args: { collection: "posts", data: { title: "A new post" } },
        },
      ],
    };

    const streamed = await run(cms, {
      message: "write a post about uploads",
      actor: actorWith("editor"),
    });

    const required = eventsOfType(streamed, "approval-required");
    expect(required).toHaveLength(1);
    expect(required[0]?.plan.operations[0]).toMatchObject({
      action: "create",
      fields: ["title"],
    });
    expect(eventsOfType(streamed, "mutation-applied")).toHaveLength(0);
    expect(await cms.api.posts.count({ actor: systemActor() })).toBe(0);

    // The plan summary carries names, never the proposed values.
    expect(JSON.stringify(required[0]?.plan)).not.toContain("A new post");
    await cms.close();
  });

  test("approving replays exactly what was stored, without the model", async () => {
    const { cms } = await setup();
    const actor = actorWith("editor");
    script = {
      calls: [
        {
          tool: "create_document",
          args: { collection: "posts", data: { title: "Approved post" } },
        },
      ],
    };
    const streamed = await run(cms, { message: "new post", actor });
    const plan = eventsOfType(streamed, "approval-required")[0]?.plan;

    const result = await cms.ai.approveAssistantPlan({
      planId: plan?.id as string,
      actor,
    });

    expect(result.applied).toHaveLength(1);
    expect(result.runId).toBe(plan?.runId as string);
    const page = await cms.api.posts.find({ actor: systemActor() });
    expect(page.docs[0]?.title).toBe("Approved post");
    await cms.close();
  });

  test("a plan belongs to the person it was shown to", async () => {
    const { cms } = await setup();
    script = {
      calls: [
        {
          tool: "create_document",
          args: { collection: "posts", data: { title: "Mine" } },
        },
      ],
    };
    const streamed = await run(cms, {
      message: "new post",
      actor: actorWith("editor"),
    });
    const plan = eventsOfType(streamed, "approval-required")[0]?.plan;

    // Reads as missing rather than forbidden: "that plan exists but is not
    // yours" is information about somebody else's session.
    await expect(
      cms.ai.approveAssistantPlan({
        planId: plan?.id as string,
        actor: actorWith("reader"),
      }),
    ).rejects.toThrow(/no longer exists/);
    await cms.close();
  });

  test("approving twice applies once", async () => {
    const { cms } = await setup();
    const actor = actorWith("editor");
    script = {
      calls: [
        {
          tool: "create_document",
          args: { collection: "posts", data: { title: "Only once" } },
        },
      ],
    };
    const streamed = await run(cms, { message: "new post", actor });
    const planId = eventsOfType(streamed, "approval-required")[0]?.plan
      .id as string;

    await cms.ai.approveAssistantPlan({ planId, actor });
    await expect(
      cms.ai.approveAssistantPlan({ planId, actor }),
    ).rejects.toThrow(/already been applied/);
    expect(await cms.api.posts.count({ actor: systemActor() })).toBe(1);
    await cms.close();
  });

  test("more than one record always needs approval", async () => {
    const { cms } = await setup();
    const first = await cms.api.posts.create({
      data: { title: "One" },
      actor: systemActor(),
    });
    const second = await cms.api.posts.create({
      data: { title: "Two" },
      actor: systemActor(),
    });

    script = {
      calls: [
        {
          tool: "create_mutation_plan",
          args: {
            summary: "Retag two posts",
            changes: [
              {
                collection: "posts",
                id: String(first?.id),
                expectedRevision: 1,
                data: { seoTitle: "One — guide" },
              },
              {
                collection: "posts",
                id: String(second?.id),
                expectedRevision: 1,
                data: { seoTitle: "Two — guide" },
              },
            ],
          },
        },
      ],
    };

    const streamed = await run(cms, {
      message: "retag both",
      actor: actorWith("editor"),
    });
    const plan = eventsOfType(streamed, "approval-required")[0]?.plan;
    expect(plan?.operations).toHaveLength(2);
    // The label is the title a human knows the record by, not an id.
    expect(plan?.operations.map((operation) => operation.label)).toEqual([
      "One",
      "Two",
    ]);
    expect(eventsOfType(streamed, "mutation-applied")).toHaveLength(0);
    await cms.close();
  });

  test("trashing is a plan, and it is refused outright without the permission", async () => {
    const { cms } = await setup();
    const created = await cms.api.posts.create({
      data: { title: "Keep me" },
      actor: systemActor(),
    });

    script = {
      calls: [
        {
          tool: "trash_document",
          args: { collection: "posts", id: String(created?.id) },
        },
      ],
    };
    const streamed = await run(cms, {
      message: "delete it",
      actor: actorWith("reader"),
    });

    // A reader cannot even read it for the plan's label, so the plan is never
    // created: a plan nobody can execute is a button that fails on click.
    expect(eventsOfType(streamed, "approval-required")).toHaveLength(0);
    const stored = await cms.api.posts.findById(String(created?.id), {
      actor: systemActor(),
    });
    expect(stored?.deletedAt).toBeNull();
    await cms.close();
  });
});

describe("limits and failures", () => {
  test("the audit trail needs activity:read, which the engine does not check", async () => {
    const { cms } = await setup();
    await cms.api.posts.create({
      data: { title: "Something happened" },
      actor: systemActor(),
    });

    script = {
      calls: [{ tool: "get_activity", args: { collection: "posts" } }],
    };
    // `cms.activity.list()` takes no actor, so this tool is the only thing
    // standing between a signed-in account and the whole audit trail. The
    // `reader` role is not the test: `*:read` genuinely grants
    // `activity:read`, which is the permission grammar working as specified.
    await run(cms, {
      message: "who changed what?",
      actor: actorWith("outsider"),
    });
    expect(toolErrors[0]?.message).toMatch(/activity:read/);

    toolErrors = [];
    await run(cms, { message: "who changed what?", actor: actorWith("editor") }); // prettier-ignore
    expect(toolErrors).toHaveLength(0);
    await cms.close();
  });

  test("the tool budget is the server's, not the model's", async () => {
    const { cms } = await setup();
    script = {
      calls: Array.from({ length: 20 }, () => ({
        tool: "describe_cms",
        args: {},
      })),
    };
    await run(cms, { message: "loop", actor: actorWith("editor") });

    expect(toolErrors.length).toBeGreaterThan(0);
    expect(toolErrors.at(-1)?.message).toMatch(/tool calls/);
    await cms.close();
  });

  test("the request's abort actually stops the agent", async () => {
    const { cms } = await setup();
    script = { calls: [], hang: true };

    const controller = new AbortController();
    // A client that closes the tab: the socket goes, and the run has to go
    // with it. A budget nothing enforces is a bill somebody still pays.
    setTimeout(() => controller.abort(), 20);

    const streamed = await run(cms, {
      message: "hello",
      actor: actorWith("editor"),
      signal: controller.signal,
    });

    expect(aborted).toBe(true);
    expect(eventsOfType(streamed, "error")[0]?.code).toBe("ai_aborted");
    await cms.close();
  });

  test("the configured timeout actually stops the agent", async () => {
    const { cms } = await setup({ timeoutMs: 1_000 });
    script = { calls: [], hang: true };

    const started = Date.now();
    const streamed = await run(cms, {
      message: "hello",
      actor: actorWith("editor"),
    });

    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(eventsOfType(streamed, "error")).toHaveLength(1);
    await cms.close();
  });

  test("a failed run reports a code and records the failure", async () => {
    const { cms, events } = await setup();
    script = { calls: [], fail: "the provider is down" };

    const streamed = await run(cms, {
      message: "hello",
      actor: actorWith("editor"),
    });
    const error = eventsOfType(streamed, "error")[0];
    expect(error?.message).toBe("the provider is down");
    expect(eventsOfType(streamed, "done")).toHaveLength(0);

    await cms.drainEvents();
    const failed = events.find((event) => event.type === "ai.agent.failed");
    expect(failed).toBeDefined();
    // Metadata only: no prompt, no answer, no record.
    expect(JSON.stringify(failed?.data)).not.toContain("hello");
    await cms.close();
  });

  test("the run reports usage and never the credentials", async () => {
    const { cms, events } = await setup();
    script = { calls: [], reply: "Gotowe." };
    const streamed = await run(cms, {
      message: "hi",
      actor: actorWith("editor"),
    });

    expect(eventsOfType(streamed, "done")[0]?.usage).toMatchObject({
      input: 100,
      output: 20,
      total: 120,
    });
    expect(eventsOfType(streamed, "text-delta")[0]?.text).toBe("Gotowe.");

    await cms.drainEvents();
    expect(JSON.stringify(events)).not.toContain("sk-test-value");
    await cms.close();
  });

  test("the system prompt carries the deployment's instructions and no data", async () => {
    const { cms } = await setup();
    await cms.api.posts.create({
      data: { title: "A secret headline nobody asked about" },
      actor: systemActor(),
    });
    script = { calls: [] };
    await run(cms, { message: "hello", actor: actorWith("editor") });

    expect(constructed?.systemPrompt).toContain("Always answer in Polish.");
    // The schema and the content arrive through tools, on demand. A prompt
    // that carried them would be paid for on every turn and stale by the
    // next deploy.
    expect(constructed?.systemPrompt).not.toContain("A secret headline");
    expect(constructed?.systemPrompt).not.toContain("seoTitle");
    await cms.close();
  });

  test("the tools offered are the bounded set, with nothing that reaches past the CMS", async () => {
    const { cms } = await setup();
    script = { calls: [] };
    await run(cms, { message: "hello", actor: actorWith("editor") });

    const names = (constructed?.tools ?? []).map((tool) => tool.name).sort();
    expect(names).toEqual([
      "create_document",
      "create_mutation_plan",
      "describe_cms",
      "find_documents",
      "get_activity",
      "get_current_page",
      "get_document",
      "get_global",
      "restore_document",
      "trash_document",
      "update_document",
      "update_global",
    ]);
    // The questions worth asking about an agent are "can it run SQL", "can it
    // fetch a URL", "can it read a file", "can it read a key". The answer has
    // to be structural, and this is where it is structural.
    for (const forbidden of [
      "sql",
      "query",
      "fetch",
      "http",
      "exec",
      "file",
      "credential",
      "secret",
    ]) {
      // prettier-ignore
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
    await cms.close();
  });
});

describe("over HTTP", () => {
  test("streams server-sent events and needs ai:use", async () => {
    const { cms } = await setup();
    const actor = actorWith("editor");
    const created = await cms.api.posts.create({
      data: { title: "Streamed" },
      actor: systemActor(),
    });

    script = {
      calls: [
        {
          tool: "update_document",
          args: {
            collection: "posts",
            id: String(created?.id),
            expectedRevision: 1,
            data: { seoTitle: "Streamed — a guide" },
          },
        },
      ],
      reply: "Zapisano.",
    };

    // Through the real handler, with a real session, reading the real stream.
    (
      cms.auth as unknown as { actorFromRequest: () => Promise<Actor | null> }
    ).actorFromRequest = async () => actor;

    const response = await cms.handler(
      new Request("http://localhost/api/heyo-cms/ai/assistant", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-heyo-cms-client": "admin",
        },
        body: JSON.stringify({
          message: "popraw seo",
          pageContext: {
            kind: "document",
            collectionSlug: "posts",
            documentId: String(created?.id),
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform"); // prettier-ignore

    const frames = parseSse(await response.text());
    expect(frames.map((frame) => frame.type)).toContain("mutation-applied");
    expect(frames.map((frame) => frame.type)).toContain("done");
    const applied = frames.find(
      (frame) => frame.type === "mutation-applied",
    ) as Extract<AiAssistantEvent, { type: "mutation-applied" }>;
    expect(applied.fields).toEqual(["seoTitle"]);

    const stored = await cms.api.posts.findById(String(created?.id), {
      actor: systemActor(),
    });
    expect(stored?.seoTitle).toBe("Streamed — a guide");

    // Anonymous callers get nothing: `ai:use` is a cost control and the
    // tools check the actor again for every record.
    const ask = (as: Actor | null) => {
      (
        cms.auth as unknown as { actorFromRequest: () => Promise<Actor | null> }
      ).actorFromRequest = async () => as;
      return cms.handler(
        new Request("http://localhost/api/heyo-cms/ai/assistant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "hello" }),
        }),
      );
    };

    expect((await ask(null)).status).toBe(401);
    // Signed in, but without `ai:use`: the cost of a run is a grant somebody
    // has to make, separately from being allowed to read posts.
    expect((await ask(actorWith("outsider"))).status).toBe(403);

    const allowed = await ask(actorWith("editor"));
    expect(allowed.status).toBe(200);
    // Drained rather than discarded: the stream starts as soon as the
    // response is constructed, so abandoning it would leave a run writing to
    // a database this test is about to close.
    await allowed.text();
    await cms.close();
  });

  test("a client that walks away does not leave a run going", async () => {
    const { cms } = await setup();
    const actor = actorWith("editor");
    (
      cms.auth as unknown as { actorFromRequest: () => Promise<Actor | null> }
    ).actorFromRequest = async () => actor;
    script = { calls: [], hang: true };

    const request = new Request("http://localhost/api/heyo-cms/ai/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    const response = await cms.handler(request);
    expect(response.status).toBe(200);

    // Long enough for the run to have resolved its model and started the
    // agent, so this is the interesting case rather than the trivial one.
    await waitUntil(() => running === 1);

    // Cancelling the body is what a runtime does when the socket goes. The
    // run has to notice: an agent nobody is listening to still costs money.
    await response.body?.cancel();

    await waitUntil(() => running === 0);
    expect(aborted).toBe(true);
    await cms.close();
  });

  test("the routes exist only when the assistant does", async () => {
    const { cms } = await setup();
    const paths = cms.inspect().routes.map((route) => route.path);
    expect(paths.some((path) => path.endsWith("/ai/assistant"))).toBe(true);
    expect(cms.inspect().ai.assistant).toBe(true);
    await cms.close();

    const adapter = sqlite(new Database(":memory:"));
    const off = heyoCms({
      database: () => adapter,
      collections: collections(),
      ai: {
        auth: { openai: { type: "api-key", token: "sk" } },
        defaultModel: { provider: "openai", model: "gpt-4o-mini" },
        assistant: { enabled: false },
      },
    });
    const offPaths = off.inspect().routes.map((route) => route.path);
    expect(offPaths.some((path) => path.endsWith("/ai/assistant"))).toBe(false);
    expect(off.inspect().ai.assistant).toBe(false);
    await off.close();
  });
});
