import { expect, test } from "bun:test";

import {
  reportCreation,
  telemetryEnabled,
  telemetryPayload,
} from "../src/telemetry";
import type { CreateOptions } from "../src/types";

const options: CreateOptions = {
  projectName: "private-project",
  cwd: "/private/path",
  template: "astro",
  deployment: "cloudflare",
  database: "d1",
  storage: "r2",
  packageManager: "bun",
  install: false,
};

test("generator telemetry honours every opt-out", () => {
  expect(telemetryEnabled({})).toBe(true);
  for (const env of [
    { CI: "true" },
    { NODE_ENV: "test" },
    { DO_NOT_TRACK: "1" },
    { HEYO_TELEMETRY_DISABLED: "1" },
  ])
    expect(telemetryEnabled(env)).toBe(false);
});

test("generator payload is allowlisted, never includes project identity", () => {
  const payload = telemetryPayload(options, "0.1.0");
  expect(payload.framework).toBe("astro");
  expect(JSON.stringify(payload)).not.toContain("private");
  expect(Object.keys(payload).sort()).toEqual([
    "database",
    "deployment",
    "event",
    "framework",
    "packageManager",
    "storage",
    "system",
    "version",
  ]);
});

test("disabled reporting does not fetch; network failures do not fail creation", async () => {
  let calls = 0;
  const send = async () => {
    calls++;
    throw new Error("offline");
  };
  await reportCreation(options, { DO_NOT_TRACK: "1" }, send);
  expect(calls).toBe(0);
  await reportCreation(options, {}, send);
  expect(calls).toBe(1);
});
