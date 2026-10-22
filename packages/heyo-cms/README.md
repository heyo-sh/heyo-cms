# @heyo-sh/heyo-cms

A framework-agnostic TypeScript CMS: collections, globals, RBAC, editor auth,
localized content, media, hooks/events, scheduling, AI and signed webhooks.
Postgres, MongoDB, SQLite and Cloudflare D1. MIT.

## Start a project

Use Node 24+ or Bun:

```bash
bun create @heyo-sh/heyo-cms
```

Choose Next.js, Astro or React Router and Vercel or Cloudflare. The generator
includes `@heyo-sh/heyo-cms-admin`, migrations, a seed, a public page and one
catch-all route. Follow its printed setup commands.

## CLI

```bash
heyo-cms generate
heyo-cms migrate
heyo-cms status
heyo-cms create-admin --email you@example.com
heyo-cms seed
heyo-cms export --out content.ndjson
heyo-cms import content.ndjson --on-conflict update
```

There is no schema `push` mode. Content transfer preserves IDs and localized
values and runs normal hooks. It is not a backup: media bytes/rows, accounts
and operational history are excluded; timestamps are new and trash is skipped.

## Telemetry

Only CLI commands report adoption metadata (adapter IDs, counts, feature flags,
runtime/OS and a configuration-shape hash). A running CMS server never reports.
`heyo-cms telemetry` prints the payload. Disable with
`HEYO_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, or
`telemetry: { enabled: false }` in config. CI/tests are disabled by default.

[Documentation](https://github.com/heyo-sh/heyo-cms/tree/main/docs) ·
[API examples and limits](https://github.com/heyo-sh/heyo-cms#readme) ·
[Benchmarks and methodology](https://github.com/heyo-sh/heyo-cms/tree/main/benchmarks)
