import { readFile } from "node:fs/promises";
import { arch, platform } from "node:os";

import type { CreateOptions } from "./types";

export function telemetryEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const on = (value: string | undefined) =>
    Boolean(value && value !== "0" && value !== "false");
  return !(
    on(env.HEYO_TELEMETRY_DISABLED) ||
    on(env.DO_NOT_TRACK) ||
    on(env.CI) ||
    env.NODE_ENV === "test"
  );
}

/** An allowlist: project names, paths, credentials and content never enter it. */
export function telemetryPayload(options: CreateOptions, version: string) {
  return {
    event: "create",
    version,
    framework: options.template,
    deployment: options.deployment,
    database: options.database,
    storage: options.storage,
    packageManager: options.packageManager,
    system: { platform: platform(), arch: arch() },
  };
}

export async function reportCreation(
  options: CreateOptions,
  environment: NodeJS.ProcessEnv = process.env,
  send: (
    input: string,
    init: RequestInit,
  ) => Promise<Response> = globalThis.fetch,
): Promise<void> {
  if (!telemetryEnabled(environment)) return;
  try {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    await send("https://telemetry.heyo.sh/v1/cms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telemetryPayload(options, manifest.version)),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Reporting cannot fail creation, is bounded, and is never retried.
  }
}
