import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";

import { d1, type D1Database } from "../src/db/d1";
import { mongodb } from "../src/db/mongodb";
import { postgres, type PostgresClient } from "../src/db/postgres";
import { sqlite } from "../src/db/sqlite";
import { runDatabaseAdapterContract } from "./contract/database-adapter";
import { memoryMongo } from "./mongo-memory";

/**
 * The same suite against every engine the plan commits to.
 *
 * Postgres runs on PGlite — Postgres compiled to WebAssembly — so `jsonb`,
 * partial unique indexes and real transactions are exercised for real in CI
 * without a server. SQLite runs on `bun:sqlite`, D1 runs through its binding
 * shape against the same SQLite, and MongoDB runs against an in-process
 * implementation of the driver surface the adapter uses.
 */

runDatabaseAdapterContract({
  name: "sqlite",
  create: () => sqlite(new Database(":memory:")),
});

runDatabaseAdapterContract({
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

runDatabaseAdapterContract({
  name: "d1",
  create: () => d1(d1BindingOverSqlite(new Database(":memory:"))),
});

runDatabaseAdapterContract({
  name: "mongodb (in-process)",
  create: () => mongodb(memoryMongo(), { transactions: false }),
});

/**
 * The D1 binding shape over a real SQLite.
 *
 * D1 is SQLite behind a different interface, so running the suite through the
 * binding — prepare, bind, all/run — covers the translation that only ever
 * ran in production otherwise.
 */
function d1BindingOverSqlite(database: Database): D1Database {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async all<T>() {
          return {
            results: database.prepare(sql).all(...(bound as never[])) as T[],
          };
        },
        async run() {
          const result = database.prepare(sql).run(...(bound as never[]));
          return { meta: { changes: Number(result.changes ?? 0) } };
        },
      };
      return statement;
    },
  };
}
