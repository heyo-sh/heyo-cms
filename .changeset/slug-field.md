---
"@heyo-sh/heyo-cms": minor
"@heyo-sh/heyo-cms-admin": minor
---

**`slug()`: a URL slug the engine looks after, on every write path.**

```ts
slug: slug({ from: "title", localized: true, history: true });
```

Made from `from` once while empty (retitling never moves it), cleaned when
typed (`"Łódź & Kraków"` → `lodz-krakow`, with Latin, Cyrillic and Greek
transliterated, or by a `slugify` of your own), unique per language — trashed documents included — with
`-2`, `-3` suffixes when generated and a `409` when typed. With `history`, a
slug a document stops using becomes a previous address in the new
`slug_history` table (`heyo-cms generate` adds it only for configurations that
keep history): nobody else may take it, and it goes when the document is
purged.

`cms.api.<collection>.resolveSlug(slug, { locale })` finds a document by a
current slug, one from another language, or a previous one, and says which
(`current`, `locale`) — the lookup behind a page route and its 301s.
`previousSlugs`, `addPreviousSlug` (merging two pages) and
`removePreviousSlug` manage the history, with the REST routes
`GET /<collection>/resolve-slug` and `/<collection>/<id>/previous-slugs`, and
the same methods on the client. The panel lists a document's previous slugs
under the field, where an editor can add and remove them. `slugify()`,
`isSlug()` and `slugPattern` are exported from `@heyo-sh/heyo-cms/fields`.
