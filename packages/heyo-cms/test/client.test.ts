import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { cmsUsers } from "../src/auth/config";
import { heyoCmsClient as publicHeyoCmsClient } from "../src/client";
import { heyoCmsClient } from "../src/client/index";
import { defineCollection, defineGlobal, heyoCms } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { CmsError } from "../src/errors";
import { boolean, number, select, text } from "../src/fields";
import { and, eq, gte, orderBy } from "../src/query";
import { emptySnapshot } from "../src/schema/snapshot";
import { memory } from "../src/storage/local";
import type { CmsInstance } from "../src/types/instance";
import type { CmsPlugin } from "../src/types/plugin";
import type { TokenDelivery } from "../src/types/config";
import { pngFixture } from "./images";

/**
 * The typed client, against the real handler.
 *
 * Not against a mock: the client's whole job is to agree with the routes, and
 * a test that stubs `fetch` would only prove the client agrees with itself.
 * `fetch` here is `cms.handler`, which is exactly what a deployment puts
 * behind a socket — so this file is also the end-to-end test of sign-in, the
 * cookie, the filter AST crossing the wire and the 204 convention.
 */

const collections = () => ({
  posts: defineCollection({
    fields: {
      title: text({ required: true, localized: true }),
      handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
      status: select({ options: ["draft", "published"], default: "draft" }),
      views: number({ integer: true }),
    },
    access: { read: () => true },
  }),
});

const globals = () => ({
  settings: defineGlobal({
    fields: {
      siteName: text({ required: true, default: "Acme" }),
      maintenance: boolean({ default: false }),
    },
  }),
});

type Fixture = ReturnType<typeof collections>;
type Globals = ReturnType<typeof globals>;

// This is exactly what a generated `heyo-cms.client.d.ts` does for an
// application. The no-argument public factory must see it, while the core
// implementation remains independently usable in its own tests.
declare module "../src/client" {
  interface HeyoCmsClientRegistry {
    cms: CmsInstance<Fixture, Globals>;
  }
}

const delivered: TokenDelivery[] = [];

async function setup(
  options: { plugins?: CmsPlugin<unknown>[] } = {},
): Promise<{
  cms: CmsInstance<Fixture, Globals>;
  fetchImpl: typeof fetch;
}> {
  const adapter = sqlite(new Database(":memory:"));
  const cms = heyoCms({
    database: () => adapter,
    admin: {
      auth: cmsUsers({
        methods: ["password", "magic-link"],
        apiKeys: { enabled: true, scopes: ["read", "write"] },
        deliverToken: (message) => {
          delivered.push(message);
        },
      }),
    },
    uploads: { storage: memory(), limits: { accept: ["image/*"] } },
    collections: collections(),
    globals: globals(),
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
  });
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_client"),
  );

  // The client is handed the handler as its transport, cookies included: the
  // one place a browser's automatic cookie jar has to be imitated, because
  // `Request`/`Response` do not carry one.
  const jar = new Map<string, string>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    if (jar.size > 0 && !request.headers.has("cookie")) {
      request.headers.set(
        "cookie",
        [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    const response = await cms.handler(request);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const [pair = ""] = setCookie.split(";");
      const [name = "", value = ""] = pair.split("=");
      if (value.length === 0 || setCookie.includes("Max-Age=0"))
        jar.delete(name); // prettier-ignore
      else jar.set(name, value);
    }
    return response;
  }) as typeof fetch;

  return { cms, fetchImpl };
}

function client(
  cms: CmsInstance<Fixture, Globals>,
  fetchImpl: typeof fetch,
  options: { token?: string } = {},
) {
  return heyoCmsClient<typeof cms>({
    baseUrl: "http://cms.test/api/heyo-cms",
    fetch: fetchImpl,
    ...(options.token === undefined ? {} : { token: options.token }),
  });
}

describe("typed client", () => {
  test("defaults to the same-origin mount without options", async () => {
    const { cms, fetchImpl } = await setup();
    const previousLocation = Object.getOwnPropertyDescriptor(
      globalThis,
      "location",
    );
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("http://cms.test/"),
    });

    try {
      // Constructing the conventional client needs neither a URL nor browser
      // globals. The latter are only needed when it makes its first request.
      expect(publicHeyoCmsClient().baseUrl).toBe("/api/heyo-cms");

      const api = publicHeyoCmsClient({ fetch: fetchImpl });
      expect(api.baseUrl).toBe("/api/heyo-cms");
      expect((await api.posts.find()).docs).toEqual([]);
    } finally {
      if (previousLocation) {
        Object.defineProperty(globalThis, "location", previousLocation);
      } else {
        delete (globalThis as { location?: Location }).location;
      }
      await cms.close();
    }
  });

  test("uses the registered CMS type without an explicit generic", () => {
    const api = publicHeyoCmsClient();
    type Assert<T extends true> = T;
    type Equal<T, U> =
      (<V>() => V extends T ? 1 : 2) extends <V>() => V extends U ? 1 : 2
        ? true
        : false;
    type RegistryCms = import("../src/client").HeyoCmsClientRegistry["cms"];
    type RegistryIsFixture = Assert<
      Equal<RegistryCms, CmsInstance<Fixture, Globals>>
    >;
    type Post = NonNullable<Awaited<ReturnType<typeof api.posts.findById>>>;
    type RegisteredTitle = Assert<Equal<Post["title"], string>>;
    void (undefined as unknown as RegistryIsFixture);
    void (undefined as unknown as RegisteredTitle);

    expect(api.baseUrl).toBe("/api/heyo-cms");
  });

  test("signs in, carries the session and signs out", async () => {
    const { cms, fetchImpl } = await setup();
    await cms.auth.users.create({
      email: "editor@acme.test",
      password: "correct-horse-battery",
      roles: ["admin"],
    });
    const api = client(cms, fetchImpl);

    const anonymous = await api.auth.session();
    expect(anonymous.user).toBeNull();

    const signedIn = await api.auth.signIn({
      email: "editor@acme.test",
      password: "correct-horse-battery",
    });
    expect(signedIn.status).toBe("signed-in");

    // The cookie alone now authenticates: no token was passed to the client.
    const session = await api.auth.session();
    expect(session.user?.email).toBe("editor@acme.test");

    await api.auth.signOut();
    expect((await api.auth.session()).user).toBeNull();

    // A wrong password is a CmsError with the status and the code intact.
    await expect(
      api.auth.signIn({ email: "editor@acme.test", password: "nope" }),
    ).rejects.toMatchObject({ status: 401 });
    await cms.close();
  });

  test("claims an empty CMS from the sign-in screen, once", async () => {
    const { cms, fetchImpl } = await setup();
    const api = client(cms, fetchImpl);

    // What the panel reads before it decides which form to draw.
    const panel = async (): Promise<{ auth: { setupRequired: boolean } }> =>
      (await (
        await fetchImpl("http://cms.test/api/heyo-cms/panel")
      ).json()) as { auth: { setupRequired: boolean } };
    expect((await panel()).auth.setupRequired).toBe(true);

    const claimed = await api.auth.claimFirstAccount({
      email: "owner@acme.test",
      password: "correct-horse-battery",
      name: "Owner",
    });
    expect(claimed.status).toBe("signed-in");

    // The cookie came back with it: claiming is signing in, not a detour
    // through a password nobody chose.
    expect((await api.auth.session()).user?.email).toBe("owner@acme.test");

    expect((await panel()).auth.setupRequired).toBe(false);

    // And the door is shut, in the only way that matters: the route refuses.
    await expect(
      api.auth.claimFirstAccount({
        email: "squatter@acme.test",
        password: "correct-horse-battery",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await cms.close();
  });

  test("an API key authenticates the same client", async () => {
    const { cms, fetchImpl } = await setup();
    const user = await cms.auth.users.create({
      email: "machine@acme.test",
      password: "correct-horse-battery",
      roles: ["admin"],
    });
    const key = await cms.auth.apiKeys.create({
      name: "deploy",
      userId: user.id,
      scopes: ["write"],
    });

    const api = client(cms, fetchImpl, { token: key.key });
    const created = await api.posts.create({
      data: { title: "From a key", handle: "from-a-key" },
    });
    expect(created?.title).toBe("From a key");

    const session = await api.auth.session();
    expect(session.actor).toMatchObject({ source: "api-key" });
    await cms.close();
  });

  test("CRUD, the filter AST and paging agree with the local API", async () => {
    const { cms, fetchImpl } = await setup();
    const api = client(cms, fetchImpl);

    const statuses = ["draft", "published", "published"] as const;
    for (const [index, status] of statuses.entries()) {
      await cms.api.posts.create({
        data: { title: `Post ${index}`, handle: `post-${index}`, status, views: index }, // prettier-ignore
      });
    }

    const page = await api.posts.find({
      where: and(eq("status", "published"), gte("views", 1)),
      orderBy: [orderBy("views", "desc")],
      limit: 1,
      count: true,
    });
    expect(page.docs.map((doc) => doc.views)).toEqual([2]);
    expect(page.totalDocs).toBe(2);
    expect(page.hasNextPage).toBe(true);

    const next = await api.posts.find({
      where: and(eq("status", "published"), gte("views", 1)),
      orderBy: [orderBy("views", "desc")],
      limit: 1,
      cursor: page.cursor ?? undefined,
    });
    expect(next.docs.map((doc) => doc.views)).toEqual([1]);

    const first = page.docs[0];
    const read = await api.posts.findById(String(first?.id));
    expect(read?.title).toBe("Post 2");

    const updated = await api.posts.update({
      id: String(first?.id),
      data: { title: "Renamed" },
    });
    expect(updated?.title).toBe("Renamed");

    const trashed = await api.posts.delete({ id: String(first?.id) });
    expect(trashed?.deletedAt).not.toBeNull();
    const restored = await api.posts.restore({ id: String(first?.id) });
    expect(restored?.deletedAt).toBeNull();

    const bin = await api.trash.list();
    expect(bin.entries.length).toBe(0);
    await cms.close();
  });

  test("a stopped write comes back as null, like the local API", async () => {
    const adapter = sqlite(new Database(":memory:"));
    const cms = heyoCms({
      database: () => adapter,
      collections: collections(),
      databaseHooks: { posts: { create: { before: () => false } } },
    });
    adapter.useSchema(cms.schema);
    await adapter.applyMigration(
      adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_stop"),
    );

    const api = heyoCmsClient<typeof cms>({
      baseUrl: "http://cms.test/api/heyo-cms",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        cms.handler(new Request(input as RequestInfo, init))) as typeof fetch,
    });

    expect(await api.posts.create({ data: { title: "Never" } })).toBeNull();
    expect(await cms.api.posts.create({ data: { title: "Never" } })).toBeNull();
    await cms.close();
  });

  test("a global round-trips, and a missing document is null", async () => {
    const { cms, fetchImpl } = await setup();
    const api = client(cms, fetchImpl);

    const settings = await api.globals.settings.get();
    expect(settings.siteName).toBe("Acme");
    const saved = await api.globals.settings.update({ data: { maintenance: true } }); // prettier-ignore
    expect(saved?.maintenance).toBe(true);

    await expect(api.posts.findById("doc_missing")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await cms.close();
  });

  test("uploads a file and builds a variant URL without a request", async () => {
    const { cms, fetchImpl } = await setup();
    const user = await cms.auth.users.create({
      email: "media@acme.test",
      password: "correct-horse-battery",
      roles: ["admin"],
    });
    const key = await cms.auth.apiKeys.create({ name: "media", userId: user.id }); // prettier-ignore
    const api = client(cms, fetchImpl, { token: key.key });

    const file = await api.media.upload({
      file: pngFixture(64, 64),
      filename: "logo.png",
      contentType: "image/png",
      alt: "The logo",
    });
    expect(file.width).toBe(64);
    expect(file.alt.en).toBe("The logo");

    expect(api.media.url(file.id)).toBe(
      `http://cms.test/api/heyo-cms/media/${file.id}/original`,
    );
    expect((await api.media.list()).docs.length).toBe(1);
    expect(await api.media.usages(file.id)).toEqual([]);
    await cms.close();
  });

  test("a magic link reaches the delivery function, not the response", async () => {
    delivered.length = 0;
    const { cms, fetchImpl } = await setup();
    await cms.auth.users.create({ email: "link@acme.test", roles: ["admin"] });
    const api = client(cms, fetchImpl);

    const answer = await api.auth.magicLink({ email: "link@acme.test" });
    expect(answer).toEqual({ status: "sent" });
    expect(JSON.stringify(answer)).not.toContain("token");

    const message = delivered.at(-1);
    expect(message?.type).toBe("magic-link");
    expect(message?.url).toContain("/api/heyo-cms/admin/magic-link?token=");

    const signedIn = await api.auth.verifyMagicLink({
      token: message?.token ?? "",
    });
    expect(signedIn.status).toBe("signed-in");

    // An unknown address is answered identically, so the endpoint cannot be
    // used to find out who the editors are.
    const stranger = await api.auth.magicLink({ email: "nobody@acme.test" });
    expect(stranger).toEqual({ status: "sent" });
    expect(delivered.length).toBe(1);
    await cms.close();
  });

  test("a plugin extends the client, and a collision is refused", async () => {
    const analytics: CmsPlugin<{
      analytics: { pageviews: () => Promise<unknown> };
    }> = {
      id: "analytics",
      routes: [
        {
          method: "GET",
          path: "/analytics/pageviews",
          handler: (context) => context.json({ views: 42 }),
        },
      ],
      client: ({ request }) => ({
        analytics: { pageviews: () => request("/analytics/pageviews") },
      }),
    };

    const { cms, fetchImpl } = await setup({ plugins: [analytics] });
    const api = publicHeyoCmsClient({
      baseUrl: "http://cms.test/api/heyo-cms",
      fetch: fetchImpl,
      plugins: [analytics],
    });

    expect(await api.analytics.pageviews()).toEqual({ views: 42 });

    const rogue: CmsPlugin<{ media: unknown }> = {
      id: "rogue",
      client: () => ({ media: "mine" }),
    };
    expect(() =>
      publicHeyoCmsClient({
        baseUrl: "http://cms.test/api/heyo-cms",
        fetch: fetchImpl,
        plugins: [rogue],
      }),
    ).toThrow(CmsError);
    await cms.close();
  });
});
