import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";

import { defineCollection, heyoCms, systemActor } from "../src/config";
import { mongodb } from "../src/db/mongodb";
import { postgres, type PostgresClient } from "../src/db/postgres";
import { sqlite } from "../src/db/sqlite";
import { CmsError } from "../src/errors";
import { list, multiselect, number, relation, select, text, url } from "../src/fields"; // prettier-ignore
import { and, eq, gte, orderBy } from "../src/query";
import { emptySnapshot } from "../src/schema/snapshot";
import type { Actor } from "../src/types/actor";
import type { HeyoCmsConfig } from "../src/types/config";
import type { DatabaseAdapter } from "../src/types/database";
import type { CmsEvent } from "../src/types/events";
import type { CmsInstance } from "../src/types/instance";
import type { JsonObject } from "../src/types/json";
import type {
  Mutation,
  MutationResult,
  Query,
  Row,
  Tx,
} from "../src/types/query";
import type { MigrationArtifact, SchemaSnapshot } from "../src/types/schema";
import { memoryMongo } from "./mongo-memory";

/**
 * The engine, on every engine.
 *
 * Stage 3 is where "no SQL leaves the adapter" stops being a claim and starts
 * being testable: the same hooks, the same outbox, the same cursor and the
 * same `depth` run against Postgres, SQLite and MongoDB without a single
 * branch in the engine. The two places a difference is allowed —
 * `capabilities.transactions` and the compensating outbox path — are asserted
 * explicitly rather than skipped.
 */

const collections = () => ({
  teams: defineCollection({
    fields: { name: text({ required: true }) },
  }),
  authors: defineCollection({
    fields: {
      name: text({ required: true }),
      team: relation("teams"),
    },
  }),
  posts: defineCollection({
    fields: {
      title: text({ required: true, localized: true }),
      sources: list({
        localized: true,
        fields: { title: text({ required: true }), url: url() },
      }),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
      status: select({ options: ["draft", "published"], default: "draft" }),
      views: number({ integer: true }),
      tags: multiselect({ options: ["news", "guide"] }),
      author: relation("authors"),
    },
  }),
});

type Fixture = ReturnType<typeof collections>;

interface EngineUnderTest {
  name: string;
  create(): Promise<DatabaseAdapter> | DatabaseAdapter;
}

/** Counts reads so the absence of N+1 is asserted, not assumed. */
class CountingAdapter implements DatabaseAdapter {
  queries = 0;

  constructor(private readonly inner: DatabaseAdapter) {}

  get id(): string {
    return this.inner.id;
  }
  get capabilities(): DatabaseAdapter["capabilities"] {
    return this.inner.capabilities;
  }
  useSchema(schema: SchemaSnapshot): void {
    this.inner.useSchema(schema);
  }
  introspect(): Promise<SchemaSnapshot> {
    return this.inner.introspect();
  }
  plan(from: SchemaSnapshot, to: SchemaSnapshot) {
    return this.inner.plan(from, to);
  }
  render(steps: ReturnType<DatabaseAdapter["plan"]>, id: string) {
    return this.inner.render(steps, id);
  }
  applyMigration(artifact: MigrationArtifact): Promise<void> {
    return this.inner.applyMigration(artifact);
  }
  listAppliedMigrations() {
    return this.inner.listAppliedMigrations();
  }
  recordMigration(id: string, checksum: string): Promise<void> {
    return this.inner.recordMigration(id, checksum);
  }
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.inner.transaction(fn);
  }
  query(tx: Tx, query: Query): Promise<Row[]> {
    this.queries += 1;
    return this.inner.query(tx, query);
  }
  mutate(tx: Tx, mutation: Mutation): Promise<MutationResult> {
    return this.inner.mutate(tx, mutation);
  }
  async close(): Promise<void> {
    await this.inner.close?.();
  }
}

/**
 * Typed against the fixture, not against `CollectionsConfig`.
 *
 * `databaseHooks` is generic in the collections, so a loose override type
 * would give `heyoCms()` a second inference site and widen `cms.api` back to
 * an untyped record — which would quietly stop this suite from testing the
 * inference at all.
 */
type Overrides = Partial<
  Omit<HeyoCmsConfig<Fixture>, "database" | "collections">
>;

function runEngineSuite(entry: EngineUnderTest): void {
  describe(`engine: ${entry.name}`, () => {
    /**
     * Builds a CMS on a fresh database.
     *
     * The migration runs the way a project's does — plan from nothing,
     * render, apply — so the engine is exercised against a schema the CLI
     * could have produced, not one a test invented.
     */
    const setup = async (
      overrides: Overrides = {},
    ): Promise<{
      cms: CmsInstance<Fixture>;
      adapter: CountingAdapter;
      events: CmsEvent[];
    }> => {
      const adapter = new CountingAdapter(await entry.create());
      const cms = heyoCms({
        ...overrides,
        database: () => adapter,
        collections: collections(),
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(
          adapter.plan(emptySnapshot(), cms.schema),
          "0000_engine",
        ),
      );

      const events: CmsEvent[] = [];
      cms.on("*", (event) => {
        events.push(event);
      });
      return { cms, adapter, events };
    };

    const actor: Actor = systemActor("usr_test");

    // -----------------------------------------------------------------------
    // CRUD
    // -----------------------------------------------------------------------

    test("creates, reads back and stamps the system fields", async () => {
      const { cms } = await setup();

      const post = await cms.api.posts.create({
        data: { title: "Hello", handle: "hello" },
        actor,
      });

      expect(post).not.toBeNull();
      expect(post?.title).toBe("Hello");
      // The declared default of a `select` is applied on create, so a
      // document never comes back missing a field the schema promises.
      expect(post?.status).toBe("draft");
      expect(post?.views).toBeNull();
      expect(String(post?.id)).toStartWith("doc_");
      expect(post?.updatedBy).toBe("usr_test");
      expect(post?.deletedAt).toBeNull();
      expect(typeof post?.createdAt).toBe("string");

      const found = await cms.api.posts.findById(String(post?.id));
      expect(found?.title).toBe("Hello");
      await cms.close();
    });

    test("updates only what the patch names and reports the change", async () => {
      const { cms } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Draft", handle: "draft", views: 1 },
      });

      const updated = await cms.api.posts.update({
        id: String(post?.id),
        data: { status: "published" },
      });

      expect(updated?.status).toBe("published");
      expect(updated?.title).toBe("Draft");
      expect(updated?.views).toBe(1);
      await cms.close();
    });

    test("deletes a document and stops finding it", async () => {
      const { cms } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Gone", handle: "gone" },
      });

      const removed = await cms.api.posts.delete({ id: String(post?.id) });
      expect(removed?.title).toBe("Gone");
      expect(await cms.api.posts.findById(String(post?.id))).toBeNull();
      expect(await cms.api.posts.count()).toBe(0);
      await cms.close();
    });

    test("filters, sorts and counts through the AST", async () => {
      const { cms } = await setup();
      const statuses = ["draft", "published", "published"] as const;
      for (const [index, status] of statuses.entries()) {
        // prettier-ignore
        await cms.api.posts.create({
          data: { title: `Post ${index}`, handle: `post-${index}`, status, views: index },
        });
      }

      const published = await cms.api.posts.find({
        where: and(eq("status", "published"), gte("views", 1)),
        orderBy: [orderBy("views", "desc")],
        count: true,
      });

      expect(published.docs.map((doc) => doc.views)).toEqual([2, 1]);
      expect(published.totalDocs).toBe(2);
      expect(published.hasNextPage).toBe(false);
      expect(await cms.api.posts.count()).toBe(3);
      await cms.close();
    });

    test("rejects a missing required field and an unknown one", async () => {
      const { cms } = await setup();

      await expect(
        cms.api.posts.create({ data: { handle: "no-title" } }),
      ).rejects.toThrow(/title is required/);

      await expect(
        cms.api.posts.create({
          data: { title: "x", nope: 1 } as unknown as JsonObject,
        }),
      ).rejects.toThrow(/has no field "nope"/);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Pagination
    // -----------------------------------------------------------------------

    test("pages with a cursor without repeating or skipping a row", async () => {
      const { cms } = await setup();
      for (let index = 0; index < 5; index += 1) {
        await cms.api.posts.create({
          data: { title: `Post ${index}`, handle: `p-${index}`, views: index },
        });
      }

      const seen: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 3; page += 1) {
        const result: Awaited<ReturnType<typeof cms.api.posts.find>> =
          await cms.api.posts.find({
            orderBy: [orderBy("views", "asc")],
            limit: 2,
            ...(cursor === null ? {} : { cursor }),
          });
        seen.push(...result.docs.map((doc) => Number(doc.views)));
        cursor = result.cursor;
        if (!result.hasNextPage) break;
      }

      expect(seen).toEqual([0, 1, 2, 3, 4]);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // depth
    // -----------------------------------------------------------------------

    test("resolves depth 2 in a constant number of queries", async () => {
      const { cms, adapter } = await setup();

      const team = await cms.api.teams.create({ data: { name: "Core" } });
      for (let index = 0; index < 5; index += 1) {
        const author = await cms.api.authors.create({
          data: { name: `Author ${index}`, team: String(team?.id) },
        });
        await cms.api.posts.create({
          data: {
            title: `Post ${index}`,
            handle: `post-${index}`,
            author: String(author?.id),
          },
        });
      }

      // Settles the outbox first: a background delivery reads the `outbox`
      // table, and counting it here would measure the wrong thing.
      await cms.drainEvents();

      const before = adapter.queries;
      const page = await cms.api.posts.find({ depth: 2, limit: 10 });
      const spent = adapter.queries - before;

      // Typed as an id, resolved into a document: `depth` is a read-time
      // decision, so the static type stays the stored shape.
      const author = page.docs[0]?.author as unknown as JsonObject;
      expect(author?.name).toStartWith("Author ");
      expect((author?.team as JsonObject)?.name).toBe("Core");
      // One for the posts, one for all five authors, one for the team. Five
      // posts would cost eleven queries with a naive loader.
      expect(spent).toBe(3);
      await cms.close();
    });

    test("leaves a reference alone when depth is not asked for", async () => {
      const { cms } = await setup();
      const team = await cms.api.teams.create({ data: { name: "Core" } });
      const author = await cms.api.authors.create({
        data: { name: "A", team: String(team?.id) },
      });

      const plain = await cms.api.authors.findById(String(author?.id));
      expect(plain?.team).toBe(String(team?.id));
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // i18n
    // -----------------------------------------------------------------------

    test("a list keeps its rows, in order, per language", async () => {
      const { cms } = await setup({
        i18n: { locales: ["en", "de"], defaultLocale: "en" },
      });
      const english = [
        { title: "Second source", url: "https://b.example" },
        { title: "First source" },
      ];
      const post = await cms.api.posts.create({
        data: { title: "Cited", handle: "cited", sources: english },
        locale: "en",
      });
      expect(post?.sources).toEqual(english);

      const german = [{ title: "Quelle", url: null }];
      await cms.api.posts.update({
        id: String(post?.id),
        data: { sources: german },
        locale: "de",
      });
      const de = await cms.api.posts.findById(String(post?.id), { locale: "de" }); // prettier-ignore
      expect(de?.sources).toEqual(german);
      const en = await cms.api.posts.findById(String(post?.id), { locale: "en" }); // prettier-ignore
      expect(en?.sources).toEqual(english);

      // A bad row is refused, and the message says which one and why.
      const refused = await cms.api.posts
        .update({
          id: String(post?.id),
          data: {
            sources: [{ title: "Fine" }, { url: "https://c.example" }] as never,
          },
          locale: "en",
        })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(CmsError);
      expect((refused as CmsError).message).toContain(
        "sources #2 title: is required",
      );
      const unchanged = await cms.api.posts.findById(String(post?.id), { locale: "en" }); // prettier-ignore
      expect(unchanged?.sources).toEqual(english);
      await cms.close();
    });

    test("resolves one locale per read and marks a fallback", async () => {
      const { cms } = await setup({
        i18n: { locales: ["en", "de", "fr"], defaultLocale: "en" },
      });

      const post = await cms.api.posts.create({
        data: { title: "Hello", handle: "hello" },
        locale: "en",
      });
      await cms.api.posts.update({
        id: String(post?.id),
        data: { title: "Hallo" },
        locale: "de",
      });

      const german = await cms.api.posts.findById(String(post?.id), { locale: "de" }); // prettier-ignore
      expect(german?.title).toBe("Hallo");
      // Writing one locale must not disturb another.
      const english = await cms.api.posts.findById(String(post?.id), { locale: "en" }); // prettier-ignore
      expect(english?.title).toBe("Hello");

      const french = await cms.api.posts.findById(String(post?.id), { locale: "fr" }); // prettier-ignore
      expect(french?.title).toBe("Hello");
      expect(french?._fallback).toEqual({ title: "en" });

      // `fallbackLocale: false` is how a panel sees the gaps instead of the
      // substitutions.
      const raw = await cms.api.posts.findById(String(post?.id), {
        locale: "fr",
        fallbackLocale: false,
      });
      expect(raw?.title).toBeNull();
      expect(raw?._fallback).toBeUndefined();
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Hooks
    // -----------------------------------------------------------------------

    test("runs before hooks ahead of validation, so one can fill a field", async () => {
      const { cms } = await setup({
        databaseHooks: {
          posts: {
            create: {
              before: ({ data }) => ({
                data: {
                  ...data,
                  handle: String(data.title).toLowerCase().replaceAll(" ", "-"),
                },
              }),
            },
          },
        },
      });

      const post = await cms.api.posts.create({ data: { title: "Hello There" } }); // prettier-ignore
      expect(post?.handle).toBe("hello-there");
      await cms.close();
    });

    test("a before hook that returns false stops the write silently", async () => {
      const { cms } = await setup({
        databaseHooks: { posts: { create: { before: () => false } } },
      });

      expect(await cms.api.posts.create({ data: { title: "No" } })).toBeNull();
      expect(await cms.api.posts.count()).toBe(0);
      await cms.close();
    });

    test("a before hook that throws stops the write with its status", async () => {
      const { cms } = await setup({
        databaseHooks: {
          posts: {
            update: {
              before: () => {
                throw CmsError.forbidden("not yours");
              },
            },
          },
        },
      });

      const post = await cms.api.posts.create({
        data: { title: "T", handle: "t" },
      });
      await expect(
        cms.api.posts.update({ id: String(post?.id), data: { views: 1 } }),
      ).rejects.toThrow("not yours");
      await cms.close();
    });

    test("carries meta from a before hook to the after hook", async () => {
      const notes: unknown[] = [];
      const { cms } = await setup({
        databaseHooks: {
          posts: {
            create: {
              before: (_input, context) => {
                context.meta.note = "carried";
              },
              after: (_doc, context) => {
                notes.push(context.meta.note);
              },
            },
          },
        },
      });

      await cms.api.posts.create({ data: { title: "T", handle: "t" } });
      expect(notes).toEqual(["carried"]);
      await cms.close();
    });

    test("plugin hooks run before the configuration's own, and inspect says so", async () => {
      const order: string[] = [];
      const { cms } = await setup({
        plugins: [
          {
            id: "late-plugin",
            hooks: [
              {
                collection: "posts",
                operation: "create",
                timing: "before",
                priority: 10,
                handler: () => {
                  order.push("plugin:10");
                },
              },
            ],
          },
          {
            id: "early-plugin",
            hooks: [
              {
                collection: "posts",
                operation: "create",
                timing: "before",
                priority: 1,
                handler: () => {
                  order.push("plugin:1");
                },
              },
            ],
          },
        ],
        databaseHooks: {
          posts: {
            create: {
              before: () => {
                order.push("config");
              },
            },
          },
        },
      });

      await cms.api.posts.create({ data: { title: "T", handle: "t" } });
      expect(order).toEqual(["plugin:1", "plugin:10", "config"]);

      const printed = cms
        .inspect()
        .hooks.filter(
          (hook) => hook.collection === "posts" && hook.timing === "before",
        )
        .map((hook) => hook.source);
      expect(printed).toEqual(["early-plugin", "late-plugin", "config"]);
      await cms.close();
    });

    test("ctx.db writes inside the operation's transaction", async () => {
      const { cms } = await setup({
        databaseHooks: {
          posts: {
            create: {
              after: async (doc, context) => {
                await context.db.insert("activity", {
                  id: `act_hook_${String(doc.id)}`,
                  actor_id: null,
                  actor_source: null,
                  action: "hook.ran",
                  collection: "posts",
                  document_id: String(doc.id),
                  locale: null,
                  changes: null,
                  ip: null,
                  created_at: new Date(),
                });
              },
            },
          },
        },
      });

      await cms.api.posts.create({ data: { title: "T", handle: "t" } });
      const adapter = await cms.database();
      const rows = await adapter.transaction((tx) =>
        adapter.query(tx, {
          table: "activity",
          where: eq("action", "hook.ran"),
        }),
      );
      expect(rows).toHaveLength(1);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Events and the outbox
    // -----------------------------------------------------------------------

    test("writes events to the outbox and delivers them after the commit", async () => {
      const { cms, events } = await setup();

      const post = await cms.api.posts.create({
        data: { title: "Hello", handle: "hello" },
        actor,
      });

      const adapter = await cms.database();
      const pending = await adapter.transaction((tx) =>
        adapter.query(tx, { table: "outbox", where: eq("status", "pending") }),
      );
      expect(pending.length).toBeGreaterThan(0);

      await cms.drainEvents();
      expect(events.map((event) => event.type)).toContain("document.created");

      const created = events.find((e) => e.type === "document.created");
      expect(created?.actor).toEqual({ id: "usr_test", source: "session" });
      expect((created?.data.document as JsonObject).id).toBe(String(post?.id));
      expect(created?.previous).toBeNull();

      const settled = await adapter.transaction((tx) =>
        adapter.query(tx, { table: "outbox", where: eq("status", "pending") }),
      );
      expect(settled).toHaveLength(0);
      await cms.close();
    });

    test("an update carries both sides and one event per changed field", async () => {
      const { cms, events } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Draft", handle: "draft", views: 1 },
      });
      await cms.drainEvents();
      events.length = 0;

      await cms.api.posts.update({
        id: String(post?.id),
        data: { status: "published", views: 1 },
      });
      await cms.drainEvents();

      const updated = events.find((event) => event.type === "document.updated");
      expect((updated?.data.document as JsonObject).status).toBe("published");
      expect((updated?.previous?.document as JsonObject).status).toBe("draft");

      // `views` was written with the value it already had, so it did not
      // change and must not produce an event.
      const changed = events.filter(
        (event) => event.type === "document.field.changed",
      );
      expect(changed.map((event) => event.data.field)).toEqual(["status"]);
      expect(changed[0]?.data.value).toBe("published");
      expect(changed[0]?.previous?.value).toBe("draft");
      await cms.close();
    });

    test("a rolled back write rolls back its events too", async () => {
      const { cms, events } = await setup({
        databaseHooks: {
          posts: {
            create: {
              after: () => {
                throw new Error("after exploded");
              },
            },
          },
        },
      });

      const adapter = await cms.database();
      await expect(
        cms.api.posts.create({ data: { title: "Doomed", handle: "doomed" } }),
      ).rejects.toThrow("after exploded");
      await cms.drainEvents();

      if (adapter.capabilities.transactions) {
        expect(await cms.api.posts.count()).toBe(0);
        expect(events).toHaveLength(0);
        const outbox = await adapter.transaction((tx) =>
          adapter.query(tx, { table: "outbox" }),
        );
        expect(outbox).toHaveLength(0);
      } else {
        // Without real transactions the document survives, and so does its
        // event — which is the point of the compensating path: the row was
        // written in the same operation sequence as the document, so the two
        // agree with each other instead of one of them being silently lost.
        // The adapter declaring `transactions: false` is what makes this a
        // documented outcome rather than a surprise (section 12).
        expect(await cms.api.posts.count()).toBe(1);
        expect(events.map((event) => event.type)).toEqual(["document.created"]);
      }
      await cms.close();
    });

    test("retries a failing delivery and gives up after five attempts", async () => {
      const { cms } = await setup();
      let attempts = 0;
      cms.on("document.created", () => {
        attempts += 1;
        throw new Error("consumer down");
      });

      await cms.api.posts.create({ data: { title: "T", handle: "t" } });
      const adapter = await cms.database();
      const read = () =>
        adapter.transaction((tx) =>
          adapter.query(tx, {
            table: "outbox",
            where: eq("type", "document.created"),
          }),
        );

      await cms.drainEvents();
      const retrying = await read();
      // Back on `pending` with a future `available_at`, and the failure
      // recorded: a consumer that is down must not lose the event.
      expect(retrying[0]?.status).toBe("pending");
      expect(Number(retrying[0]?.attempts)).toBe(1);
      expect(String(retrying[0]?.error)).toContain("consumer down");

      // Fast-forwards the backoff rather than waiting out 1s, 2s, 4s, 8s.
      for (let pass = 0; pass < 4; pass += 1) {
        await adapter.transaction((tx) =>
          adapter.mutate(tx, {
            kind: "update",
            table: "outbox",
            where: eq("type", "document.created"),
            set: { available_at: new Date(0) },
            returning: false,
          }),
        );
        await cms.drainEvents();
      }

      const dead = await read();
      expect(attempts).toBe(5);
      expect(dead[0]?.status).toBe("failed");
      expect(Number(dead[0]?.attempts)).toBe(5);
      await cms.close();
    });

    test("records the change in the activity log, inside the transaction", async () => {
      const { cms } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "T", handle: "t" },
        actor,
      });
      await cms.api.posts.update({
        id: String(post?.id),
        data: { status: "published" },
        actor,
      });

      const adapter = await cms.database();
      const rows = await adapter.transaction((tx) =>
        adapter.query(tx, {
          table: "activity",
          where: eq("document_id", String(post?.id)),
          orderBy: [orderBy("created_at", "asc"), orderBy("id", "asc")],
        }),
      );
      expect(rows.map((row) => row.action)).toEqual([
        "document.created",
        "document.updated",
      ]);
      expect(rows[1]?.actor_id).toBe("usr_test");
      // Where the write came from, next to who made it. They are different
      // questions — an AI write has a human actor and `source: "ai"` — and a
      // trail that could only answer one of them could not audit the other.
      expect(rows[1]?.source).toBe("local");
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Optimistic concurrency
    // -----------------------------------------------------------------------

    test("every write moves the revision, and a read reports it", async () => {
      const { cms } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "T", handle: "t" },
        actor,
      });
      expect(post?.revision).toBe(1);

      const updated = await cms.api.posts.update({
        id: String(post?.id),
        data: { status: "published" },
        actor,
      });
      expect(updated?.revision).toBe(2);

      const read = await cms.api.posts.findById(String(post?.id), { actor });
      expect(read?.revision).toBe(2);
      await cms.close();
    });

    test("a stale expectedRevision is refused instead of overwriting", async () => {
      const { cms } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "T", handle: "t" },
        actor,
      });
      const id = String(post?.id);

      // Two editors read revision 1. The second one has to lose.
      await cms.api.posts.update({
        id,
        data: { title: "First writer" },
        actor,
        expectedRevision: 1,
      });

      await expect(
        cms.api.posts.update({
          id,
          data: { title: "Second writer" },
          actor,
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ status: 409, code: "revision_conflict" });

      const stored = await cms.api.posts.findById(id, { actor });
      expect(stored?.title).toBe("First writer");
      await cms.close();
    });

    test("a write without a precondition still behaves as it always did", async () => {
      const { cms } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "T", handle: "t" },
        actor,
      });
      // Last writer wins, which is still the right default for a script that
      // just wrote the document it is patching.
      await cms.api.posts.update({
        id: String(post?.id),
        data: { title: "No precondition" },
        actor,
      });
      const stored = await cms.api.posts.findById(String(post?.id), { actor });
      expect(stored?.title).toBe("No precondition");
      await cms.close();
    });

    test("an idempotency key makes a repeated write happen once", async () => {
      const { cms } = await setup();
      const seen: string[] = [];
      const post = await cms.api.posts.create({
        data: { title: "T", handle: "t" },
        actor,
      });
      const id = String(post?.id);
      cms.on("document.updated", () => {
        seen.push("updated");
      });

      const first = await cms.api.posts.update({
        id,
        data: { title: "Written once" },
        actor,
        idempotencyKey: "run_1:call_1",
      });
      // The same call again — a client retrying over a dropped connection.
      const second = await cms.api.posts.update({
        id,
        data: { title: "Written once" },
        actor,
        idempotencyKey: "run_1:call_1",
      });

      expect(second?.revision).toBe(first?.revision);
      const stored = await cms.api.posts.findById(id, { actor });
      // Two writes would have left revision 3.
      expect(stored?.revision).toBe(2);

      await cms.drainEvents();
      expect(seen).toHaveLength(1);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Access control
    // -----------------------------------------------------------------------

    test("a Where from an access rule reaches the query, not the serialiser", async () => {
      const fixture = collections();
      const adapter = new CountingAdapter(await entry.create());
      const cms = heyoCms({
        database: () => adapter,
        collections: {
          ...fixture,
          posts: defineCollection({
            ...fixture.posts,
            access: {
              read: ({ actor }) => (actor ? true : eq("status", "published")),
            },
          }),
        },
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_access"), // prettier-ignore
      );

      await cms.api.posts.create({ data: { title: "A", handle: "a", status: "draft" } }); // prettier-ignore
      await cms.api.posts.create({ data: { title: "B", handle: "b", status: "published" } }); // prettier-ignore

      const anonymous = await cms.api.posts.find({ count: true });
      expect(anonymous.docs.map((doc) => doc.title)).toEqual(["B"]);
      // The filter has to reach the COUNT too, or pagination leaks the rows
      // it refuses to return.
      expect(anonymous.totalDocs).toBe(1);
      expect(await cms.api.posts.count()).toBe(1);

      const editor = await cms.api.posts.find({ actor });
      expect(editor.docs).toHaveLength(2);
      await cms.close();
    });

    test("a refused write is forbidden and a hidden row reads as missing", async () => {
      const fixture = collections();
      const adapter = new CountingAdapter(await entry.create());
      const cms = heyoCms({
        database: () => adapter,
        collections: {
          ...fixture,
          posts: defineCollection({
            ...fixture.posts,
            access: {
              update: ({ actor }) => actor?.id === "usr_owner",
              read: ({ actor }) => (actor ? true : eq("status", "published")),
            },
          }),
        },
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_deny"),
      );

      const post = await cms.api.posts.create({
        data: { title: "A", handle: "a", status: "draft" },
        actor,
      });

      await expect(
        cms.api.posts.update({
          id: String(post?.id),
          data: { views: 1 },
          actor: systemActor("usr_other"),
        }),
      ).rejects.toThrow(/Not allowed to update/);

      expect(await cms.api.posts.findById(String(post?.id))).toBeNull();
      await cms.close();
    });
  });
}

runEngineSuite({
  name: "sqlite",
  create: () => sqlite(new Database(":memory:")),
});

runEngineSuite({
  name: "postgres (pglite)",
  create: () => {
    const database = new PGlite();
    const client: PostgresClient = {
      async query(text, values) {
        const result = await database.query(text, values as unknown[]);
        return {
          rows: result.rows as never[],
          rowCount: result.affectedRows ?? result.rows.length,
        };
      },
      async end() {
        await database.close();
      },
    };
    return postgres(client);
  },
});

runEngineSuite({
  name: "mongodb (in-process)",
  create: () => mongodb(memoryMongo(), { transactions: false }),
});
