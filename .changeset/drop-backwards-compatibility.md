---
"@heyo-sh/heyo-cms": minor
---

**No backwards compatibility.** What existed only so that something older
kept working is gone:

- `ai: { generate }` on a field. Generation is `aiGenerate`; `generate` in
  the `ai` map is refused when the configuration loads. The `ai` map is for
  the field's other actions (`translate`, `improve`, `summarize`, `alt`,
  `tags`, custom ones).
- The start-up errors for the removed document chat (`ai.chat`,
  per-collection `ai`).
- Importing a dump in which a localized field holds one value instead of one
  per language: the record is refused instead of the value being taken as
  the default language.
- `locals.runtime.ctx` in the Astro adapter (Astro 5 and earlier); the
  adapter reads `locals.cfContext`.
