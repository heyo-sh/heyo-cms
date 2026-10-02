# Heyo CMS

Framework-agnostic, TypeScript-first headless CMS with its own panel, RBAC,
i18n, native AI and media treated as a first-class citizen.

> **Status: stages 1 and 2 of 10 are done.** The contracts, the field registry,
> the schema layer, the four database adapters and the migration CLI exist and
> are tested. The engine (CRUD, hooks, events) is stage 3, the HTTP handler is
> stage 7, the admin panel is stage 8. See [Implementation
> status](#implementation-status) for what each entry point does today.

## Why

1. **Zero framework coupling.** The core is a plain `Request → Response`. No
   React, no Next.js, no framework of any kind in the engine's dependency tree.
2. **Lightweight.** Target: under 30 MB installed, cold start under 200 ms.
3. **Migrations as a first-class citizen.** A deterministic schema diff written
   to files in the repository, and no `push` mode. The same flow on Postgres,
   MongoDB and SQLite.
4. **Better Auth-style DX.** `heyoCms({ plugins: [...] })`, explicit
   `before`/`after` hooks, type inference, an extensible client.

## Quick start

```ts
// heyo-cms.config.ts
import { defineCollection, heyoCms } from "@heyo-sh/heyo-cms";
import { richText, select, slug, text } from "@heyo-sh/heyo-cms/fields";
import { postgres } from "@heyo-sh/heyo-cms/postgres";

export const cms = heyoCms({
  database: postgres(process.env.DATABASE_URL!),
  collections: {
    posts: defineCollection({
      fields: {
        title: text({ required: true, localized: true }),
        handle: slug({}),
        status: select({
          options: ["draft", "review", "published"],
          default: "draft",
        }),
        body: richText({ localized: true }),
      },
    }),
  },
});
```

```bash
heyo-cms generate   # write a migration for what changed
heyo-cms migrate    # apply pending migrations
heyo-cms status     # applied, pending, and changes with no migration yet
```

[`examples/next/heyo-cms.config.ts`](./examples/next/heyo-cms.config.ts) is the
full configuration — auth, RBAC, i18n, uploads, AI, webhooks, trash — and it is
type-checked in CI, so the documented experience cannot drift from the types.

## Design decisions worth knowing before you read the code

**Status is an ordinary `select()` field.** There is no document lifecycle in
the engine: no `drafts`, no `published_data`, no `publish()`. A consumer filters
`where: { status: "published" }`. This removes a whole layer from the core, and
the thing it costs — preparing an edit to a published page without publishing it
— is what the paid versions package is for.

**Content lives in a JSON document body.** One `documents` table holds every
collection. Adding a field or a locale is therefore not a table rewrite, and
fields that need to be queried get expression indexes over their JSON path
instead of columns. This is also what makes one engine-neutral model work on
Postgres, MongoDB and SQLite at once.

**No SQL leaves an adapter.** The engine builds a neutral `Query`/`Mutation`
AST and neutral migration steps; each adapter renders them. A feature that
cannot be expressed in the AST cannot be expressed in the engine either, which
is what keeps the fourth adapter a translation job rather than a project.

**Migrations diff against a committed snapshot, never against your database.**
`heyo-cms generate` reads `migrations/meta/snapshot.json`, not the live schema.
It works offline, produces the same file on every machine, and can never
propose dropping a table it does not own.

**There is no `push` mode.** A schema change that leaves no file behind is one
nobody can review, roll back or reproduce.

## Databases

|                 | Postgres                     | MongoDB             | SQLite / D1      |
| --------------- | ---------------------------- | ------------------- | ---------------- |
| Transactions    | yes                          | replica set only    | yes (D1: none)   |
| Migrations      | `.sql` files                 | indexes + backfills | `.sql` files     |
| Content queries | JSONB                        | native              | `json_extract`   |
| Adapter         | `@heyo-sh/heyo-cms/postgres` | `/mongodb`          | `/sqlite`, `/d1` |

```ts
postgres(process.env.DATABASE_URL!); // or postgres(client)
mongodb(process.env.MONGODB_URL!); // or mongodb(db)
sqlite({ file: "./cms.db" }); // or sqlite(database)
d1(env.DB);
```

Drivers are peer dependencies: nothing is bundled, so a Cloudflare deployment
does not ship a Node Postgres client it never calls.

All four adapters pass the same contract suite
([`test/contract/database-adapter.ts`](./packages/heyo-cms/test/contract/database-adapter.ts)).
Postgres runs it on PGlite — Postgres compiled to WebAssembly — so `jsonb`,
partial unique indexes and real transactions are exercised in CI without a
server.

## Hooks

Two layers, explicit `before`/`after`, one return contract for all of them:
`undefined` continue, `{ data }` continue with a replacement, `false` stop
silently, `throw CmsError` stop with a status.

```ts
databaseHooks: {
  posts: {
    create: {
      before: async (input, ctx) => ({
        data: { ...input.data, handle: slugify(input.data.title) },
      }),
      after: async (doc, ctx) => {
        ctx.events.emit("search.index", { id: doc.id });
      },
    },
  },
}
```

`ctx.db` bypasses access control and `ctx.cms` enforces it — the difference is
in the name, not in a flag buried in an options object. Side effects always go
through `ctx.events`, which writes to the outbox inside the transaction and
delivers after the commit: a rolled back write sends nothing, a committed one
sends for certain.

`cms.inspect()` prints the final schema, the hook pipeline in execution order
and the registered routes. Plugin hooks run by priority, the configuration's
own hooks always run last.

## Local development

```bash
bun install
bun test                     # 110 tests, four database engines
bun run quality              # lint, knip, typecheck, test, build
bun run example list         # the examples, their databases and ports
bun run example smoke next   # build the schema, migrate a real Postgres, verify
```

`bun run example` is the canonical way to check a change before it ships. It
reuses a Postgres that is already listening, starts a container only if none is,
and removes anything it started on the way out.

## Implementation status

| Entry point                               | State                                                               |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `@heyo-sh/heyo-cms`                       | `heyoCms()`, `defineCollection()`, validation, schema               |
| `/types`                                  | every frozen contract from stages 1–2                               |
| `/fields`                                 | registry, `defineField()`, 13 built-in types, `seoFields()`         |
| `/schema`, `/query`, `/migrations`        | snapshot, planner, AST helpers, store                               |
| `/postgres`, `/sqlite`, `/d1`, `/mongodb` | complete, contract-tested                                           |
| `/auth`                                   | `cmsUsers()`, `oidc()` — configuration only; sign-in is stage 4     |
| `/uploads`                                | `local()`, `memory()` work; `s3()` validates, transports in stage 6 |
| `cms.api`, `cms.handler`                  | stages 3 and 7                                                      |
| `@heyo-sh/heyo-cms-admin`                 | stage 8                                                             |
| `@heyo-sh/create-heyo-cms`                | stage 10                                                            |

Known limits of the current stages, by design rather than by omission:

- A localized field cannot be `unique`: uniqueness would have to be enforced per
  locale, and locales are rows in a table, not entries in the configuration.
- Nested `group` and `array` fields are not in the built-in registry yet.
- An index on a multi-value field (`multiselect`, `relation({ many: true })`)
  indexes the JSON text of the array, which serves equality but not membership.
  Container indexes arrive with the query layer in stage 3, where `contains`
  gets an engine-specific plan.
- `introspect()` reports tables and indexes, not the logical collections — a
  database cannot know which collection a document belongs to. It is used for
  drift detection, never as the `from` side of a diff.

## Licence

MIT.
