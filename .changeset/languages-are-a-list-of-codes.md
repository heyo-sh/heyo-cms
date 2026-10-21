---
"@heyo-sh/heyo-cms": minor
"@heyo-sh/heyo-cms-admin": minor
"@heyo-sh/create-heyo-cms": minor
---

**`i18n` is a list of codes.** It used to be three decisions in a trench coat
— a registry mode, a locale shape, and a fallback grammar with two modes and a
flag:

```ts
// before
i18n: {
  locales: "dynamic",
  defaultLocale: "en",
  fallback: { mode: "default-locale", markAsFallback: true },
}

// now
i18n: { defaultLocale: "en", locales: ["en", "fr"] }
```

Codes and nothing else. The English name of a language and whether it is
written right to left follow from the code, so `locales: ["pl"]` is enough for
the panel's switcher to read "Polish" — `localeName()`, `isRtlLocale()` and
`LOCALE_NAMES` are exported for anything else that needs the same table. The
configuration is checked while the module loads: `defaultLocale` has to be one
of `locales`, codes have to be BCP 47 tags, and duplicates are refused.
Leaving the section out is the same as `{ defaultLocale: "en", locales:
["en"] }`, so a single-language site says nothing at all.

**Fallback is one rule instead of a configuration section.** A field with no
value in the language being read is answered from `defaultLocale`, and the
document names the fields that happened to in `_fallback` — what the panel's
"from en" badge and a frontend's "untranslated" badge both read. A single call
still overrides it: `fallbackLocale: false` shows the gaps, a code forces one
source. `fallback: { mode: "chain", … }` is gone; a chain was a per-locale
graph that no deployment could keep true after the second language.

**Languages are configuration, so the registry is gone.** `POST /locales`,
`DELETE /locales/:code`, `cms.locales.create/remove`, the client's equivalents,
the `locales` table and the `locale.created` / `locale.deleted` events no
longer exist. `GET /locales` and `cms.locales.list()` stay and answer from the
configuration, now synchronously. The panel's Languages tab lists what is
declared instead of offering to add a row the next deploy would contradict.
Adding a language is a line in `i18n.locales`; removing one leaves the
translations stored under the code untouched, so putting it back brings them
back.

Migrating: replace `locales: "dynamic"` with the codes you have registered,
drop `fallback` (the default-locale behaviour it described is now the only
one), and drop the `locales` table — `heyo-cms generate` writes that migration
for you.
