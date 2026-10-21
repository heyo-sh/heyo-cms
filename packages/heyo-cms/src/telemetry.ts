import { createHash } from "node:crypto";
import { arch, platform, release } from "node:os";

import type { CmsInstance } from "./types/instance";
import type { StorageConfig } from "./types/storage";
import type { TelemetryConfig } from "./types/telemetry";

export type { TelemetryConfig };

/**
 * Adoption telemetry — what it is, and what it refuses to be.
 *
 * The CMS has no analytics on the deployments it runs in: a server built from
 * this package never phones home, in any environment, for any reason. What
 * does report is the **command line**: `heyo-cms generate`, `migrate`,
 * `seed`, `create-admin`, `import`, `export`, and the project generator. Those
 * run on a developer's machine, once in a while, and answer the only question
 * the project actually needs answered — is anybody using this, and with which
 * database and framework.
 *
 * What is sent is in `TelemetryPayload` below and nowhere else. It is a fixed
 * set of counts and identifiers: no content, no field names, no connection
 * strings, no file paths, no addresses, no keys. `heyo-cms telemetry` prints
 * the exact body that would be sent, so the claim is checkable rather than
 * promised.
 *
 * Opting out, any one of which is enough:
 *
 *   HEYO_TELEMETRY_DISABLED=1      the project's own switch
 *   DO_NOT_TRACK=1                 the cross-tool convention, honoured
 *   telemetry: { enabled: false }  in heyo-cms.config.ts
 *
 * It is also off, without being asked, on CI and under a test runner: a build
 * agent is not a user, and counting one as a user would make the number this
 * exists to produce worthless.
 */

export const telemetryEndpoint = "https://telemetry.heyo.sh/v1/cms";

export interface TelemetryDecision {
  enabled: boolean;
  /** Why, in words, so `heyo-cms telemetry` can print it. */
  reason: string;
}

/**
 * The whole payload. Adding a field here is a documentation change too.
 */
export interface TelemetryPayload {
  /** The command that ran: `generate`, `migrate`, `create`, ... */
  event: string;
  /** The version of `@heyo-sh/heyo-cms` that sent it. */
  version: string;
  /**
   * A project identifier that is not a project.
   *
   * The SHA-256 of the configuration's shape — collection names, the database
   * id, the base path — truncated to 16 hex characters. Two runs from the
   * same shape agree. This is not a unique installation id: projects with
   * the same shape collide, and low-entropy inputs can be guessed. It must
   * not be treated as a count of distinct users or as encryption.
   */
  project: string;
  runtime: { name: string; version: string };
  system: { platform: string; arch: string; release: string };
  /** The adapter id: `postgres`, `sqlite`, `d1`, `mongodb`. */
  database: string;
  /** Counts, never names. */
  usage: {
    collections: number;
    globals: number;
    fields: number;
    plugins: number;
    locales: number;
  };
  /** Which optional sections exist. Booleans, never their configuration. */
  features: {
    /** The panel bundle is mounted. */
    panel: boolean;
    /** Editor authentication is configured. */
    auth: boolean;
    /** The storage adapter id, or `null` when the CMS stores no files. */
    uploads: string | null;
    ai: boolean;
    webhooks: boolean;
    trash: boolean;
  };
}

export interface TelemetryEnvironment {
  [key: string]: string | undefined;
}

/**
 * Decides whether anything may be sent, and says why.
 *
 * Every branch returns a sentence rather than a boolean alone, because the
 * question a person asks is never "is it on" — it is "why is it on".
 */
export function telemetryDecision(
  config: TelemetryConfig | undefined,
  environment: TelemetryEnvironment = process.env,
): TelemetryDecision {
  if (config?.enabled === false) {
    return { enabled: false, reason: "telemetry: { enabled: false } in the configuration" }; // prettier-ignore
  }
  if (isTruthy(environment.HEYO_TELEMETRY_DISABLED)) {
    return { enabled: false, reason: "HEYO_TELEMETRY_DISABLED is set" };
  }
  if (isTruthy(environment.DO_NOT_TRACK)) {
    return { enabled: false, reason: "DO_NOT_TRACK is set" };
  }
  if (isTruthy(environment.CI)) {
    return { enabled: false, reason: "this is CI" };
  }
  if (environment.NODE_ENV === "test") {
    return { enabled: false, reason: "NODE_ENV is test" };
  }
  return { enabled: true, reason: "on by default; see `heyo-cms telemetry`" };
}

/**
 * Builds the body from the configuration.
 *
 * Deliberately total: it never reads a file, never resolves a database and
 * never touches the network, so printing it costs nothing and cannot fail in
 * a way that breaks the command it was attached to.
 */
export function telemetryPayload(
  event: string,
  cms: CmsInstance,
  version: string,
): TelemetryPayload {
  const config = cms._config;
  const collections = Object.values(config.collections);
  const globals = Object.values(config.globals);
  const fields =
    collections.reduce((total, c) => total + Object.keys(c.fields).length, 0) +
    globals.reduce((total, g) => total + Object.keys(g.fields).length, 0);

  const database =
    typeof config.database === "function" ? "lazy" : config.database.id;

  return {
    event,
    version,
    project: projectHash([
      config.basePath,
      database,
      ...collections.map((collection) => collection.slug).sort(),
      ...globals.map((global) => global.slug).sort(),
    ]),
    runtime: runtime(),
    system: { platform: platform(), arch: arch(), release: release() },
    database,
    usage: {
      collections: collections.length,
      globals: globals.length,
      fields,
      plugins: config.plugins.length,
      locales: config.i18n.locales.length,
    },
    features: {
      panel: config.admin.assets !== undefined,
      auth: config.admin.auth !== undefined,
      uploads: storageId(config.uploads?.storage),
      ai: config.ai !== undefined,
      webhooks: config.webhooks?.enabled === true,
      trash: config.trash.enabled,
    },
  };
}

export interface SendOptions {
  endpoint?: string;
  /** Injected by the tests; nothing else should pass it. */
  fetch?: typeof fetch;
  /** Milliseconds before the attempt is abandoned. */
  timeout?: number;
}

/**
 * Sends one payload, and never matters.
 *
 * Failure is not reported and not retried: a CLI that took longer, printed a
 * warning or exited non-zero because a telemetry endpoint was down would be a
 * worse tool than one with no telemetry at all.
 */
export async function sendTelemetry(
  payload: TelemetryPayload,
  options: SendOptions = {},
): Promise<"sent" | "failed"> {
  const send = options.fetch ?? globalThis.fetch;
  try {
    const response = await send(options.endpoint ?? telemetryEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeout ?? 2_000),
    });
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * The one call a command makes: decide, build, send, forget.
 *
 * Returns what happened so `heyo-cms telemetry` can print it; every caller
 * except that command ignores the result.
 */
export async function reportTelemetry(args: {
  event: string;
  cms: CmsInstance;
  version: string;
  config?: TelemetryConfig;
  environment?: TelemetryEnvironment;
  send?: SendOptions;
}): Promise<{
  decision: TelemetryDecision;
  result: "sent" | "failed" | "skipped";
}> {
  const decision = telemetryDecision(args.config, args.environment);
  if (!decision.enabled) return { decision, result: "skipped" };
  const payload = telemetryPayload(args.event, args.cms, args.version);
  const result = await sendTelemetry(payload, {
    ...args.send,
    ...(args.config?.endpoint ? { endpoint: args.config.endpoint } : {}),
  });
  return { decision, result };
}

/**
 * The storage adapter's id, without building it.
 *
 * An adapter is often a factory, because a bucket client has no business
 * existing while a configuration module is being imported. `lazy` is the
 * honest answer for one: the alternative is constructing an S3 client to
 * report a word.
 */
function storageId(storage: StorageConfig | undefined): string | null {
  if (storage === undefined) return null;
  return typeof storage === "function" ? "lazy" : storage.id;
}

function projectHash(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 16);
}

function runtime(): { name: string; version: string } {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  if (bun) return { name: "bun", version: bun.version };
  const deno = (globalThis as { Deno?: { version: { deno: string } } }).Deno;
  if (deno) return { name: "deno", version: deno.version.deno };
  return { name: "node", version: process.versions.node };
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value !== "false"; // prettier-ignore
}
