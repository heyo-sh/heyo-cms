# Deploying to Cloudflare Workers

```bash
{{PACKAGE_MANAGER_RUN}} deploy
```

## Before the first deploy

1. **Create the database and put its id in `wrangler.json`** (D1 projects):

   ```bash
   {{PACKAGE_MANAGER_EXEC}} wrangler d1 create {{PROJECT_NAME}}
   ```

   Paste the `database_id` it prints over the `"local"` placeholder.

2. **Apply the migration**:

   ```bash
   {{PACKAGE_MANAGER_RUN}} db:migrate            # the local D1 under .wrangler/
   {{PACKAGE_MANAGER_RUN}} db:migrate:remote     # the deployed one
   ```

   For Postgres or MongoDB on Workers it is `heyo-cms migrate` with the
   connection string in the environment, exactly as anywhere else.

3. **Set the secrets** that are not bindings:

   ```bash
   {{PACKAGE_MANAGER_EXEC}} wrangler secret put CRON_SECRET
   ```

4. **Create an administrator**, once. For remote D1, set
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID` and
   `CLOUDFLARE_API_TOKEN` (D1 Edit permission) in your shell, then run:

   ```bash
   HEYO_D1_REMOTE=1 {{PACKAGE_MANAGER_EXEC}} heyo-cms create-admin --email you@example.com
   ```

   Without this explicit switch, the CLI uses local D1. Content export/import
   does not transfer accounts. Never commit the token.

## Optional Node-only features

The bundler aliases `sharp` and the default AI runtime to explicit errors.
Use an image CDN and, for AI, a Worker-compatible `ai.complete` implementation.
The CLI itself still runs on Node/Bun and does not use these bundler aliases.

## Images

Workers have no codec, so the `images` block in `heyo-cms.config.ts` ships
without a processor and
the named sizes are rendered on demand by whatever is in front of the bucket
(Cloudflare Images, or a CDN). EXIF is still stripped: the engine does that
itself, without a codec.

## The sweeps

Scheduled changes, the expired trash and the media collector run from the
cron trigger in `wrangler.json`, which the platform delivers to the
`scheduled` export in `workers/app.ts`. There is no HTTP cron route to
protect with a secret on this deployment — the clock belongs to Cloudflare.

`/api/cron` is still there for a local run or an external scheduler.

## The cache

The front page and `/posts/<handle>` are tagged `posts` and `posts:<handle>`
(see `heyo-cms.cache.ts`) and stored in the edge cache by the Worker entry. A
Worker runs in front of Cloudflare's cache rather than behind it, so nothing
is held unless the Worker puts it there — which it does only for responses a
view tagged, keeping the API, the panel and every signed-in page out of a
shared cache by construction.

Two things make it real:

1. **A custom domain.** The Cache API does nothing on a `workers.dev`
   subdomain. Attach the Worker to a zone you own.
2. **A purge token**, so a save empties every data centre rather than the one
   that happened to run it:

   ```bash
   {{PACKAGE_MANAGER_EXEC}} wrangler secret put CLOUDFLARE_ZONE_ID
   {{PACKAGE_MANAGER_EXEC}} wrangler secret put CLOUDFLARE_PURGE_TOKEN
   ```

   The token needs exactly one permission, Zone / Cache Purge, on that zone.
   Purging by tag is available on every plan.

Without the token nothing fails: the write hooks find no credentials, say
nothing, and the pages expire on their own an hour later.
