import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { cmsUsers, totpCode } from "../src/auth";
import { defineCollection, heyoCms, systemActor } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { Outbox } from "../src/engine/outbox";
import { CmsError } from "../src/errors";
import { relation, text } from "../src/fields";
import { eq } from "../src/query";
import { emptySnapshot } from "../src/schema/snapshot";
import type { CmsInstance } from "../src/types/instance";
import type { DatabaseAdapter } from "../src/types/database";
import type { CmsEvent } from "../src/types/events";

const admin = systemActor();
async function migrate(cms: CmsInstance, adapter: DatabaseAdapter) {
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "audit"),
  );
}

async function fixture() {
  const adapter = sqlite(new Database(":memory:"));
  const cms = heyoCms({
    database: adapter,
    admin: { auth: cmsUsers({ methods: ["password"], twoFactor: true }) },
    rbac: { roles: { admin: ["*"] } },
    collections: {
      private: defineCollection({ fields: { title: text() } }),
      filtered: defineCollection({
        fields: { title: text() },
        access: { read: ({ actor }) => (actor ? true : eq("title", "public")) },
      }),
      public: defineCollection({
        access: { read: () => true },
        fields: {
          title: text(),
          secret: text({
            localized: true,
            access: { read: ({ actor }) => actor !== null },
          }),
          private: relation("private"),
          filtered: relation("filtered"),
          author: relation("cms_users"),
          token: relation("cms_tokens"),
          parent: relation("public"),
        },
      }),
    },
  });
  await migrate(cms, adapter);
  return { cms, adapter };
}

test("depth applies target RBAC/filters and never exposes system secrets", async () => {
  const { cms, adapter } = await fixture();
  try {
    const user = await cms.auth.users.create({
      email: "private@example.com",
      name: "Public byline",
      password: "correct horse battery",
      roles: ["admin"],
    });
    const secret = await cms.api.private.create({
      data: { title: "classified" },
      actor: admin,
    });
    const filtered = await cms.api.filtered.create({
      data: { title: "classified" },
      actor: admin,
    });
    const doc = await cms.api.public.create({
      data: {
        title: "visible",
        private: secret!.id,
        filtered: filtered!.id,
        author: user.id,
        token: "tok_secret",
      },
      actor: admin,
    });
    // A system relation is legal configuration, but grants no table-read access.
    await adapter.transaction((tx) =>
      adapter.mutate(tx, {
        kind: "insert",
        table: "cms_tokens",
        values: {
          id: "tok_secret",
          type: "invite",
          token_hash: "SECRET_HASH",
          user_id: user.id,
          email: user.email,
          data: {},
          expires_at: new Date(Date.now() + 60000),
          consumed_at: null,
          created_at: new Date(),
        },
      }),
    );
    const read = await cms.api.public.findById(String(doc!.id), { depth: 2 });
    expect(read?.private).toBe(secret!.id);
    expect(read?.filtered).toBe(filtered!.id);
    expect(read?.author as unknown).toEqual({
      id: user.id,
      name: "Public byline",
    });
    expect(read?.token).toBe("tok_secret");
    expect(JSON.stringify(read)).not.toContain("classified");
    expect(JSON.stringify(read)).not.toContain("passwordHash");
    expect(JSON.stringify(read)).not.toContain("SECRET_HASH");
    await cms.api.filtered.update({
      id: String(filtered!.id),
      data: { title: "public" },
      actor: admin,
    });
    const allowed = await cms.api.public.findById(String(doc!.id), {
      depth: 2,
    });
    expect(allowed?.filtered).toMatchObject({ title: "public" });
  } finally {
    await cms.close();
  }
});

test("self-relations produce a finite JSON tree, not circular objects", async () => {
  const { cms } = await fixture();
  try {
    const doc = await cms.api.public.create({
      data: { title: "self" },
      actor: admin,
    });
    await cms.api.public.update({
      id: String(doc!.id),
      data: { parent: doc!.id },
      actor: admin,
    });
    const read = await cms.api.public.findById(String(doc!.id), { depth: 3 });
    expect(() => JSON.stringify(read)).not.toThrow();
    expect(JSON.stringify(read).match(/"title":"self"/g)).toHaveLength(4);
  } finally {
    await cms.close();
  }
});

test("scheduled patches and fallback metadata do not bypass field read access", async () => {
  const { cms } = await fixture();
  try {
    const doc = await cms.api.public.create({
      data: { title: "visible", secret: "current secret" },
      actor: admin,
    });
    await cms.api.public.schedule({
      id: String(doc!.id),
      at: new Date(Date.now() + 60000).toISOString(),
      data: { secret: "future secret" },
      actor: admin,
    });
    const read = await cms.api.public.findById(String(doc!.id));
    expect(read).not.toHaveProperty("secret");
    expect(read?.scheduledPatch).toEqual({});
    expect(JSON.stringify(read)).not.toContain("future secret");
  } finally {
    await cms.close();
  }
});

test("five wrong 2FA codes permanently exhaust a challenge on transactional SQLite", async () => {
  const { cms } = await fixture();
  try {
    const user = await cms.auth.users.create({
      email: "two@example.com",
      password: "correct horse battery",
      roles: ["admin"],
    });
    const setup = await cms.auth.twoFactor.begin(user.id);
    await cms.auth.twoFactor.enable({
      userId: user.id,
      code: await totpCode(setup.secret),
    });
    await expect(cms.auth.twoFactor.begin(user.id)).rejects.toThrow(
      /existing authenticator/,
    );
    const signed = await cms.auth.password.signIn({
      email: user.email,
      password: "correct horse battery",
    });
    if (signed.status !== "two-factor-required")
      throw Error("expected challenge");
    for (let i = 0; i < 5; i++) {
      await expect(
        cms.auth.twoFactor.complete({
          challenge: signed.challenge,
          code: "invalid",
        }),
      ).rejects.toThrow(/not valid/);
    }
    await expect(
      cms.auth.twoFactor.complete({
        challenge: signed.challenge,
        code: await totpCode(setup.secret),
      }),
    ).rejects.toThrow(/already been used/);
  } finally {
    await cms.close();
  }
});

test("cross-origin cookie writes are denied, and a blocked user gets a Response", async () => {
  const { cms } = await fixture();
  try {
    const user = await cms.auth.users.create({
      email: "blocked@example.com",
      password: "correct horse battery",
      roles: ["admin"],
    });
    const signed = await cms.auth.password.signIn({
      email: user.email,
      password: "correct horse battery",
    });
    if (signed.status !== "signed-in") throw Error("expected session");
    const response = await cms.handler(
      new Request("https://cms.example.com/api/heyo-cms/public", {
        method: "POST",
        headers: {
          cookie: `heyo-cms.session=${signed.token}`,
          origin: "https://evil.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "CSRF" }),
      }),
    );
    expect(response.status).toBe(403);
    cms.auth.actorFromRequest = async () => {
      throw CmsError.forbidden("blocked");
    };
    const blocked = await cms.handler(
      new Request("https://cms.example.com/api/heyo-cms/public", {
        headers: { authorization: `Bearer ${signed.token}` },
      }),
    );
    expect(blocked.status).toBe(403);
  } finally {
    await cms.close();
  }
});

test("outbox reclaims an abandoned delivery and fences the old worker", async () => {
  const { cms, adapter } = await fixture();
  try {
    let time = Date.now();
    const seen: string[] = [];
    let unblock!: () => void;
    const wait = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const first = new Outbox(
      adapter,
      async () => {
        await wait;
        throw Error("old worker failed");
      },
      { leaseMs: 10, now: () => new Date(time) },
    );
    const second = new Outbox(
      adapter,
      async (e) => {
        seen.push(e.id);
      },
      { leaseMs: 10, now: () => new Date(time) },
    );
    await adapter.transaction((tx) =>
      first.append(tx, [{ type: "audit.test", data: {}, previous: null }], {
        actor: null,
      }),
    );
    const pending = first.drain();
    // Wait until claim has committed and dispatch is awaiting the latch.
    await new Promise((resolve) => setTimeout(resolve, 10));
    time += 11;
    expect(await second.drain()).toBe(1);
    unblock();
    await pending;
    const rows = await adapter.transaction((tx) =>
      adapter.query(tx, { table: "outbox" }),
    );
    expect(rows[0]?.status).toBe("delivered");
    expect(rows[0]?.attempts).toBe(2);
    expect(seen).toHaveLength(1);
  } finally {
    await cms.close();
  }
});

test("outbox does not overtake an earlier retry for the same document", async () => {
  const { cms, adapter } = await fixture();
  try {
    let time = Date.now();
    let fail = true;
    const seen: CmsEvent[] = [];
    const worker = new Outbox(
      adapter,
      async (event) => {
        if (fail) {
          fail = false;
          throw Error("retry");
        }
        seen.push(event);
      },
      { now: () => new Date(time), backoff: () => 100 },
    );
    await adapter.transaction((tx) =>
      worker.append(
        tx,
        [
          { type: "audit.first", data: {}, previous: null },
          { type: "audit.second", data: {}, previous: null },
        ],
        { actor: null, collection: "public", documentId: "doc" },
      ),
    );
    await worker.drain();
    expect(seen).toHaveLength(0);
    time += 101;
    expect(await worker.drain()).toBe(2);
    expect(seen.map((e) => e.type)).toEqual(["audit.first", "audit.second"]);
  } finally {
    await cms.close();
  }
});
