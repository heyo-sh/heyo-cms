import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CmsConfigError } from "../src/errors";
import { sqlite } from "../src/db/sqlite";

/**
 * One SQLite file is often open in two processes at once: the dev server and
 * the CLI next to it, or a Cloudflare project's local D1 and the `heyo-cms`
 * command that writes to it directly. SQLite lets one of them write at a time,
 * and the second writer used to fail at once with "database is locked":
 *
 *  - the busy timeout, which makes it wait, starts at 0 in both `bun:sqlite`
 *    and `node:sqlite`;
 *  - a transaction opened with a plain `BEGIN` asks for the lock only at its
 *    first write, and SQLite refuses it without waiting if anyone wrote since
 *    the transaction's first read. `BEGIN IMMEDIATE` takes it up front.
 */

const timeout = (database: {
  prepare(sql: string): { all(): unknown[] };
}): number =>
  Number(
    (database.prepare("PRAGMA busy_timeout").all()[0] as { timeout: number })
      .timeout,
  );

describe("the SQLite adapter, sharing its file with another process", () => {
  test("waits five seconds for a lock by default, on either runtime's SQLite", () => {
    const bun = new Database(":memory:");
    sqlite(bun);
    expect(timeout(bun)).toBe(5000);

    const node = new DatabaseSync(":memory:");
    sqlite(node);
    expect(timeout(node)).toBe(5000);
  });

  test("keeps a timeout the database was already given", () => {
    const database = new Database(":memory:");
    database.exec("PRAGMA busy_timeout = 1234");
    sqlite(database);
    expect(timeout(database)).toBe(1234);
  });

  test("takes an explicit one over both, 0 included", () => {
    const database = new Database(":memory:");
    database.exec("PRAGMA busy_timeout = 1234");
    sqlite(database, { busyTimeout: 250 });
    expect(timeout(database)).toBe(250);
    sqlite(database, { busyTimeout: 0 });
    expect(timeout(database)).toBe(0);
  });

  test("refuses a timeout that is not a number of milliseconds", () => {
    for (const busyTimeout of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sqlite(new Database(":memory:"), { busyTimeout })).toThrow(
        CmsConfigError,
      );
    }
  });

  describe("with another process writing", () => {
    let directory: string;
    let file: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "heyo-sqlite-lock-"));
      file = join(directory, "shared.sqlite");
      const setup = new Database(file);
      setup.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (n INTEGER)");
      setup.close();
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    /** A second process that takes the write lock, says so, and lets go after `ms`. */
    async function holdLock(ms: number) {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
          const { Database } = require("bun:sqlite");
          const db = new Database(${JSON.stringify(file)});
          db.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (1)");
          console.log("locked");
          setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${ms});
          `,
        ],
        { stdout: "pipe" },
      );
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain("locked");
      reader.releaseLock();
      return child;
    }

    test("a write waits for the lock and then succeeds", async () => {
      const database = new Database(file);
      sqlite(database);
      const child = await holdLock(300);

      const started = performance.now();
      database.exec("INSERT INTO t VALUES (2)");
      expect(performance.now() - started).toBeGreaterThan(100);
      await child.exited;

      expect(database.prepare("SELECT n FROM t ORDER BY n").all()).toEqual([
        { n: 1 },
        { n: 2 },
      ]);
      database.close();
    });

    test("so does a write through an adapter that opened the file itself", async () => {
      const adapter = await sqlite({ file })();
      await adapter.listAppliedMigrations(); // creates the journal table first
      const child = await holdLock(300);

      await adapter.recordMigration("0001_test", "sum");
      await child.exited;
      expect((await adapter.listAppliedMigrations()).map((row) => row.id)).toEqual(["0001_test"]); // prettier-ignore
      await adapter.close?.();
    });

    test("a transaction that reads, then writes, survives a write from outside in between", async () => {
      // A second process that writes when told to, and says when it has.
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
          const { Database } = require("bun:sqlite");
          const db = new Database(${JSON.stringify(file)});
          db.exec("PRAGMA busy_timeout = 5000");
          console.log("ready");
          for await (const line of console) {
            db.exec("INSERT INTO t VALUES (1)");
            console.log("wrote");
            break;
          }
          db.close();
          `,
        ],
        { stdin: "pipe", stdout: "pipe" },
      );
      const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader(); // prettier-ignore
      const next = async () => (await lines.read()).value ?? "";
      expect(await next()).toContain("ready");

      const adapter = await sqlite({ file })();
      await adapter.listAppliedMigrations(); // the journal exists before the transaction
      let wroteInside = false;
      let answer: Promise<string> = Promise.resolve("");
      await adapter.transaction(async () => {
        await adapter.listAppliedMigrations(); // a read: the snapshot
        child.stdin.write("go\n");
        child.stdin.flush();
        // A plain BEGIN lets the other write land here, which makes the
        // snapshot stale and the write below fail with "database is locked".
        answer = next();
        const early = await Promise.race([answer, Bun.sleep(300).then(() => "")]); // prettier-ignore
        wroteInside = early.includes("wrote");
        await adapter.recordMigration("0001_test", "sum");
      });

      // BEGIN IMMEDIATE held the lock: the other process waited for the commit.
      expect(wroteInside).toBe(false);
      expect(await answer).toContain("wrote");
      await child.exited;
      expect((await adapter.listAppliedMigrations()).map((row) => row.id)).toEqual(["0001_test"]); // prettier-ignore
      await adapter.close?.();
      const check = new Database(file);
      expect(check.prepare("SELECT n FROM t").all()).toEqual([{ n: 1 }]);
      check.close();
    });

    test("without a timeout the same write fails at once — what this replaces", async () => {
      const database = new Database(file);
      sqlite(database, { busyTimeout: 0 });
      const child = await holdLock(300);

      expect(() => database.exec("INSERT INTO t VALUES (2)")).toThrow(/locked/);
      await child.exited;
      database.close();
    });
  });
});
