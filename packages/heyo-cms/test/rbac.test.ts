import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";

import {
  expandRoles,
  intersectPermissions,
  permissionFor,
  permits,
  scopePermissions,
} from "../src/access/permissions";
import { defineCollection, heyoCms } from "../src/config";
import { mongodb } from "../src/db/mongodb";
import { postgres, type PostgresClient } from "../src/db/postgres";
import { sqlite } from "../src/db/sqlite";
import { number, relation, select, text } from "../src/fields";
import { eq } from "../src/query";
import { emptySnapshot } from "../src/schema/snapshot";
import type { Actor } from "../src/types/actor";
import type { HeyoCmsConfig } from "../src/types/config";
import type { DatabaseAdapter } from "../src/types/database";
import type { JsonObject } from "../src/types/json";
import { memoryMongo } from "./mongo-memory";

/**
 * Stage 4: roles decide, filters reach the query, fields decide publishing.
 *
 * The permission grammar is tested on its own because it is pure, and then
 * through the engine on every database, because the one thing that must never
 * differ between engines is who is allowed to see what.
 */

const roles = {
  admin: ["*"],
  editor: ["posts:*", "media:*"],
  writer: ["posts:read", "posts:create", "posts:update"],
  viewer: ["*:read"],
};

function actorWith(role: keyof typeof roles): Actor {
  return {
    id: `usr_${role}`,
    source: "session",
    roles: [role],
    permissions: expandRoles([role], roles),
  };
}

describe("permission grammar", () => {
  test("matches on both halves, and `*` matches everything", () => {
    expect(permits(actorWith("admin"), "posts:delete")).toBe(true);
    expect(permits(actorWith("editor"), "posts:delete")).toBe(true);
    expect(permits(actorWith("editor"), "pages:read")).toBe(false);
    expect(permits(actorWith("viewer"), "anything:read")).toBe(true);
    expect(permits(actorWith("viewer"), "posts:update")).toBe(false);
    // An anonymous caller holds nothing; answering that here keeps every
    // call site from having to.
    expect(permits(null, "posts:read")).toBe(false);
  });

  test("expands roles and ignores one that no longer exists", () => {
    expect(expandRoles(["writer", "ghost"], roles)).toEqual([
      "posts:create",
      "posts:read",
      "posts:update",
    ]);
  });

  test("a scope narrows its owner and can never widen them", () => {
    expect(scopePermissions(["read"])).toEqual(["*:read"]);
    expect(scopePermissions(["write"])).toEqual([
      "*:create",
      "*:read",
      "*:update",
    ]);
    // An administrator's read-only key is read-only.
    expect(intersectPermissions(["*"], scopePermissions(["read"]))).toEqual([
      "*:read",
    ]);
    // A writer's key cannot delete, whatever the scope claims.
    expect(
      intersectPermissions(expandRoles(["writer"], roles), ["*:delete"]),
    ).toEqual([]);
    expect(
      intersectPermissions(expandRoles(["editor"], roles), ["*:read"]),
    ).toEqual(["media:read", "posts:read"]);
    expect(permissionFor("posts", "create")).toBe("posts:create");
  });
});

// ---------------------------------------------------------------------------
// Through the engine
// ---------------------------------------------------------------------------

interface EngineUnderTest {
  name: string;
  create(): Promise<DatabaseAdapter> | DatabaseAdapter;
}

const collections = () => ({
  authors: defineCollection({ fields: { name: text({ required: true }) } }),
  posts: defineCollection({
    fields: {
      title: text({ required: true }),
      status: select({
        options: ["draft", "published"],
        default: "draft",
        // No `access.publish` anywhere: publishing is writing this field.
        access: { update: ({ actor }) => permits(actor, "posts:publish") },
      }),
      salary: number({
        access: { read: ({ actor }) => permits(actor, "posts:read_secret") },
      }),
      author: relation("authors"),
    },
  }),
});

type Fixture = ReturnType<typeof collections>;
type Overrides = Partial<Omit<HeyoCmsConfig<Fixture>, "database" | "collections">>; // prettier-ignore

function runRbacSuite(entry: EngineUnderTest): void {
  describe(`rbac: ${entry.name}`, () => {
    const setup = async (overrides: Overrides = {}) => {
      const adapter = await entry.create();
      const cms = heyoCms({
        rbac: {
          roles: {
            ...roles,
            publisher: ["posts:*", "posts:publish"],
            inspector: ["posts:read", "posts:read_secret"],
          },
        },
        ...overrides,
        database: () => adapter,
        collections: collections(),
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_rbac"),
      );
      return cms;
    };

    const roleActor = async (
      cms: Awaited<ReturnType<typeof setup>>,
      role: string,
      id = `usr_${role}`,
    ): Promise<Actor> => ({
      id,
      source: "session",
      roles: [role],
      permissions: await cms.auth.roles.permissionsFor([role]),
    });

    test("a collection with no rule falls back to the permission", async () => {
      const cms = await setup();
      const admin = await roleActor(cms, "admin");

      const post = await cms.api.posts.create({
        data: { title: "Hello" },
        actor: admin,
      });
      expect(post?.title).toBe("Hello");

      // Anonymous gets 401 — signing in might help. A signed-in viewer gets
      // 403 and the name of the permission they are missing.
      await expect(cms.api.posts.create({ data: { title: "No" } })).rejects.toThrow(/Not allowed to create/); // prettier-ignore

      await expect(
        cms.api.posts.create({
          data: { title: "No" },
          actor: await roleActor(cms, "viewer"),
        }),
      ).rejects.toThrow(/"posts:create" permission is required/);

      const readable = await cms.api.posts.find({
        actor: await roleActor(cms, "viewer"),
      });
      expect(readable.docs).toHaveLength(1);
      await cms.close();
    });

    test("an explicit rule is the final word, not a second opinion", async () => {
      const adapter = await entry.create();
      const fixture = collections();
      const cms = heyoCms({
        rbac: { roles },
        database: () => adapter,
        collections: {
          ...fixture,
          // `viewer` has no `posts:create`, and this rule does not care.
          posts: defineCollection({ ...fixture.posts, access: { create: () => true } }), // prettier-ignore
        },
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_rule"),
      );

      const created = await cms.api.posts.create({
        data: { title: "Allowed" },
        actor: actorWith("viewer"),
      });
      expect(created?.title).toBe("Allowed");
      await cms.close();
    });

    test("a writer cannot publish, and a publisher can", async () => {
      const cms = await setup();
      const writer = await roleActor(cms, "writer");
      const publisher = await roleActor(cms, "publisher");

      const post = await cms.api.posts.create({
        data: { title: "Draft" },
        actor: writer,
      });
      expect(post?.status).toBe("draft");

      // The whole of "who may publish", with no publish operation in sight.
      await expect(
        cms.api.posts.update({
          id: String(post?.id),
          data: { status: "published" },
          actor: writer,
        }),
      ).rejects.toThrow(/Not allowed to write "status"/);

      // Refused, not silently dropped: the stored document is untouched.
      const stored = await cms.api.posts.findById(String(post?.id), { actor: writer }); // prettier-ignore
      expect(stored?.status).toBe("draft");

      const published = await cms.api.posts.update({
        id: String(post?.id),
        data: { status: "published" },
        actor: publisher,
      });
      expect(published?.status).toBe("published");

      // A write that does not touch the field is none of the rule's business.
      const renamed = await cms.api.posts.update({
        id: String(post?.id),
        data: { title: "Renamed" },
        actor: writer,
      });
      expect(renamed?.title).toBe("Renamed");
      await cms.close();
    });

    test("a field that cannot be read is absent, not null", async () => {
      const cms = await setup();
      const writer = await roleActor(cms, "writer");
      const inspector = await roleActor(cms, "inspector");

      const post = await cms.api.posts.create({
        data: { title: "Payroll", salary: 1000 },
        actor: writer,
      });
      // Even the write that set it comes back redacted, because the rule is
      // about the reader, not about the writer.
      expect("salary" in (post as unknown as JsonObject)).toBe(false);

      const hidden = await cms.api.posts.findById(String(post?.id), {
        actor: writer,
      });
      expect(hidden?.title).toBe("Payroll");
      expect("salary" in (hidden as unknown as JsonObject)).toBe(false);

      const visible = await cms.api.posts.findById(String(post?.id), {
        actor: inspector,
      });
      expect(visible?.salary).toBe(1000);
      await cms.close();
    });

    test("depth cannot be used to read a field around its rule", async () => {
      const adapter = await entry.create();
      const cms = heyoCms({
        rbac: { roles: { ...roles, inspector: ["*:read", "posts:read_secret"] } }, // prettier-ignore
        database: () => adapter,
        collections: {
          ...collections(),
          authors: defineCollection({
            fields: {
              name: text({ required: true }),
              post: relation("posts"),
            },
          }),
        },
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_depth"),
      );

      const admin = actorWith("admin");
      const post = await cms.api.posts.create({
        data: { title: "Payroll", salary: 1000 },
        actor: admin,
      });
      const author = await cms.api.authors.create({
        data: { name: "A", post: String(post?.id) },
        actor: admin,
      });

      const viewer = await cms.api.authors.findById(String(author?.id), {
        depth: 1,
        actor: actorWith("viewer"),
      });
      const related = viewer?.post as unknown as JsonObject;
      expect(related.title).toBe("Payroll");
      expect("salary" in related).toBe(false);
      await cms.close();
    });

    test("a Where from a rule still reaches the query under rbac", async () => {
      const adapter = await entry.create();
      const fixture = collections();
      const cms = heyoCms({
        rbac: { roles },
        database: () => adapter,
        collections: {
          ...fixture,
          posts: defineCollection({
            ...fixture.posts,
            access: {
              read: ({ actor }) =>
                permits(actor, "posts:read") ? true : eq("status", "published"),
            },
          }),
        },
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_where"),
      );

      const admin = actorWith("admin");
      await cms.api.posts.create({ data: { title: "A" }, actor: admin });
      await cms.api.posts.create({
        data: { title: "B", status: "published" },
        actor: admin,
      });

      const anonymous = await cms.api.posts.find({ count: true });
      expect(anonymous.docs.map((doc) => doc.title)).toEqual(["B"]);
      expect(anonymous.totalDocs).toBe(1);
      await cms.close();
    });
  });
}

runRbacSuite({
  name: "sqlite",
  create: () => sqlite(new Database(":memory:")),
});

runRbacSuite({
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

runRbacSuite({
  name: "mongodb (in-process)",
  create: () => mongodb(memoryMongo(), { transactions: false }),
});
