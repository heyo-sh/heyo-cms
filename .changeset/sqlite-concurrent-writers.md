---
"@heyo-sh/heyo-cms": patch
---

**SQLite no longer fails with "database is locked" when a second process
writes to the same file.** That is the ordinary setup in development: the dev
server and `heyo-cms seed` or `create-admin` next to it, or a Cloudflare
project's local D1 under `.wrangler/state`, which the CLI opens directly while
`wrangler dev` serves it. Two things made the second writer fail at once
instead of waiting its turn:

- `bun:sqlite` and `node:sqlite` open a database with a busy timeout of 0.
  `sqlite()` now sets `PRAGMA busy_timeout = 5000` — the default of
  `better-sqlite3` — unless the database already has one; the new
  `busyTimeout` option sets it explicitly (`0` restores the old behaviour).
- Transactions opened with a plain `BEGIN`, which takes the write lock only at
  the first write. If another process wrote after the transaction's first
  read, SQLite refuses that lock immediately, timeout or not. The SQLite
  dialect now opens transactions with `BEGIN IMMEDIATE`, so the lock is taken
  — and waited for — up front. Postgres is unchanged, and D1 bindings, which
  have no interactive transactions, are not affected.
