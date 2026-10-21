import { CmsError } from "../errors";
import type { DatabaseAdapter } from "../types/database";
import type { ScopedDb } from "../types/hooks";
import type { Mutation, Query, Row, Tx, Where } from "../types/query";

/**
 * `ctx.db`: the handle that bypasses access control, by name.
 *
 * Everything it does happens inside the caller's transaction, so a hook that
 * writes an audit row and then throws leaves nothing behind. The alternative
 * — a pooled connection of its own — would commit independently of the
 * operation that triggered it.
 */
export function scopedDb(adapter: DatabaseAdapter, tx: Tx): ScopedDb {
  const run = (mutation: Mutation) => adapter.mutate(tx, mutation);

  return {
    query: (query: Query) => adapter.query(tx, query),
    mutate: run,

    find: (table, where) =>
      adapter.query(tx, { table, ...(where === undefined ? {} : { where }) }),

    async findOne(table, where) {
      const rows = await adapter.query(tx, { table, where, limit: 1 });
      return rows[0] ?? null;
    },

    async insert(table, values) {
      const result = await run({ kind: "insert", table, values });
      const row = result.rows[0];
      if (!row) {
        // Every supported engine returns the inserted row; one that did not
        // would make `insert` a write the caller cannot reason about.
        throw new CmsError(`Insert into ${table} returned no row.`, {
          status: 500,
          code: "insert_without_row",
        });
      }
      return row;
    },

    async update(table: string, where: Where, set: Row) {
      const result = await run({
        kind: "update",
        table,
        where,
        set,
        returning: false,
      });
      return result.count;
    },

    async delete(table: string, where: Where) {
      const result = await run({ kind: "delete", table, where });
      return result.count;
    },
  };
}
