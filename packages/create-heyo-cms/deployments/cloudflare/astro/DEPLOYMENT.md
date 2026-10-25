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

Workers have no codec, so the `images` block in `heyo-cms.config.ts` uses
the [Images binding](https://developers.cloudflare.com/images/transform-images/bindings/)
instead of `sharp`: `wrangler.json` declares `"images": { "binding": "IMAGES" }`,
and the binding converts uploads to WebP and renders the named sizes inside
the Worker, as `sharpImages()` does on the Node deployments. Transformations
are billed per unique transform; drop `processor` and `convert` to go back to
serving the original with the size in the URL for a CDN to render. EXIF is
stripped either way: the engine does that itself, without a codec.

`wrangler dev` simulates the binding locally. The simulator resizes and
converts, but it ignores the crop and the focal point an editor sets in the
panel, so a thumbnail is centred there. Add `"remote": true` to the `images`
binding in `wrangler.json` to check them against the real service (it needs a
Cloudflare login).

## The sweeps

Scheduled changes, the expired trash and the media collector need
`cms.jobs.run()` to be called. The Astro adapter builds its own Worker
entry, so there is no `scheduled` handler to hang them on — point any cron at
`/api/cron` with `CRON_SECRET`, or call `POST /api/heyo-cms/jobs/run` with an
API key holding `jobs:run`.

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
