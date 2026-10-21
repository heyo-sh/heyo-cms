# Deploying to Vercel

```bash
{{PACKAGE_MANAGER_RUN}} deploy
```

## Before the first deploy

1. **Set the environment variables** from `.env.example` in the project's
   settings — at least the database URL and `CRON_SECRET`. Nothing in the
   repository reads a secret at build time, so they are only needed at
   runtime.
2. **Run the migration against the production database.** It is an ordinary
   SQL file and an ordinary connection:

   ```bash
   DATABASE_URL=... {{PACKAGE_MANAGER_EXEC}} heyo-cms migrate
   ```

   Deployments do not migrate themselves. A schema change that applied itself
   during a build is a schema change nobody reviewed, and on a rollback it is
   a schema the previous version does not understand.

3. **Create an administrator**, once:

   ```bash
   DATABASE_URL=... {{PACKAGE_MANAGER_EXEC}} heyo-cms create-admin --email you@example.com
   ```

## The cron

`vercel.json` calls `/api/cron` every fifteen minutes. That is what applies
scheduled changes, empties the expired trash and collects unused files. It
authenticates with `CRON_SECRET`, which Vercel sends as a bearer token.

Without it the CMS still works — nothing is lost — but a change scheduled for
Friday will not happen on Friday.

## Files

Vercel's filesystem does not survive the invocation that wrote to it, so
`local()` storage is for development only. Generate with `--storage s3` or
`--storage r2`, or edit the `storage` block at the top of
`heyo-cms.config.ts`.

## Images

This deployment runs on Node, so `sharp` renders the named variants
(the `images` block in `heyo-cms.config.ts`). A deployment that would rather
let a CDN resize can
drop the processor and keep `variants.mode: "on-demand"`.

## The cache

The front page and `/posts/<handle>` read through `unstable_cache` and carry
the tags `posts` and `posts:<handle>` (see `heyo-cms.cache.ts`). The write
hooks at the bottom of `heyo-cms.config.ts` call `revalidateTag` with the
same names, so an edit in the panel is visible on the site as soon as the
save returns — through Next.js's own data cache, which Vercel runs for you.
Nothing to configure and no webhook to point at yourself.

The hour in `revalidate: 3600` is the floor under a purge that never arrives
— a post written by `heyo-cms import` on a laptop has no request to purge
from — rather than how fresh the site is.
