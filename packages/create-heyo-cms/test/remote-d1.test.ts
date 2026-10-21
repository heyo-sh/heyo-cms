import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { D1Database } from "../../heyo-cms/src/db/d1";

/**
 * The shipped fragment, run.
 *
 * The D1 layer no longer ships a `heyo-cms.d1-remote.ts` module — a generated
 * project has one configuration file and this bridge is part of it — so the
 * fragment is reassembled into a module here and imported. That is a better
 * test than the old one, not a worse one: it proves the exact text a reader
 * will find inside their `heyo-cms.config.ts` both compiles and behaves,
 * rather than proving it about a file nobody receives any more.
 */
const directory = await mkdtemp(join(tmpdir(), "heyo-d1-remote-"));
const module = join(directory, "d1.ts");

const fragment = await readFile(
  new URL("../databases/d1/config.database.fragment", import.meta.url),
  "utf8",
);

// The bridge only, not the whole block: the D1 adapter above it imports the
// Workers runtime and this test has no Worker. The marker is the comment the
// fragment opens the bridge with, so a rename breaks the test loudly instead
// of silently checking nothing.
const marker = "/** Explicit CLI-only access to production D1";
const start = fragment.indexOf(marker);
if (start === -1) {
  throw new Error("The D1 fragment no longer contains the remote bridge.");
}

await writeFile(
  module,
  [
    'import type { D1Database, D1PreparedStatement } from "@heyo-sh/heyo-cms/d1";',
    "",
    fragment.slice(start).replace("function remoteD1()", "export function remoteD1()"), // prettier-ignore
  ].join("\n"),
);

const { remoteD1 } = (await import(pathToFileURL(module).href)) as {
  remoteD1(): D1Database;
};

await rm(directory, { recursive: true, force: true });

test("remote D1 requires explicit credentials and preserves bound parameters", async () => {
  const before = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.CLOUDFLARE_API_TOKEN;
    expect(() => remoteD1()).toThrow(/CLOUDFLARE_API_TOKEN/);
    process.env.CLOUDFLARE_ACCOUNT_ID = "account";
    process.env.CLOUDFLARE_D1_DATABASE_ID = "database";
    process.env.CLOUDFLARE_API_TOKEN = "secret";
    const requests: unknown[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push([input, JSON.parse(String(init?.body))]);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer secret",
      );
      return Response.json({
        success: true,
        result: [
          { success: true, results: [{ id: "doc" }], meta: { changes: 1 } },
        ],
      });
    }) as typeof fetch;
    const db = remoteD1();
    expect(await db.prepare("SELECT ? AS id").bind("doc").all()).toEqual({
      results: [{ id: "doc" }],
    });
    expect(
      await db.prepare("UPDATE documents SET data = ?").bind("{}").run(),
    ).toEqual({ meta: { changes: 1 } });
    expect(requests[0]).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/query",
      { sql: "SELECT ? AS id", params: ["doc"] },
    ]);
    globalThis.fetch = (async () =>
      new Response("secret must not leak", {
        status: 403,
      })) as unknown as typeof fetch;
    await expect(db.prepare("SELECT 1").all()).rejects.toThrow(
      "D1 query failed (HTTP 403).",
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_D1_DATABASE_ID",
      "CLOUDFLARE_API_TOKEN",
    ]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});
