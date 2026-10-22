<div align="center">
  <h1>Heyo CMS</h1>

  <p>
    <a href="https://npmjs.com/package/@heyo-sh/heyo-cms"><img src="https://img.shields.io/npm/dm/%40heyo-sh%2Fheyo-cms?style=flat&amp;colorA=000000&amp;colorB=000000" alt="npm downloads"/></a>
    <a href="https://www.npmjs.com/package/@heyo-sh/heyo-cms"><img src="https://img.shields.io/npm/v/%40heyo-sh%2Fheyo-cms.svg?style=flat&amp;colorA=000000&amp;colorB=000000" alt="npm version"/></a>
    <a href="https://github.com/heyo-sh/heyo-cms/stargazers"><img src="https://img.shields.io/github/stars/heyo-sh/heyo-cms?style=flat&amp;colorA=000000&amp;colorB=000000" alt="GitHub stars"/></a>
    <img src="https://img.shields.io/badge/4%20databases-000000?style=flat&amp;colorA=000000&amp;colorB=000000" alt="4 databases"/>
    <img src="https://img.shields.io/badge/AI--Native-000000?style=flat&amp;colorA=000000&amp;colorB=000000" alt="AI-Native"/>
  </p>

  <p style="margin-top: 0.375rem;">
    <a href="https://cms.heyo.sh">Documentation</a>
    ·
    <a href="https://cms.heyo.sh/quickstart/next">Quickstart</a>
    ·
    <a href="https://cms.heyo.sh/migrating-from-payload">Migrating from Payload</a>
  </p>
</div>

## Heyo CMS

A framework-agnostic, TypeScript-first headless CMS with its own admin panel,
RBAC, i18n, native AI, and media treated as a first-class citizen. The core is
a plain `Request → Response` handler — no React, no Next.js, no framework of
any kind in the engine's dependency tree — and it runs the same on Node, Bun,
and Cloudflare Workers, backed by Postgres, MongoDB, SQLite, or D1.

## Get started

Start the creator and answer its questions about the framework, deployment
target, database, storage, and package manager. When it finishes, it prints
the exact migration and seed commands; the panel then asks you to create the
administrator account.

```bash
# pnpm
pnpm create @heyo-sh/heyo-cms

# npm
npm create @heyo-sh/heyo-cms@latest

# Yarn
yarn dlx @heyo-sh/create-heyo-cms

# Bun
bun create @heyo-sh/heyo-cms
```

The creator works with pnpm, npm, Yarn, and Bun. It generates Next.js, Astro,
or React Router projects for Vercel and Cloudflare, including the panel,
migrations, and seeds. Non-interactive:
`bun create @heyo-sh/heyo-cms my-cms --template astro --deployment cloudflare --database d1 --storage r2 --no-install`.

For an existing application, follow the framework-specific guides for [Next.js](https://cms.heyo.sh/quickstart/next), [Astro](https://cms.heyo.sh/quickstart/astro), or [React Router](https://cms.heyo.sh/quickstart/react-router).

## Minimum Configuration

`heyo-cms.config.ts` is the single source of truth for your collections,
globals, access rules, and integrations. Only `database` and `collections` are
required:

```ts
import { defineCollection, heyoCms } from "@heyo-sh/heyo-cms";
import { richText, select, text } from "@heyo-sh/heyo-cms/fields";
import { postgres } from "@heyo-sh/heyo-cms/postgres";

export const cms = heyoCms({
  database: postgres(process.env.DATABASE_URL!),
  collections: {
    posts: defineCollection({
      fields: {
        title: text({ required: true, localized: true }),
        handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
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

One catch-all route mounts everything — CRUD for every collection, globals,
media, auth, the OpenAPI document, and the admin panel:

```ts
// app/api/heyo-cms/[...path]/route.ts
import { cmsHandler } from "@heyo-sh/heyo-cms/next";
import { cms } from "@/heyo-cms.config";

export const { GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS } = cmsHandler(cms);
```

```bash
heyo-cms generate   # write a migration for what changed
heyo-cms migrate    # apply pending migrations
```

Read the [configuration guide](https://cms.heyo.sh/configuration) for the
complete reference. Fields, hooks, media, RBAC, i18n, AI, webhooks, caching,
the CLI, and deployment are covered in the [documentation](https://cms.heyo.sh).

## What's in the box

- **Migrations as a first-class citizen.** A deterministic schema diff written
  to files in the repository, and no `push` mode. The same flow on Postgres,
  MongoDB, SQLite, and D1 — all four adapters pass the same contract suite.
- **A typed local API and client.** `cms.api` is typed from your collections
  and is the code path the REST routes call — same access control, same hooks,
  same events. The browser client mirrors it method for method.
- **An admin panel with no second deployment.** One static bundle served by
  the same handler, derived from your configuration at runtime — a field added
  to a collection is in the form on the next page load.
- **Media with a lifecycle.** Uploads, variants, focal points, and an
  orphan/reclaim/collect lifecycle that never destroys a referenced file.
- **AI as a capability of a field.** Per-field generate actions and a
  panel-wide assistant that goes through the same access control as a person.
- **Better Auth-style DX.** `heyoCms({ plugins: [...] })`, explicit
  `before`/`after` hooks, type inference, and an extensible client.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and contribution
guidelines, and [RELEASING.md](RELEASING.md) for the release workflow.

## License

[MIT](LICENSE)
