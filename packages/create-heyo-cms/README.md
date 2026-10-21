# @heyo-sh/create-heyo-cms

```bash
bun create @heyo-sh/heyo-cms
# or: npm create @heyo-sh/heyo-cms@latest
```

Use Node 24+ for generated TypeScript CLI configs, or Bun.

Six questions — name, framework, deployment, database, media storage, package
manager — and a project that runs:

```bash
cd my-cms
cp .env.example .env
bun run db:migrate
bunx heyo-cms create-admin --email you@example.com
bun run seed
bun run dev
```

| Choice     | Options                         |
| ---------- | ------------------------------- |
| Framework  | `next`, `astro`, `react-router` |
| Deployment | `vercel`, `cloudflare`          |
| Database   | `postgres`, `mongodb`, `d1`     |
| Media      | `local`, `s3`, `r2`             |

Non-interactively:

```bash
bun create @heyo-sh/heyo-cms my-cms \
  --template react-router --deployment vercel \
  --database postgres --storage s3 --no-install
```

## What it writes

A project is four layers, and each one is a directory in this package:

- **`templates/<framework>`** — the framework, a front page that reads the CMS
  through `cms.api`, a typed same-origin `cmsClient`, and **one file that mounts
  the whole CMS**. Adding a collection or installing a plugin never touches it
  (section 10 of the plan).
- **`deployments/<platform>/<framework>`** — `vercel.json` or `wrangler.json`,
  the platform's cron, and whether this runtime can resize an image.
- **`databases/<database>`** — how the database is reached, and the initial
  migration.
- **`storages/<storage>`** — where uploaded files go.

The last three contribute `*.fragment` files rather than modules, and the
generator substitutes them into `heyo-cms.config.ts`. A generated project has
**one** configuration file: the database, the bucket and the image processor
sit at the top of it, above the collections. Three sibling modules would have
been easier to assemble and would have made the first sentence of the file a
reader opens ("one file, and the only one that describes it") untrue.

The structure follows `create-heyo-docs`, but CMS endpoints share a single
catch-all. Platform overlays only adapt bindings, bundling and deployment.

## Compatibility and verification

D1 on Vercel and local filesystem storage on Workers are rejected. Local
storage on Vercel is development-only; choose S3/R2 for deployment.
Cloudflare defaults to D1/R2. Its templates require `ai.complete` for AI and
an image CDN instead of the optional Node provider runtime/native codec.

`bun run example smoke` checks six framework/platform variants: Postgres/local
on Vercel development servers, D1/R2 on Workers development servers.
`bun run example build` checks production bundles. This is not verification
of live deployments or every database/storage permutation.

## Telemetry

The generator reports only version, framework, platform, database, storage,
package manager and OS/architecture. No names, paths, content or credentials.
Set `HEYO_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` to opt out; CI/tests are off
by default. Reporting is bounded and failure never fails project creation.

MIT.
