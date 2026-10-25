---
"@heyo-sh/heyo-cms": patch
---

**`relation(to, { many: true })` accepts the list of ids it stores.** The
column of a many relation is a JSON array and `depth` resolves it as one, but
the field validated its value as a single id (`z.string()`), so every write of
an array — from the panel's picker, the REST API or `cms.api` — was refused
with "expected string, received array", and a single id was accepted and
stored where a list belongs. The schema is now an array of non-empty ids
(nullable unless `required`), which is also what the OpenAPI document
describes, and the static type of the field is `string[]` instead of
`string`.
