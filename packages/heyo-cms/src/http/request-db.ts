import { scopedDb } from "../engine/scoped-db";
import type { DatabaseAdapter } from "../types/database";
import type { ScopedDb } from "../types/hooks";
import type { Mutation, Query, Row, Where } from "../types/query";

/**
 * `ctx.db` for a route rather than for a hook.
 *
 * A hook runs inside the operation's transaction, so its `db` joins it. A
 * route is not an operation: there is nothing for a second statement to be
 * atomic with, and holding a transaction open across an `await fetch()` in
 * somebody's plugin would pin a pool connection for as long as the slowest
 * third party takes to answer. So every call here gets its own short
 * transaction, and a route that genuinely needs two statements to agree asks
 * for the adapter and opens one itself.
 *
 * Lazy on purpose: resolving the adapter is what opens a pool or reads a
 * binding, and most requests — a bundled asset, the OpenAPI document, a 404 —
 * never touch the database at all.
 */
export function requestDb(database: () => Promise<DatabaseAdapter>): ScopedDb {
  const run = async <T>(
    fn: (adapter: DatabaseAdapter, tx: Parameters<Parameters<DatabaseAdapter["transaction"]>[0]>[0]) => Promise<T>, // prettier-ignore
  ): Promise<T> => {
    const adapter = await database();
    return adapter.transaction((tx) => fn(adapter, tx));
  };

  return {
    query: (query: Query) => run((adapter, tx) => adapter.query(tx, query)),
    mutate: (mutation: Mutation) =>
      run((adapter, tx) => adapter.mutate(tx, mutation)),
    find: (table: string, where?: Where) =>
      run((adapter, tx) => scopedDb(adapter, tx).find(table, where)),
    findOne: (table: string, where: Where) =>
      run((adapter, tx) => scopedDb(adapter, tx).findOne(table, where)),
    insert: (table: string, values: Row) =>
      run((adapter, tx) => scopedDb(adapter, tx).insert(table, values)),
    update: (table: string, where: Where, set: Row) =>
      run((adapter, tx) => scopedDb(adapter, tx).update(table, where, set)),
    delete: (table: string, where: Where) =>
      run((adapter, tx) => scopedDb(adapter, tx).delete(table, where)),
  };
}
