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

Scheduled changes, the expired trash and the media collector need
`cms.jobs.run()` to be called. The Next.js adapter builds its own Worker
entry, so there is no `scheduled` handler to hang them on — point any cron at
`/api/cron` with `CRON_SECRET`, or call `POST /api/heyo-cms/jobs/run` with an
API key holding `jobs:run`.

## The cache

The front page and `/posts/<handle>` read through `unstable_cache` and carry
the tags `posts` and `posts:<handle>` (see `heyo-cms.cache.ts`). The write
hooks at the bottom of `heyo-cms.config.ts` call `revalidateTag` with the
same names.

On Workers that cache has to be given somewhere to live, which is what
`open-next.config.ts` does — and it needs one namespace created before the
first deploy:

```bash
{{PACKAGE_MANAGER_EXEC}} wrangler kv namespace create NEXT_INC_CACHE_KV
```

Paste the id it prints over the `"local"` placeholder in `wrangler.json`. The
tag half is a Durable Object: the binding and its migration are already in
`wrangler.json`, the class is exported by the generated Worker, and there is
nothing to create.

Skip both and the site still works — `revalidateTag` becomes a no-op and the
views read the database on every request.
