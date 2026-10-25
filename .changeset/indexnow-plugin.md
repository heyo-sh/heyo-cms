---
"@heyo-sh/heyo-cms": minor
---

**`indexNow()` from `@heyo-sh/heyo-cms/plugins`, and the plugin API it needs.**

`indexNow({ key, url, collections, enabled })` tells the IndexNow engines
about a public page after every committed write — the address it has now and
the one it had — and serves the key file at `/<key>.txt`. A failed ping is
logged, never retried into other listeners.

Plugins gain two capabilities, which `indexNow()` uses and nothing else
needs to know about:

- `events: { "document.updated": listener }` — post-commit listeners,
  delivered from the outbox like `cms.on()`, registered before the first
  write.
- `routes: [{ root: true, … }]` — a route matched against the whole URL path
  rather than below `basePath`, for files a crawler fetches at a fixed
  address. Root routes are public: no actor, no HTTP hooks.

`cms.handler(request, { waitUntil })` hands a write's event delivery to the
platform, so a serverless runtime does not freeze before webhooks, listeners
and plugins have run. The adapters find `waitUntil` themselves on Cloudflare
(`locals.cfContext` in Astro, `context.cloudflare.ctx` in React Router,
`platform.ctx` in SvelteKit, `event.waitUntil` in h3) and accept
`cmsHandler(cms, { waitUntil })` elsewhere.
