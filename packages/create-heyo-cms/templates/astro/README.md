# {{PROJECT_NAME}}

A [Heyo CMS](https://heyo.sh) project on Astro.

## Run it

Use Node 24+ for the CLI or run it through Bun. Local storage is development
only; deploy with S3/R2. Cloudflare defaults to D1/R2 (see `DEPLOYMENT.md`).

```bash
cp .env.example .env     # set the database URL
{{PACKAGE_MANAGER_RUN}} db:migrate          # apply the migration in migrations/
{{PACKAGE_MANAGER_RUN}} seed                # one page and one post, optional
{{PACKAGE_MANAGER_RUN}} dev
```

- the site — http://localhost:4321
- the panel — http://localhost:4321/api/heyo-cms/admin
- the API — http://localhost:4321/api/heyo-cms/posts
- the OpenAPI document — http://localhost:4321/api/heyo-cms/openapi.json

Open the panel: with no accounts yet it asks you to create the administrator,
and closes that form behind the account it creates. From a shell instead:
`{{PACKAGE_MANAGER_EXEC}} heyo-cms create-admin --email you@example.com`.

## The files that matter

| File                                                      | What it is                                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `heyo-cms.config.ts`                                      | the whole CMS: the database, the bucket, what resizes an image, and then the collections, fields, roles and languages |
| `heyo-cms.client.ts`                                      | the same-origin browser client: `cmsClient`                                                                           |
| `heyo-cms.client.d.ts`                                    | type-only link from that client to the CMS configuration                                                              |
| `heyo-cms.cache.ts`                                       | the tags the post views are cached under, and the purge a write performs                                              |
| `src/pages/api/heyo-cms/[...path].ts`                     | the entire HTTP surface, in one catch-all                                                                             |
| `src/pages/api/cron.ts`                                   | the sweeps, called by the platform's cron                                                                             |
| `src/pages/index.astro`, `src/pages/posts/[handle].astro` | the two cached views: a list and one post                                                                             |
| `migrations/`                                             | what has been applied, and what is pending                                                                            |

## Changing the content model

Edit `heyo-cms.config.ts`, then:

```bash
{{PACKAGE_MANAGER_RUN}} db:generate   # writes a migration — read it
{{PACKAGE_MANAGER_RUN}} db:migrate    # applies it
{{PACKAGE_MANAGER_RUN}} db:status     # what is applied, pending or unplanned
```

There is no `push` mode: every schema change leaves a file in the repository
that you can review, roll back and reproduce.

## Content in and out

```bash
{{PACKAGE_MANAGER_RUN}} content:export   # NDJSON, every locale intact
{{PACKAGE_MANAGER_RUN}} content:import   # into another deployment
```

This transfers collection/global content, not accounts, media-library rows,
files or history. Timestamps are new, trashed records are skipped, and imports
run hooks. Register destination locales and copy media separately.

## Reading content in your own pages

`cms.api` is the engine without HTTP — same access control, same hooks, typed
from your collections. See `src/pages/index.astro`.

```ts
import { cms } from "../../heyo-cms.config.ts";

const { docs } = await cms.api.posts.find({ limit: 10 });
```

## Telemetry

The generator reports framework/platform choices; the CMS CLI reports
runtime/OS, adapter IDs, configuration counts, feature flags and a shape hash.
It never sends content or credentials; a running server never phones home. `{{PACKAGE_MANAGER_EXEC}} heyo-cms telemetry`
prints the exact body. `HEYO_TELEMETRY_DISABLED=1` turns it off.
