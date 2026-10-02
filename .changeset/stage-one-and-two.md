---
"@heyo-sh/heyo-cms": minor
---

Stages 1 and 2: contracts, fields, schema and database adapters.

- Frozen contracts for the database adapter, the storage adapter, plugins,
  fields, hooks and the configuration, plus the one `HookContext` every hook
  receives.
- `heyoCms()` and `defineCollection()` with eager validation: reserved names,
  slug collisions, relation targets, chat context, AI providers without
  credentials, webhooks without a signing secret.
- A field registry built on the public `defineField()`, with thirteen built-in
  types and a `seoFields()` preset. Required-ness and literal options are
  carried into the inferred document type.
- The schema layer: thirteen system collections, a snapshot built from the
  configuration, and a deterministic planner whose output is grouped into
  phases and ordered by foreign keys.
- Four database adapters — Postgres, SQLite, D1 and MongoDB — behind one
  neutral `Query`/`Mutation` AST, all passing the same contract suite.
- `heyo-cms generate | migrate | status`, diffing against a committed snapshot
  rather than a live database. There is no `push` mode.
