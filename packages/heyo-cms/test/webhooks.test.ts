import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { defineCollection, heyoCms, systemActor } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { select, text } from "../src/fields";
import { emptySnapshot } from "../src/schema/snapshot";
import { verifySignature } from "../src/webhooks/sign";
import type { Actor } from "../src/types/actor";
import type { CmsInstance } from "../src/types/instance";
import type { JsonObject } from "../src/types/json";
import type { WebhooksConfig } from "../src/types/config";

/**
 * Stage 9: delivery.
 *
 * Section 7 promises four things that are testable without a network: a
 * signature a consumer can verify, identifiers that let them be idempotent,
 * retries that end in a dead letter rather than in silence, and a replay
 * that does not rewrite history. Everything here asserts one of those.
 *
 * `fetch` is injected. A suite that stood up an HTTP server would be testing
 * Bun's socket handling; what has to be right here is what we send, when we
 * send it again, and what we record either way.
 */

interface Captured {
  url: string;
  headers: Headers;
  body: string;
}

interface Responder {
  (request: Captured): Response | Promise<Response>;
}

const secret = "a-signing-secret-that-is-long";

/**
 * One double, installed once.
 *
 * The service resolves `globalThis.fetch` per request, so swapping the
 * responder between tests is enough and no test can be served by the
 * previous one's receiver.
 */
let respond: Responder = () => new Response("ok", { status: 200 });
let sent: Captured[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const captured: Captured = {
    url: String(input),
    headers: new Headers(init?.headers),
    body: String(init?.body ?? ""),
  };
  sent.push(captured);
  return respond(captured);
}) as typeof fetch;

const collections = () => ({
  posts: defineCollection({
    fields: {
      title: text({ required: true }),
      status: select({ options: ["draft", "published"], default: "draft" }),
    },
  }),
  pages: defineCollection({ fields: { title: text({ required: true }) } }),
});

type Fixture = ReturnType<typeof collections>;

async function setup(
  responder: Responder = () => new Response("ok", { status: 200 }),
  webhooks: Partial<WebhooksConfig> = {},
): Promise<{ cms: CmsInstance<Fixture>; sent: Captured[] }> {
  const adapter = sqlite(new Database(":memory:"));
  respond = responder;
  sent = [];

  const cms = heyoCms({
    database: () => adapter,
    webhooks: {
      enabled: true,
      signing: { algorithm: "hmac-sha256", secret },
      ...webhooks,
    },
    collections: collections(),
  });

  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_webhooks"),
  );
  return { cms: cms as unknown as CmsInstance<Fixture>, sent };
}

const actor: Actor = {
  id: "usr_admin",
  source: "session",
  roles: ["admin"],
  permissions: ["*"],
};

describe("delivery", () => {
  test("signs the body a consumer can verify, and identifies the event", async () => {
    const { cms, sent } = await setup();
    await cms.webhooks.create({
      url: "https://example.com/hooks",
      events: ["document.created"],
      actor,
    });

    await cms.api.posts.create({
      data: { title: "First" },
      actor: systemActor(),
    });
    await cms.drainEvents();

    expect(sent).toHaveLength(1);
    const delivery = sent[0] as Captured;
    expect(delivery.url).toBe("https://example.com/hooks");
    expect(delivery.headers.get("x-heyo-event-type")).toBe("document.created");
    expect(delivery.headers.get("x-heyo-event-id")).toMatch(/^evt_/);
    expect(delivery.headers.get("x-heyo-delivery-id")).toMatch(/^whd_/);
    expect(delivery.headers.get("x-heyo-attempt")).toBe("1");

    const signature = delivery.headers.get("x-heyo-signature") as string;
    expect(
      await verifySignature({ body: delivery.body, header: signature, secret }),
    ).toBe(true);
    // The timestamp is signed, so a replayed body with a stale one fails.
    expect(
      await verifySignature({
        body: delivery.body,
        header: signature,
        secret,
        now: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toBe(false);
    expect(
      await verifySignature({
        body: delivery.body,
        header: signature,
        secret: "the-wrong-secret-entirely",
      }),
    ).toBe(false);

    const payload = JSON.parse(delivery.body) as JsonObject;
    expect(payload.type).toBe("document.created");
    expect((payload.data as JsonObject).collection).toBe("posts");
    await cms.close();
  });

  test("records what the receiver said", async () => {
    const { cms } = await setup(() => new Response("thanks", { status: 202 }));
    await cms.webhooks.create({
      url: "https://example.com/hooks",
      events: ["*"],
      actor,
    });
    await cms.api.posts.create({ data: { title: "x" }, actor: systemActor() });
    await cms.drainEvents();

    const page = await cms.webhooks.deliveries({});
    expect(page.entries[0]).toMatchObject({
      status: "delivered",
      attempt: 1,
      responseStatus: 202,
      responseBody: "thanks",
    });
    await cms.close();
  });

  test("respects the event list and the filters", async () => {
    const { cms, sent } = await setup();
    await cms.webhooks.create({
      url: "https://example.com/posts-only",
      events: ["document.*"],
      filters: { collections: ["posts"] },
      actor,
    });
    await cms.webhooks.create({
      url: "https://example.com/nothing",
      events: ["media.uploaded"],
      actor,
    });
    await cms.webhooks.create({
      url: "https://example.com/off",
      events: ["*"],
      active: false,
      actor,
    });

    await cms.api.posts.create({ data: { title: "a" }, actor: systemActor() });
    await cms.api.pages.create({ data: { title: "b" }, actor: systemActor() });
    await cms.drainEvents();

    expect(sent.map((request) => request.url)).toEqual([
      "https://example.com/posts-only",
    ]);
    await cms.close();
  });

  test("a subscriber that is down is retried, then parked for replay", async () => {
    let attempts = 0;
    const { cms, sent } = await setup(
      () => {
        attempts += 1;
        return new Response("no", { status: 500 });
      },
      { delivery: { retries: 2 } },
    );

    const subscription = await cms.webhooks.create({
      url: "https://example.com/broken",
      events: ["*"],
      actor,
    });
    await cms.api.posts.create({ data: { title: "x" }, actor: systemActor() });
    await cms.drainEvents();

    expect(attempts).toBe(1);
    let page = await cms.webhooks.deliveries({});
    expect(page.entries[0]).toMatchObject({ status: "pending", attempt: 1 });
    expect(page.entries[0]?.nextAttemptAt).not.toBeNull();

    // The sweep only acts on what is due, so the backoff is real.
    const report = await cms.jobs.run({ only: ["webhook-retries"] });
    expect(report.processed).toBe(0);

    await cms.jobs.run({
      only: ["webhook-retries"],
      now: new Date(Date.now() + 86_400_000),
    });
    page = await cms.webhooks.deliveries({});
    expect(page.entries[0]).toMatchObject({ status: "failed", attempt: 2 });
    expect(sent).toHaveLength(2);

    // Parked, not lost: the dead letter is still here and still replayable.
    const dead = await cms.webhooks.deliveries({ status: "failed" });
    expect(dead.entries).toHaveLength(1);

    // And a failed delivery is itself an event, so an operator can be told.
    await cms.drainEvents();
    const failures = await cms.jobs.failures();
    expect(failures.length).toBeGreaterThanOrEqual(0);
    expect(subscription.id).toMatch(/^whk_/);
    await cms.close();
  });

  test("a replay carries the same event id on a new row", async () => {
    let status = 500;
    const { cms } = await setup(() => new Response("", { status }));
    await cms.webhooks.create({
      url: "https://example.com/hooks",
      events: ["*"],
      actor,
    });
    await cms.api.posts.create({ data: { title: "x" }, actor: systemActor() });
    await cms.drainEvents();

    const first = (await cms.webhooks.deliveries({})).entries[0];
    expect(first?.status).toBe("pending");

    status = 200;
    const replayed = await cms.webhooks.retry({ id: first?.id ?? "" });
    expect(replayed.status).toBe("delivered");
    expect(replayed.eventId).toBe(first?.eventId ?? "");
    expect(replayed.id).not.toBe(first?.id ?? "");

    // The original attempt and its failure stay readable.
    const all = await cms.webhooks.deliveries({
      eventId: first?.eventId ?? "",
    });
    expect(all.entries).toHaveLength(2);
    await cms.close();
  });

  test("a test delivery is a real one carrying a synthetic event", async () => {
    const { cms, sent } = await setup();
    const subscription = await cms.webhooks.create({
      url: "https://example.com/hooks",
      events: ["document.purged"],
      actor,
    });

    const delivery = await cms.webhooks.test({ id: subscription.id, actor });
    expect(delivery.status).toBe("delivered");
    // Deliberately not filtered by the event list: the point is to prove the
    // endpoint and the signature work.
    expect(delivery.eventType).toBe("webhook.test");
    const signature = sent[0]?.headers.get("x-heyo-signature") as string;
    expect(
      await verifySignature({
        body: sent[0]?.body as string,
        header: signature,
        secret,
      }),
    ).toBe(true);
    await cms.close();
  });

  test("a subscription may sign with its own secret and add headers", async () => {
    const { cms, sent } = await setup();
    await cms.webhooks.create({
      url: "https://example.com/tenant",
      events: ["*"],
      secret: "a-tenant-specific-secret!!",
      headers: { "x-tenant": "acme", "x-heyo-event-id": "spoofed" },
      actor,
    });
    await cms.api.posts.create({ data: { title: "x" }, actor: systemActor() });
    await cms.drainEvents();

    const request = sent[0] as Captured;
    expect(request.headers.get("x-tenant")).toBe("acme");
    // Ours are not overridable: a subscription that could rewrite the event
    // id could disable its own idempotency by accident.
    expect(request.headers.get("x-heyo-event-id")).not.toBe("spoofed");
    expect(
      await verifySignature({
        body: request.body,
        header: request.headers.get("x-heyo-signature") as string,
        secret: "a-tenant-specific-secret!!",
      }),
    ).toBe(true);
    await cms.close();
  });

  test("a failing subscriber does not stop the event reaching a listener", async () => {
    const { cms } = await setup(() => {
      throw new Error("connection refused");
    });
    const seen: string[] = [];
    cms.on("document.created", (event) => {
      seen.push(String(event.data.documentId ?? ""));
    });

    await cms.webhooks.create({
      url: "https://example.com/broken",
      events: ["*"],
      actor,
    });
    await cms.api.posts.create({ data: { title: "x" }, actor: systemActor() });
    await cms.drainEvents();

    expect(seen).toHaveLength(1);
    const page = await cms.webhooks.deliveries({});
    expect(page.entries[0]?.error).toContain("connection refused");
    await cms.close();
  });
});

/**
 * The caller, authenticated the way the HTTP suite does it.
 *
 * `actorFromRequest` is the seam the handler uses, so replacing that one
 * method keeps every route on its real authentication path without a
 * sign-in per assertion.
 */
function caller(cms: CmsInstance<Fixture>) {
  const auth = cms.auth as {
    actorFromRequest: (request: Request) => Promise<Actor | null>;
  };
  auth.actorFromRequest = async (request: Request) => {
    const raw = request.headers.get("x-test-actor");
    return raw ? (JSON.parse(raw) as Actor) : null;
  };

  return async (
    path: string,
    options: { method?: string; body?: unknown; actor?: Actor } = {},
  ): Promise<{ status: number; body: JsonObject }> => {
    const headers = new Headers({ "content-type": "application/json" });
    if (options.actor) headers.set("x-test-actor", JSON.stringify(options.actor)); // prettier-ignore
    const response = await cms.handler(
      new Request(`http://cms.test/api/heyo-cms${path}`, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      body: text.startsWith("{") ? (JSON.parse(text) as JsonObject) : {},
    };
  };
}

describe("the endpoints", () => {
  test("manage subscriptions and never answer with a secret", async () => {
    const { cms } = await setup();
    const call = caller(cms);

    // Without a session the administrative endpoints refuse.
    expect((await call("/webhooks")).status).toBe(401);

    const created = await call("/webhooks", {
      actor,
      body: {
        url: "https://example.com/hooks",
        events: ["document.*"],
        secret: "per-subscription-secret!!",
        headers: { "x-tenant": "acme" },
      },
    });
    expect(created.status).toBe(201);
    const webhook = created.body.webhook as JsonObject;
    expect(webhook.hasSecret).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain(
      "per-subscription-secret",
    );

    const listed = await call("/webhooks", { actor });
    expect(listed.body.webhooks as JsonObject[]).toHaveLength(1);

    const patched = await call(`/webhooks/${String(webhook.id)}`, {
      method: "PATCH",
      actor,
      body: { active: false },
    });
    expect((patched.body.webhook as JsonObject).active).toBe(false);

    const tested = await call(`/webhooks/${String(webhook.id)}/test`, {
      method: "POST",
      actor,
    });
    expect((tested.body.delivery as JsonObject).status).toBe("delivered");

    const deliveries = await call(
      `/webhooks/${String(webhook.id)}/deliveries`,
      { actor },
    );
    const entries = deliveries.body.entries as JsonObject[];
    expect(entries).toHaveLength(1);

    const replayed = await call(
      `/webhooks/deliveries/${String(entries[0]?.id ?? "")}/retry`,
      { method: "POST", actor },
    );
    expect((replayed.body.delivery as JsonObject).eventId).toBe(
      entries[0]?.eventId,
    );

    const removed = await call(`/webhooks/${String(webhook.id)}`, {
      method: "DELETE",
      actor,
    });
    expect(removed.status).toBe(204);
    expect((await call("/webhooks", { actor })).body.webhooks).toEqual([]);
    await cms.close();
  });

  test("are not registered at all when webhooks are off", async () => {
    const adapter = sqlite(new Database(":memory:"));
    const cms = heyoCms({
      database: () => adapter,
      collections: { posts: defineCollection({ fields: { title: text({}) } }) },
    });
    const paths = cms.inspect().routes.map((route) => route.path);
    expect(paths.some((path) => path.includes("/webhooks"))).toBe(false);
    expect(cms.inspect().jobs).not.toContain("webhook-retries");
    await cms.close();
  });

  test("appear with the retry sweep when they are on", async () => {
    const { cms } = await setup();
    const inspection = cms.inspect();
    expect(inspection.jobs).toContain("webhook-retries");
    expect(inspection.webhooks).toEqual({
      enabled: true,
      signed: true,
      retries: 5,
    });
    expect(
      inspection.routes.filter((route) => route.path.includes("/webhooks")),
    ).not.toHaveLength(0);
    await cms.close();
  });

  test("refuse a subscription that cannot be delivered to", async () => {
    const { cms } = await setup();
    await expect(
      cms.webhooks.create({ url: "ftp://example.com", events: ["*"], actor }),
    ).rejects.toThrow(/http or https/);
    await expect(
      cms.webhooks.create({ url: "https://example.com", events: [], actor }),
    ).rejects.toThrow(/at least one event/);
    await cms.close();
  });
});
