---
"@heyo-sh/heyo-cms": minor
"@heyo-sh/create-heyo-cms": minor
---

`heyoCmsClient()` now defaults to the same-origin `/api/heyo-cms` mount. Generated projects export `cmsClient` and register their server CMS through a type-only `heyo-cms.client.d.ts`, so the no-argument browser client retains collection types without bundling server configuration. `heyoCmsClient<typeof cms>()` remains available for custom and multi-CMS clients.
