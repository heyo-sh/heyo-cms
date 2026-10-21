import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { defineCollection, defineGlobal, heyoCms } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { text } from "../src/fields";
import {
  reportTelemetry,
  sendTelemetry,
  telemetryDecision,
  telemetryPayload,
  type TelemetryPayload,
} from "../src/telemetry";
import { local } from "../src/uploads";
import type { CmsInstance } from "../src/types/instance";

/**
 * Stage 10: telemetry, and the promises it makes.
 *
 * Two claims have to hold, and neither is a matter of taste. The payload
 * contains counts and identifiers and nothing else — no content, no names, no
 * secrets, no paths — and any one of three switches turns it off. A test is
 * the only form in which either claim is worth anything.
 */

function build(overrides: Record<string, unknown> = {}): CmsInstance {
  return heyoCms({
    database: () => sqlite(new Database(":memory:")),
    basePath: "/api/heyo-cms",
    uploads: { storage: local({ directory: "/tmp/secret-bucket-name" }) },
    collections: {
      posts: defineCollection({
        fields: { title: text({ required: true }), body: text({}) },
      }),
    },
    globals: {
      settings: defineGlobal({ fields: { siteName: text({}) } }),
    },
    ...overrides,
  }) as unknown as CmsInstance;
}

describe("the telemetry decision", () => {
  test("is on by default and says why", () => {
    const decision = telemetryDecision(undefined, {});
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain("heyo-cms telemetry");
  });

  test("honours the configuration, the project switch and DO_NOT_TRACK", () => {
    expect(telemetryDecision({ enabled: false }, {}).enabled).toBe(false);
    expect(
      telemetryDecision(undefined, { HEYO_TELEMETRY_DISABLED: "1" }),
    ).toEqual({
      // prettier-ignore
      enabled: false,
      reason: "HEYO_TELEMETRY_DISABLED is set",
    });
    expect(telemetryDecision(undefined, { DO_NOT_TRACK: "1" }).enabled).toBe(false); // prettier-ignore
  });

  test("refuses to count a build agent or a test run as a user", () => {
    expect(telemetryDecision(undefined, { CI: "true" }).enabled).toBe(false);
    expect(telemetryDecision(undefined, { NODE_ENV: "test" }).enabled).toBe(false); // prettier-ignore
    // `0` and the empty string are how a shell says "no", not "yes".
    expect(telemetryDecision(undefined, { CI: "0" }).enabled).toBe(true);
    expect(telemetryDecision(undefined, { CI: "" }).enabled).toBe(true);
  });
});

describe("the telemetry payload", () => {
  test("carries counts and identifiers, never content", () => {
    const payload = telemetryPayload("generate", build(), "0.1.0");

    expect(payload.event).toBe("generate");
    expect(payload.version).toBe("0.1.0");
    expect(payload.usage).toEqual({
      collections: 1,
      globals: 1,
      fields: 3,
      plugins: 0,
      locales: 1,
    });
    expect(payload.features.panel).toBe(false);
    expect(payload.features.trash).toBe(true);
    expect(payload.runtime.name).toBeString();

    // The whole body, as one string: nothing a project called its own may
    // appear in it. A field name, a collection name or a directory in the
    // JSON would each be a different kind of leak.
    const serialized = JSON.stringify(payload);
    for (const secret of ["posts", "settings", "title", "secret-bucket-name"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("identifies a project without describing it", () => {
    const first = telemetryPayload("migrate", build(), "0.1.0");
    const second = telemetryPayload("migrate", build(), "0.1.0");
    const other = telemetryPayload(
      "migrate",
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        collections: { pages: defineCollection({ fields: { title: text({}) } }) }, // prettier-ignore
      }) as unknown as CmsInstance,
      "0.1.0",
    );

    // Stable across runs, so "how many projects" is answerable...
    expect(first.project).toBe(second.project);
    // ...and different between projects, so the number means something.
    expect(first.project).not.toBe(other.project);
    expect(first.project).toMatch(/^[0-9a-f]{16}$/);
  });

  test("reports a lazy adapter as lazy rather than building one", () => {
    // The database is a factory here — the normal case, because a connection
    // has no business existing while a config module is being imported.
    expect(telemetryPayload("status", build(), "0.1.0").database).toBe("lazy");
    expect(telemetryPayload("status", build(), "0.1.0").features.uploads).toBe("local"); // prettier-ignore
  });
});

describe("sending", () => {
  test("posts the payload and reports what happened", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      // prettier-ignore
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const payload = telemetryPayload("seed", build(), "0.1.0");
    expect(await sendTelemetry(payload, { fetch: fakeFetch })).toBe("sent");
    expect(sent[0]?.url).toContain("telemetry.heyo.sh");
    expect((sent[0]?.body as TelemetryPayload).event).toBe("seed");
  });

  test("a collector that is down is not an error anybody sees", async () => {
    const failing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch; // prettier-ignore
    const payload = telemetryPayload("seed", build(), "0.1.0");
    expect(await sendTelemetry(payload, { fetch: failing })).toBe("failed");

    const refused = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch; // prettier-ignore
    expect(await sendTelemetry(payload, { fetch: refused })).toBe("failed");
  });

  test("an opted-out project never reaches the network", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const result = await reportTelemetry({
      event: "generate",
      cms: build(),
      version: "0.1.0",
      config: { enabled: false },
      environment: {},
      send: { fetch: counting },
    });
    expect(result.result).toBe("skipped");
    expect(calls).toBe(0);
  });

  test("a self-hosted collector replaces the endpoint", async () => {
    const seen: string[] = [];
    const recording = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await reportTelemetry({
      event: "generate",
      cms: build(),
      version: "0.1.0",
      config: { endpoint: "https://metrics.internal/cms" },
      environment: {},
      send: { fetch: recording },
    });
    expect(seen).toEqual(["https://metrics.internal/cms"]);
  });

  test("the configuration carries the section through to the resolved config", () => {
    const cms = build({ telemetry: { enabled: false } });
    expect(cms._config.telemetry).toEqual({ enabled: false });
  });
});
