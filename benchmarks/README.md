# Benchmarks

Measured locally on 2026-10-03: Apple M4 / macOS 15.5 arm64,
Node 24.7.0, npm 11.5.1, Bun 1.3.1. Heyo CMS stage-10 release candidate,
Payload **3.90.2**, Next.js **16.3.8**. These are local samples, not cloud
cold-start guarantees or a feature-equivalent application comparison.

| Measurement                                                     |               Heyo CMS |                  Payload |
| --------------------------------------------------------------- | ---------------------: | -----------------------: |
| Headless core + Postgres driver, installed tree                 | 10.6 MiB / 16 packages | 170.1 MiB / 203 packages |
| Fresh process: import + configure two collections (median of 5) |                36.9 ms |                 380.8 ms |
| Next.js production build, empty `.next` (median of 3)           |                 3.29 s |                   7.28 s |

## Boundaries

- Size is `du -sk node_modules` in separate npm projects: Heyo tarball +
  `pg@8.23.1`, versus `payload@3.90.2` + `@payloadcms/db-postgres@3.90.2`.
  Optional peers were not installed. No framework, panel, image processor,
  database service or AI provider runtime is included. Filesystem allocation
  varies; these are not download sizes. Raw KiB: **10876** and **174136**.
- Cold process measurement uses `cold.mjs`: dynamic imports and configuration
  construction, **no connection, query, HTTP request, serverless boot or Node
  process launch time**. OS filesystem caches are warm after the first run.
  Both configurations have two collections with title/body fields. The APIs
  perform different initialization work; this is not request latency.
- Build: generated `next-vercel` (panel, public page, roles, rich text, globals,
  API and cron) versus the minimal checked-in `payload/` fixture (panel, REST,
  two text-only collections, Payload's auth defaults). Both use the same Next
  version and Node command with no reachable database. Heyo's panel is
  prebuilt in its published package; Payload's panel is built with the app.
  Heyo externalizes its Node CMS runtime; both apps use isolated npm installs.
  Different features and prebuilt dependencies limit direct comparison: this
  does not establish a general build-speed ratio or include building Heyo's
  published packages from source.
- Heyo build samples: 3.51, 3.29, 3.19 seconds. Payload: 6.41, 7.35, 7.28.
- Heyo bootstrap samples: 37.1, 36.8, 36.9, 36.6, 37.0 ms.
  Payload: 685.7, 380.6, 390.2, 380.8, 378.7 ms.

## Reproduce

Build Heyo with `bun run build`, then `bun pm pack` in `packages/heyo-cms`.
Use **new temporary directories outside this workspace** for the two installs:

```bash
# In each directory, create a private package.json with "type": "module".
npm install /absolute/path/to/heyo-cms.tgz pg@8.23.1 --no-audit --no-fund
# In the other directory:
npm install payload@3.90.2 @payloadcms/db-postgres@3.90.2 --no-audit --no-fund

# Copy benchmarks/cold.mjs into each directory, then:
node cold.mjs heyo       # or payload; repeat in five separate processes
du -sk node_modules
npm ls --all
```

For build timings, scaffold the Heyo example using `bun run example build
next-vercel`. Copy `benchmarks/payload/` outside the workspace and run
`npm install`. In each project repeat three times:

```bash
rm -rf .next
DATABASE_URL=postgres://127.0.0.1:1/unreachable NEXT_TELEMETRY_DISABLED=1 \
  /usr/bin/time -p node node_modules/next/dist/bin/next build
```

Record versions, environment and successful exits with any new result. Do not
compare a cached build to an empty-cache build, or a headless install to one
that includes a framework/panel. The fixture is a benchmark, not a deployment:
its secret is public, its database URL is intentionally unreachable.
