---
"@heyo-sh/create-heyo-cms": minor
---

Generated projects now ship cached post views that empty themselves on save. Every template gets a list and a `/posts/<handle>` page, both tagged `posts` and `posts:<handle>` through a new `heyo-cms.cache.ts`, and `databaseHooks` in `heyo-cms.config.ts` purges those tags from the one write path — so the panel, `cms.api`, an API key, an import and a scheduled publication all invalidate the same way, with no webhook pointed back at the deployment. The purge is the only part that differs per platform: `revalidateTag` on Next.js (with KV and a sharded Durable Object configured in `open-next.config.ts` for Cloudflare), `@vercel/functions` CDN tags for Astro and React Router on Vercel, and the Workers Cache API plus a purge by tag on Cloudflare.
