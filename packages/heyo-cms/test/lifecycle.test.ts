import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";

import {
  defineCollection,
  defineGlobal,
  heyoCms,
  systemActor,
} from "../src/config";
import { mongodb } from "../src/db/mongodb";
import { postgres, type PostgresClient } from "../src/db/postgres";
import { sqlite } from "../src/db/sqlite";
import { boolean, number, select, text } from "../src/fields";
import { permits } from "../src/access/index";
import { and, eq, exists } from "../src/query";
import { emptySnapshot } from "../src/schema/snapshot";
import type { Actor } from "../src/types/actor";
import type { HeyoCmsConfig } from "../src/types/config";
import type { DatabaseAdapter } from "../src/types/database";
import type { CmsEvent } from "../src/types/events";
import type { CmsInstance } from "../src/types/instance";
import type { Row, Where } from "../src/types/query";
import { memoryMongo } from "./mongo-memory";

/**
 * Stage 5: scheduled changes, the trash and globals.
 *
 * All three are the same bet — that the engine needs no document lifecycle
 * (section 3). A publication is a patch applied later, a delete is a column,
 * and a singleton is a collection with one row. This suite is where that bet
 * is settled: the scheduled change has to emit exactly what a human save
 * emits, the trash has to leave nothing behind when it finally lets go, and a
 * global has to be readable before anybody has ever saved it.
 *
 * It runs on all three engines because the two sweeps are the only queries in
 * the product that filter on "has a value and is in the past", which is the
 * one place MongoDB's comparison of `null` against a date would quietly hand
 * the applier every document in the database.
 */

const collections = () => ({
  posts: defineCollection({
    fields: {
      title: text({ required: true, localized: true }),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
      status: select({ options: ["draft", "review", "published"], default: "draft" }), // prettier-ignore
      views: number({ integer: true }),
    },
  }),
  pages: defineCollection({
    fields: {
      title: text({ required: true }),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
    },
  }),
});

const globals = () => ({
  settings: defineGlobal({
    fields: {
      siteName: text({ default: "Untitled" }),
      tagline: text({ localized: true }),
      maintenance: boolean({ default: false }),
    },
  }),
});

type Fixture = ReturnType<typeof collections>;
type GlobalFixture = ReturnType<typeof globals>;

type Overrides = Partial<
  Omit<HeyoCmsConfig<Fixture, GlobalFixture>, "database" | "collections" | "globals"> // prettier-ignore
>;

interface EngineUnderTest {
  name: string;
  create(): Promise<DatabaseAdapter> | DatabaseAdapter;
}

const hour = 3_600_000;
const day = 24 * hour;

function runLifecycleSuite(entry: EngineUnderTest): void {
  describe(`lifecycle: ${entry.name}`, () => {
    const setup = async (
      overrides: Overrides = {},
    ): Promise<{
      cms: CmsInstance<Fixture, GlobalFixture>;
      adapter: DatabaseAdapter;
      events: CmsEvent[];
      rows: (where?: Parameters<typeof rowsIn>[2]) => Promise<Row[]>;
    }> => {
      const adapter = await entry.create();
      const cms = heyoCms({
        ...overrides,
        database: () => adapter,
        collections: collections(),
        globals: globals(),
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_life"),
      );

      const events: CmsEvent[] = [];
      cms.on("*", (event) => {
        events.push(event);
      });
      return {
        cms,
        adapter,
        events,
        rows: (where) => rowsIn(adapter, "documents", where),
      };
    };

    const actor: Actor = systemActor("usr_test");

    // -----------------------------------------------------------------------
    // Trash
    // -----------------------------------------------------------------------

    test("a delete moves the document to the trash and keeps the row", async () => {
      const { cms, events, rows } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Gone", handle: "gone" },
        actor,
      });
      const id = String(post?.id);

      const trashed = await cms.api.posts.delete({ id, actor });
      expect(trashed?.deletedAt).not.toBeNull();
      // Thirty days by default, and the document says so itself: a panel that
      // has to compute the deadline would compute a different one.
      expect(trashed?.purgeAfter).not.toBeNull();

      expect(await cms.api.posts.findById(id)).toBeNull();
      expect(await cms.api.posts.count()).toBe(0);
      expect(await rows()).toHaveLength(1);

      // Still readable when asked for, which is what makes a trash screen
      // possible without a second table.
      const kept = await cms.api.posts.findById(id, { includeTrashed: true });
      expect(kept?.title).toBe("Gone");

      await cms.drainEvents();
      const event = events.find((entry) => entry.type === "document.trashed");
      expect(event?.data.documentId).toBe(id);
      expect(event?.data.purgeAfter).not.toBeNull();
      expect(events.map((entry) => entry.type)).not.toContain(
        "document.purged",
      );
      await cms.close();
    });

    test("restore brings it back, and restoring a live document is refused", async () => {
      const { cms, events } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Back", handle: "back" },
      });
      const id = String(post?.id);

      await cms.api.posts.delete({ id });
      const restored = await cms.api.posts.restore({ id });
      expect(restored?.deletedAt).toBeNull();
      expect(restored?.purgeAfter).toBeNull();
      expect((await cms.api.posts.findById(id))?.title).toBe("Back");

      await expect(cms.api.posts.restore({ id })).rejects.toThrow(
        /is not in the trash/,
      );

      await cms.drainEvents();
      expect(events.map((entry) => entry.type)).toContain("document.restored");
      await cms.close();
    });

    test("purge removes the row for good", async () => {
      const { cms, events, rows } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Final", handle: "final" },
      });
      const id = String(post?.id);

      await cms.api.posts.delete({ id });
      await cms.api.posts.purge({ id });

      expect(await rows()).toHaveLength(0);
      expect(
        await cms.api.posts.findById(id, { includeTrashed: true }),
      ).toBeNull();

      await cms.drainEvents();
      const types = events.map((entry) => entry.type);
      expect(types).toContain("document.trashed");
      expect(types).toContain("document.purged");
      await cms.close();
    });

    test("the delete hooks run once, when the document leaves the live set", async () => {
      const ran: string[] = [];
      const { cms } = await setup({
        databaseHooks: {
          posts: {
            delete: {
              before: (doc) => {
                ran.push(`before:${String(doc.handle)}`);
              },
              after: (doc) => {
                ran.push(`after:${String(doc.handle)}`);
              },
            },
          },
        },
      });

      const post = await cms.api.posts.create({
        data: { title: "Once", handle: "once" },
      });
      const id = String(post?.id);

      await cms.api.posts.delete({ id });
      expect(ran).toEqual(["before:once", "after:once"]);

      // The purge of an already trashed document must not run them again: a
      // hook that decrements a counter would decrement it twice for one
      // document, thirty days apart.
      await cms.api.posts.purge({ id });
      expect(ran).toEqual(["before:once", "after:once"]);

      // A permanent delete skips the trash, so this is the document leaving
      // and the hooks belong to it.
      const direct = await cms.api.posts.create({
        data: { title: "Direct", handle: "direct" },
      });
      await cms.api.posts.delete({ id: String(direct?.id), permanent: true });
      expect(ran).toEqual([
        "before:once",
        "after:once",
        "before:direct",
        "after:direct",
      ]);
      await cms.close();
    });

    test("with the trash switched off a delete is permanent", async () => {
      const { cms, events, rows } = await setup({ trash: { enabled: false } });
      const post = await cms.api.posts.create({
        data: { title: "No trash", handle: "no-trash" },
      });

      await cms.api.posts.delete({ id: String(post?.id) });
      expect(await rows()).toHaveLength(0);

      await cms.drainEvents();
      const types = events.map((entry) => entry.type);
      expect(types).toContain("document.purged");
      expect(types).not.toContain("document.trashed");
      await cms.close();
    });

    test("a trashed document keeps its media references, a purged one does not", async () => {
      const { cms, adapter } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Illustrated", handle: "illustrated" },
      });
      const id = String(post?.id);
      await seedMediaUsage(adapter, id);

      await cms.api.posts.delete({ id });
      // The image is still in use: the document can come back, and a
      // reference count that dropped while it sat in the trash would orphan
      // and eventually delete a file the editor never stopped using.
      expect(await rowsIn(adapter, "media_usages")).toHaveLength(1);

      await cms.api.posts.purge({ id });
      expect(await rowsIn(adapter, "media_usages")).toHaveLength(0);
      await cms.close();
    });

    test("the trash lists every collection at once, newest first", async () => {
      const { cms } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Post", handle: "post" },
      });
      const page = await cms.api.pages.create({
        data: { title: "Page", handle: "page" },
      });
      const kept = await cms.api.posts.create({
        data: { title: "Kept", handle: "kept" },
      });

      await cms.api.posts.delete({ id: String(post?.id) });
      await cms.api.pages.delete({ id: String(page?.id) });

      const all = await cms.trash.list();
      expect(all.entries.map((item) => item.collection).sort()).toEqual([
        "pages",
        "posts",
      ]);
      expect(all.entries.every((item) => item.deletedAt !== null)).toBe(true);
      expect(all.entries.map((item) => item.id)).not.toContain(
        String(kept?.id),
      );

      const posts = await cms.trash.list({ collection: "posts" });
      expect(posts.entries).toHaveLength(1);
      expect(posts.entries[0]?.document.title).toBe("Post");

      // The same restore the collection API performs, addressed the way a
      // trash screen addresses it.
      await cms.trash.restore({ collection: "posts", id: String(post?.id) });
      expect((await cms.trash.list()).entries).toHaveLength(1);

      await cms.trash.purge({ collection: "pages", id: String(page?.id) });
      expect((await cms.trash.list()).entries).toHaveLength(0);
      await cms.close();
    });

    test("the trash pages with a cursor", async () => {
      const { cms } = await setup();
      for (let index = 0; index < 5; index += 1) {
        const post = await cms.api.posts.create({
          data: { title: `Post ${index}`, handle: `p-${index}` },
        });
        await cms.api.posts.delete({ id: String(post?.id) });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 3; page += 1) {
        const result: Awaited<ReturnType<typeof cms.trash.list>> =
          await cms.trash.list({
            limit: 2,
            ...(cursor === null ? {} : { cursor }),
          });
        seen.push(...result.entries.map((entry) => entry.id));
        cursor = result.cursor;
        if (!result.hasNextPage) break;
      }

      expect(new Set(seen).size).toBe(5);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Scheduled changes
    // -----------------------------------------------------------------------

    test("a scheduled change is recorded and changes nothing yet", async () => {
      const { cms, events } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Soon", handle: "soon" },
        actor,
      });
      const id = String(post?.id);
      const at = new Date(Date.now() + hour);

      const scheduled = await cms.api.posts.schedule({
        id,
        at,
        data: { status: "published" },
        actor,
      });

      expect(scheduled?.status).toBe("draft");
      expect(scheduled?.scheduledAt).toBe(at.toISOString());
      expect(scheduled?.scheduledPatch).toEqual({ status: "published" });

      await cms.drainEvents();
      const event = events.find((entry) => entry.type === "document.scheduled");
      expect(event?.data.scheduledAt).toBe(at.toISOString());
      expect(event?.data.patch).toEqual({ status: "published" });
      // Nothing about the document changed, so nothing may claim it did.
      expect(events.map((entry) => entry.type)).not.toContain(
        "document.updated",
      );
      await cms.close();
    });

    test("the job applies it on time and emits what a manual save emits", async () => {
      const { cms, events } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Friday", handle: "friday" },
        actor,
      });
      const id = String(post?.id);
      const at = new Date(Date.now() + hour);
      await cms.api.posts.schedule({
        id,
        at,
        data: { status: "published" },
        actor,
      });
      await cms.drainEvents();
      events.length = 0;

      // Not due yet: a sweep that runs every minute must not publish an hour
      // early.
      const early = await cms.jobs.run({ now: new Date() });
      expect(early.processed).toBe(0);
      expect((await cms.api.posts.findById(id))?.status).toBe("draft");

      const report = await cms.jobs.run({ now: new Date(Date.now() + 2 * hour) }); // prettier-ignore
      expect(report.processed).toBe(1);
      expect(report.failed).toBe(0);
      expect(
        report.results.find((result) => result.job === "scheduled-changes")
          ?.processed,
      ).toBe(1);

      const applied = await cms.api.posts.findById(id);
      expect(applied?.status).toBe("published");
      // The schedule is consumed, not repeated.
      expect(applied?.scheduledAt).toBeNull();
      expect(applied?.scheduledPatch).toBeNull();
      // Attributed to whoever scheduled it, not to the machine that ran it.
      expect(applied?.updatedBy).toBe("usr_test");

      await cms.drainEvents();
      const types = events.map((entry) => entry.type);
      expect(types).toContain("document.updated");
      expect(types).toContain("document.field.changed");
      expect(types).toContain("document.schedule.applied");

      const changed = events.find(
        (entry) => entry.type === "document.field.changed",
      );
      expect(changed?.data.field).toBe("status");
      expect(changed?.data.value).toBe("published");
      expect(changed?.previous?.value).toBe("draft");

      const second = await cms.jobs.run({ now: new Date(Date.now() + 3 * hour) }); // prettier-ignore
      expect(second.processed).toBe(0);
      await cms.close();
    });

    test("two overlapping sweeps apply a change once", async () => {
      const applied: string[] = [];
      const { cms } = await setup({
        databaseHooks: {
          posts: {
            update: {
              after: ({ doc }) => {
                applied.push(String(doc.id));
              },
            },
          },
        },
      });

      const post = await cms.api.posts.create({
        data: { title: "Race", handle: "race" },
      });
      await cms.api.posts.schedule({
        id: String(post?.id),
        at: new Date(Date.now() - hour),
        data: { status: "published" },
      });

      const now = new Date();
      await Promise.all([cms.jobs.run({ now }), cms.jobs.run({ now })]);
      // The claim is a conditional update, so the loser of the race finds
      // nothing to do rather than publishing a second time.
      expect(applied).toEqual([String(post?.id)]);
      await cms.close();
    });

    test("a scheduled change runs the update hooks and is recorded as a job", async () => {
      const seen: string[] = [];
      const { cms } = await setup({
        databaseHooks: {
          posts: {
            update: {
              before: ({ data }, context) => {
                seen.push(context.source);
                return { data: { ...data, views: 1 } };
              },
            },
          },
        },
      });

      const post = await cms.api.posts.create({
        data: { title: "Hooked", handle: "hooked" },
      });
      await cms.api.posts.schedule({
        id: String(post?.id),
        at: new Date(Date.now() - hour),
        data: { status: "published" },
      });
      await cms.jobs.run();

      const applied = await cms.api.posts.findById(String(post?.id));
      expect(applied?.status).toBe("published");
      // The hook saw it as a job, and could have refused it: a scheduled
      // change is an ordinary update and gets no special treatment.
      expect(applied?.views).toBe(1);
      expect(seen).toEqual(["job"]);
      await cms.close();
    });

    test("unschedule cancels, and cancelling nothing is refused", async () => {
      const { cms, events } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Maybe", handle: "maybe" },
      });
      const id = String(post?.id);

      await cms.api.posts.schedule({
        id,
        at: new Date(Date.now() + hour),
        data: { status: "published" },
      });
      const cancelled = await cms.api.posts.unschedule({ id });
      expect(cancelled?.scheduledAt).toBeNull();
      expect(cancelled?.scheduledPatch).toBeNull();

      await expect(cms.api.posts.unschedule({ id })).rejects.toThrow(
        /has nothing scheduled/,
      );

      const report = await cms.jobs.run({ now: new Date(Date.now() + day) });
      expect(report.processed).toBe(0);
      expect((await cms.api.posts.findById(id))?.status).toBe("draft");

      await cms.drainEvents();
      expect(events.map((entry) => entry.type)).toContain(
        "document.schedule.cancelled",
      );
      await cms.close();
    });

    test("trashing a document cancels what was scheduled on it", async () => {
      const { cms } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Doomed", handle: "doomed" },
      });
      const id = String(post?.id);
      await cms.api.posts.schedule({
        id,
        at: new Date(Date.now() - hour),
        data: { status: "published" },
      });

      await cms.api.posts.delete({ id });
      const report = await cms.jobs.run();
      expect(report.processed).toBe(0);

      await cms.api.posts.restore({ id });
      const restored = await cms.api.posts.findById(id);
      // Restoring must not detonate a publication that came due while the
      // document was in the trash.
      expect(restored?.status).toBe("draft");
      expect(restored?.scheduledAt).toBeNull();
      await cms.close();
    });

    test("a failing change is recorded with its patch and does not stop the sweep", async () => {
      const { cms, events } = await setup({
        databaseHooks: {
          posts: {
            update: {
              before: ({ data }) => {
                if (data.status === "published") throw new Error("nope");
              },
            },
          },
        },
      });

      const bad = await cms.api.posts.create({
        data: { title: "Bad", handle: "bad" },
      });
      const good = await cms.api.posts.create({
        data: { title: "Good", handle: "good" },
      });
      await cms.api.posts.schedule({
        id: String(bad?.id),
        at: new Date(Date.now() - hour),
        data: { status: "published" },
      });
      await cms.api.posts.schedule({
        id: String(good?.id),
        at: new Date(Date.now() - hour),
        data: { status: "review" },
      });

      const report = await cms.jobs.run();
      expect(report.failed).toBe(1);
      expect(report.processed).toBe(1);
      // The one that worked is not held hostage by the one that did not.
      expect((await cms.api.posts.findById(String(good?.id)))?.status).toBe(
        "review",
      );

      const failures = await cms.jobs.failures();
      const patch = failures.find(
        (failure) => failure.type === "document.schedule",
      );
      // The claim already removed the schedule from the document, so this row
      // is the only remaining copy of what the editor asked for.
      expect(patch?.payload?.patch).toEqual({ status: "published" });
      expect(patch?.error).toContain("nope");

      await cms.drainEvents();
      expect(events.map((entry) => entry.type)).toContain("job.failed");
      await cms.close();
    });

    test("the purge job removes what is due and leaves what is not", async () => {
      const { cms, adapter, rows } = await setup({
        trash: { enabled: true, purgeAfter: "30d" },
        // Retention has to keep working the day roles arrive: the sweep holds
        // no permissions and never will.
        rbac: { roles: { admin: ["*"] } },
      });

      const expired = await cms.api.posts.create({
        data: { title: "Expired", handle: "expired" },
        actor,
      });
      const fresh = await cms.api.posts.create({
        data: { title: "Fresh", handle: "fresh" },
        actor,
      });
      await cms.api.posts.delete({ id: String(expired?.id), actor });
      await cms.api.posts.delete({ id: String(fresh?.id), actor });
      await seedMediaUsage(adapter, String(expired?.id));

      // Backdated rather than waited out: thirty days is the point of the
      // feature and a bad length for a test.
      await setPurgeAfter(adapter, String(expired?.id), new Date(Date.now() - day)); // prettier-ignore

      const report = await cms.jobs.run();
      expect(
        report.results.find((result) => result.job === "trash-purge")
          ?.processed,
      ).toBe(1);

      expect(await rows(eq("id", String(expired?.id)))).toHaveLength(0);
      expect(await rows(eq("id", String(fresh?.id)))).toHaveLength(1);
      // Nothing is left pointing at a document that no longer exists.
      expect(await rowsIn(adapter, "media_usages")).toHaveLength(0);
      await cms.close();
    });

    test("purgeAfter: false keeps deleted documents forever", async () => {
      const { cms, adapter, rows } = await setup({
        trash: { enabled: true, purgeAfter: false },
      });
      const post = await cms.api.posts.create({
        data: { title: "Kept", handle: "kept" },
      });
      const trashed = await cms.api.posts.delete({ id: String(post?.id) });
      expect(trashed?.purgeAfter).toBeNull();

      await setPurgeAfter(
        adapter,
        String(post?.id),
        new Date(Date.now() - day),
      );
      const report = await cms.jobs.run();
      expect(
        report.results.find((result) => result.job === "trash-purge")
          ?.processed,
      ).toBe(0);
      expect(await rows(eq("id", String(post?.id)))).toHaveLength(1);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Globals
    // -----------------------------------------------------------------------

    test("a global reads as its defaults before anybody saves it", async () => {
      const { cms, rows } = await setup();

      const settings = await cms.globals.settings.get();
      expect(settings.siteName).toBe("Untitled");
      expect(settings.maintenance).toBe(false);
      expect(settings.createdAt).toBeNull();
      // A read that writes cannot run on a replica, and an anonymous page view
      // has no business creating a row.
      expect(await rows()).toHaveLength(0);
      await cms.close();
    });

    test("a global is created on first save and updated after that", async () => {
      const { cms, events, rows } = await setup();

      const saved = await cms.globals.settings.update({
        data: { siteName: "Acme" },
        actor,
      });
      expect(saved?.siteName).toBe("Acme");
      expect(saved?.maintenance).toBe(false);
      expect(saved?.updatedBy).toBe("usr_test");
      expect(await rows()).toHaveLength(1);

      const again = await cms.globals.settings.update({
        data: { maintenance: true },
      });
      expect(again?.siteName).toBe("Acme");
      expect(again?.maintenance).toBe(true);
      // One row, whatever happens: the id is derived from the slug.
      expect(await rows()).toHaveLength(1);

      await cms.drainEvents();
      const updates = events.filter(
        (entry) => entry.type === "document.updated",
      );
      expect(updates).toHaveLength(2);
      expect(updates[0]?.data.collection).toBe("settings");
      await cms.close();
    });

    test("a global speaks locales and runs the update hooks", async () => {
      const saw: string[] = [];
      const { cms } = await setup({
        i18n: { locales: ["en", "de"], defaultLocale: "en" },
        databaseHooks: {
          settings: {
            update: {
              before: ({ data }) => {
                saw.push(Object.keys(data).join(","));
              },
            },
          },
        },
      });

      await cms.globals.settings.update({
        data: { tagline: "Everything, sooner" },
        locale: "en",
      });
      await cms.globals.settings.update({
        data: { tagline: "Alles, früher" },
        locale: "de",
      });

      expect((await cms.globals.settings.get({ locale: "de" })).tagline).toBe(
        "Alles, früher",
      );
      const french = await cms.globals.settings.get({ locale: "fr" });
      expect(french.tagline).toBe("Everything, sooner");
      expect(french._fallback).toEqual({ tagline: "en" });
      expect(saw).toEqual(["tagline", "tagline"]);
      await cms.close();
    });

    test("a global can be scheduled like anything else", async () => {
      const { cms } = await setup();

      await cms.globals.settings.schedule({
        at: new Date(Date.now() - hour),
        data: { maintenance: true },
      });
      expect((await cms.globals.settings.get()).maintenance).toBe(false);

      const report = await cms.jobs.run();
      expect(report.processed).toBe(1);
      expect((await cms.globals.settings.get()).maintenance).toBe(true);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    test("scheduling obeys field access, so a writer cannot schedule a publish", async () => {
      const adapter = await entry.create();
      const cms = heyoCms({
        database: () => adapter,
        rbac: {
          roles: {
            admin: ["*"],
            // May delete, which is reversible, and neither of the two
            // operations that are not.
            writer: [
              "posts:read",
              "posts:create",
              "posts:update",
              "posts:delete",
            ],
          },
        },
        collections: {
          pages: collections().pages,
          posts: defineCollection({
            fields: {
              title: text({ required: true }),
              handle: text({
                unique: true,
                index: true,
                pattern: "^[a-z0-9-]+$",
              }),
              status: select({
                options: ["draft", "published"],
                default: "draft",
                access: {
                  update: ({ actor: who }) => permits(who, "posts:publish"),
                },
              }),
            },
          }),
        },
        globals: globals(),
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_access"), // prettier-ignore
      );

      const writer: Actor = {
        id: "usr_writer",
        source: "session",
        roles: ["writer"],
        permissions: [
          "posts:read",
          "posts:create",
          "posts:update",
          "posts:delete",
        ],
      };
      const post = await cms.api.posts.create({
        data: { title: "Draft" },
        actor: writer,
      });
      const id = String(post?.id);

      // Refused when it is scheduled, not when it fires: finding out on
      // Friday night that the publication was never allowed is the failure
      // mode this prevents.
      await expect(
        cms.api.posts.schedule({
          id,
          at: new Date(Date.now() + hour),
          data: { status: "published" },
          actor: writer,
        }),
      ).rejects.toThrow(/Not allowed to write "status"/);

      // A writer with no `posts:purge` cannot empty the trash either, even
      // though they may delete.
      await cms.api.posts.delete({ id, actor: writer });
      await expect(cms.api.posts.purge({ id, actor: writer })).rejects.toThrow(
        /posts:purge/,
      );
      await expect(
        cms.api.posts.restore({ id, actor: writer }),
      ).rejects.toThrow(/posts:restore/);

      await cms.api.posts.restore({ id, actor: systemActor("usr_admin") });
      expect((await cms.api.posts.findById(id, { actor: writer }))?.title).toBe(
        "Draft",
      );
      await cms.close();
    });

    test("the activity log records every step of the lifecycle", async () => {
      const { cms, adapter } = await setup();
      const post = await cms.api.posts.create({
        data: { title: "Tracked", handle: "tracked" },
        actor,
      });
      const id = String(post?.id);

      await cms.api.posts.schedule({
        id,
        at: new Date(Date.now() - hour),
        data: { status: "published" },
        actor,
      });
      await cms.jobs.run();
      await cms.api.posts.delete({ id, actor });
      await cms.api.posts.restore({ id, actor });
      await cms.api.posts.purge({ id, actor });

      const activity = await rowsIn(adapter, "activity", eq("document_id", id));
      expect(activity.map((row) => String(row.action))).toEqual([
        "document.created",
        "document.scheduled",
        "document.updated",
        "document.trashed",
        "document.restored",
        "document.purged",
      ]);
      await cms.close();
    });

    test("inspect prints the sweeps and what a delete does", async () => {
      const { cms } = await setup();
      const inspection = cms.inspect();
      expect(inspection.jobs).toEqual(["scheduled-changes", "trash-purge"]);
      expect(inspection.trash).toEqual({ enabled: true, purgeAfter: "30d" });
      expect(
        inspection.collections.find((item) => item.name === "settings")?.kind,
      ).toBe("global");
      await cms.close();
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function rowsIn(
  adapter: DatabaseAdapter,
  table: string,
  where?: Where,
): Promise<Row[]> {
  return adapter.transaction((tx) =>
    adapter.query(tx, {
      table,
      ...(where === undefined ? {} : { where }),
      orderBy: [{ path: "created_at", direction: "asc" }, { path: "id", direction: "asc" }], // prettier-ignore
    }),
  );
}

/**
 * A media row and a usage pointing at a document.
 *
 * Written through the adapter rather than through `cms.media`: what this suite
 * needs to assert is that the trash does not strand references and the purge
 * does not leave them behind, and that is true of the table whoever wrote the
 * row. The media suite covers the same ground from the other direction.
 */
async function seedMediaUsage(
  adapter: DatabaseAdapter,
  documentId: string,
): Promise<void> {
  const now = new Date();
  await adapter.transaction(async (tx) => {
    await adapter.mutate(tx, {
      kind: "insert",
      table: "media",
      returning: false,
      values: {
        id: `med_${documentId}`,
        filename: "cover.webp",
        mime_type: "image/webp",
        size: 1024,
        width: null,
        height: null,
        storage_key: `media/${documentId}.webp`,
        checksum: null,
        alt: null,
        focal_x: null,
        focal_y: null,
        status: "active",
        orphaned_at: null,
        purge_after: null,
        purge_error: null,
        metadata: null,
        created_by: null,
        created_at: now,
        updated_at: now,
      },
    });
    await adapter.mutate(tx, {
      kind: "insert",
      table: "media_usages",
      returning: false,
      values: {
        id: `mus_${documentId}`,
        media_id: `med_${documentId}`,
        collection: "posts",
        document_id: documentId,
        field: "cover",
        locale: "",
        created_at: now,
      },
    });
  });
}

/** Backdates a trash deadline, so a thirty-day retention is testable. */
async function setPurgeAfter(
  adapter: DatabaseAdapter,
  id: string,
  at: Date,
): Promise<void> {
  await adapter.transaction((tx) =>
    adapter.mutate(tx, {
      kind: "update",
      table: "documents",
      where: and(eq("id", id), exists("deleted_at", true)),
      set: { purge_after: at },
      returning: false,
    }),
  );
}

runLifecycleSuite({
  name: "sqlite",
  create: () => sqlite(new Database(":memory:")),
});

runLifecycleSuite({
  name: "postgres (pglite)",
  create: () => {
    const database = new PGlite();
    const client: PostgresClient = {
      async query(text_, values) {
        const result = await database.query(text_, values as unknown[]);
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

runLifecycleSuite({
  name: "mongodb (in-process)",
  create: () => mongodb(memoryMongo(), { transactions: false }),
});
