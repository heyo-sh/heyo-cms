# @heyo-sh/create-heyo-cms

## 0.1.0

### Minor Changes

- a0603d9: Generated projects now ship cached post views that empty themselves on save. Every template gets a list and a `/posts/<handle>` page, both tagged `posts` and `posts:<handle>` through a new `heyo-cms.cache.ts`, and `databaseHooks` in `heyo-cms.config.ts` purges those tags from the one write path — so the panel, `cms.api`, an API key, an import and a scheduled publication all invalidate the same way, with no webhook pointed back at the deployment. The purge is the only part that differs per platform: `revalidateTag` on Next.js (with KV and a sharded Durable Object configured in `open-next.config.ts` for Cloudflare), `@vercel/functions` CDN tags for Astro and React Router on Vercel, and the Workers Cache API plus a purge by tag on Cloudflare.
- a0603d9: `heyoCmsClient()` now defaults to the same-origin `/api/heyo-cms` mount. Generated projects export `cmsClient` and register their server CMS through a type-only `heyo-cms.client.d.ts`, so the no-argument browser client retains collection types without bundling server configuration. `heyoCmsClient<typeof cms>()` remains available for custom and multi-CMS clients.
- a0603d9: The first administrator can be created from the sign-in screen.

  A CMS whose `cms_users` table is empty has nobody to sign in as, so the panel
  now offers to create that account instead of asking for a password that does
  not exist — `heyo-cms create-admin` is no longer the only way in, and the
  generated projects no longer print it as a required step.

  The offer closes behind the account it creates: `POST /auth/setup` is
  registered only while there are no accounts, and the count is taken inside the
  transaction that does the insert, so two browsers racing produce one
  administrator and one 409. `GET /panel` reports it as `auth.setupRequired`,
  `cms.auth.setup` is the same thing without HTTP, and
  `admin.auth.firstUser: false` turns it off for deployments that provision
  editors from a pipeline. `firstUser: { roles: [...] }` names the roles the
  first account is given; the default is `admin`.

- a0603d9: **`i18n` is a list of codes.** It used to be three decisions in a trench coat
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

## 0.1.0

### Minor Changes

- Prepare the first 0.1.0 release under MIT.

  - Ship the project generator with Next.js, Astro and React Router templates,
    Vercel/Cloudflare overlays, Postgres/MongoDB/D1 migrations and local/S3/R2
    storage. Support Bun, pnpm, npm and Yarn, including `--no-install`.
  - Add create-admin, idempotent project seeds, streaming NDJSON content
    export/import and inspectable, opt-out CLI adoption telemetry. Content
    transfer preserves IDs and translations, invokes normal hooks, and excludes
    accounts, media files and operational history.
  - Exercise all six framework/platform starters over real development servers,
    and add production-build checks including OpenNext's Worker bundle.
  - Add a heyo-docs documentation site, per-framework quickstarts, API/operations
    guides and a Payload migration guide. Record reproducible, scoped benchmark
    measurements against Payload 3.90.2.
  - Document deployment boundaries: durable storage on serverless platforms,
    Worker-compatible image/AI transports and explicit remote D1 administration.
