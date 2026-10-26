---
"@heyo-sh/heyo-cms": patch
---

**`contains` no longer fails a query on a document whose value is not a list.**
On Postgres, one document whose field held a JSON `null` — a post written
without its many relation, say — made every `contains` query on that field fail
with "cannot extract elements from a scalar"; on SQLite and D1 a lone string did
the same with "malformed JSON". A filter that used to work stopped working the
moment such a document was saved.

`contains` now reads a lone value as a list of one and `null`, an object or no
value at all as an empty list, on every engine — what MongoDB already did. A
list is matched exactly as before.
