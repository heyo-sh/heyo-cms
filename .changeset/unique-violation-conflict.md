---
"@heyo-sh/heyo-cms": patch
"@heyo-sh/heyo-cms-admin": patch
---

**A value a `unique` field already has is a `409`, not a `500`.** Saving a
document whose `unique: true` field repeated another document's value — or
creating one with an id that already exists — reached the caller as the
database driver's own error, which the handler answers with
`500 internal_error`. Every engine now turns a broken unique index into
`409 conflict`: for a content field the message names it (`posts: handle is
already used by another document, possibly one in the trash.`) and
`details.fields` carries it, like a validation error; for an explicit id the
message names the id. `cms.api` throws the same `CmsError`. The driver's error
stays on `cause` for the server log.

The panel showed "This document changed since you opened it" for every `409`,
including a slug somebody else already has. It now does that only for
`revision_conflict`; any other refused save is the toast alone.
