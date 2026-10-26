# @heyo-sh/heyo-cms

## 0.3.1

### Patch Changes

- 92a82cd: **`contains` no longer fails a query on a document whose value is not a list.**
  On Postgres, one document whose field held a JSON `null` — a post written
  without its many relation, say — made every `contains` query on that field fail
  with "cannot extract elements from a scalar"; on SQLite and D1 a lone string did
  the same with "malformed JSON". A filter that used to work stopped working the
  moment such a document was saved.

  `contains` now reads a lone value as a list of one and `null`, an object or no
  value at all as an empty list, on every engine — what MongoDB already did. A
  list is matched exactly as before.

- ac155f8: **A value a `unique` field already has is a `409`, not a `500`.** Saving a
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

## 0.3.0

### Minor Changes

- 3bedc6e: **No backwards compatibility.** What existed only so that something older
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

- 8cc6e04: **`list()`: rows of the same few fields, as a field.** An FAQ, the sources of
  an article, a change log — data with a structure that used to be either a
  `json` field nobody wanted to edit or a `textarea` with a format the editor
  had to remember and the site had to parse.

  ```ts
  faq: list({
    localized: true,
    fields: {
      question: text({ required: true }),
      answer: textarea({ required: true }),
    },
  }),
  ```

  The value is an array of row objects, stored as JSON in the document, typed
  from the row's fields (`{ question: string; answer: string }[]`, optional
  fields as optional keys) and validated row by row with the fields' own
  schemas; an undeclared key is an error. `minItems` and `maxItems` bound the
  list. The list carries `localized`, `required`, `access`, `label` and
  `description`; a row holds `text`, `textarea`, `email`, `url`, `number`,
  `boolean`, `date`, `select` and `multiselect` fields, and anything else — or
  `localized`, `unique`, `index`, `access` on a row's field — is refused when
  the configuration loads.

  The panel edits a list in place: each row is a small form with the row's
  fields, with buttons to move and remove it and one to add a row, at full
  width in the property pane; the list view shows the number of rows. `GET
/panel` describes the row as `fields` on the list's `PanelField`, the OpenAPI
  document describes it as an object with its required keys, and the AI
  assistant is told a row's fields (`rowFields`).

  A refused write now says where the problem is when a field's value has
  structure: `faq #2 question: is required` rather than the first message of
  the array's schema. Messages for fields without structure are unchanged.

### Patch Changes

- 0b2ceac: **`relation(to, { many: true })` accepts the list of ids it stores.** The
  column of a many relation is a JSON array and `depth` resolves it as one, but
  the field validated its value as a single id (`z.string()`), so every write of
  an array — from the panel's picker, the REST API or `cms.api` — was refused
  with "expected string, received array", and a single id was accepted and
  stored where a list belongs. The schema is now an array of non-empty ids
  (nullable unless `required`), which is also what the OpenAPI document
  describes, and the static type of the field is `string[]` instead of
  `string`.

## 0.2.0

### Minor Changes

- 225e7d7: **`convert: { to: "webp" }` now works on Cloudflare Workers.**
  `uploads.images.convert`, `maxDimensions` and `variants.mode: "pregenerate"`
  need an `ImageProcessor`, and the only one shipped was `sharpImages()` — a
  native module that a Worker cannot load. The Cloudflare templates therefore
  shipped without a processor, and those options could not be used there.

  `cloudflareImages()` from `@heyo-sh/heyo-cms/uploads` is a processor backed by
  the Workers Images binding (`env.IMAGES`), which resizes and re-encodes inside
  the runtime:

  ```ts
  import { cloudflareImages } from "@heyo-sh/heyo-cms/uploads";

  images: {
    processor: cloudflareImages(() => env.IMAGES),
    convert: { to: "webp", keep: ["image/gif", "image/svg+xml"] },
    maxDimensions: { width: 3840, height: 3840 },
  }
  ```

  The binding is typed structurally, so nothing is added to the dependencies,
  and it may be passed directly or as a (possibly async) function. Without a
  binding the upload fails with `image_processor_missing` rather than storing
  the wrong file. Crop and focal point are resolved by the same code
  `sharpImages()` uses and sent as a `trim`; the fit modes are translated
  (`inside` to `scale-down`, `contain` to `pad`, `outside` computed), and an
  image is never enlarged. JPEG, PNG, GIF and WebP are accepted as input.

  Two things differ from `sharpImages()`: the binding always re-encodes, so EXIF
  is always stripped and `stripMetadata: false` has no effect; and `wrangler dev`
  simulates the binding locally without applying `trim` or `gravity`
  coordinates, so a crop or focal point only shows in development with
  `"remote": true` on the binding.

  The configuration error for a missing processor now names both processors.

  **The generated Cloudflare projects use it.** `wrangler.json` declares
  `"images": { "binding": "IMAGES" }` and the `images` block in
  `heyo-cms.config.ts` now has the same `convert`, `quality`, `maxDimensions`
  and `crop` settings as the Vercel projects, resolving the binding the way the
  bucket and the database are resolved. Cloudflare bills transformations, so
  `DEPLOYMENT.md` says how to go back to serving the original with the size in
  the URL.

- 96a2f56: **`indexNow()` from `@heyo-sh/heyo-cms/plugins`, and the plugin API it needs.**

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

  The framework adapters hand a write's event delivery to the platform's
  `waitUntil`, so a serverless runtime does not freeze before webhooks,
  listeners and plugins have run. They find it themselves on Cloudflare
  (`locals.cfContext` in Astro, `context.cloudflare.ctx` in React Router,
  `platform.ctx` in SvelteKit, `event.waitUntil` in h3) and accept
  `cmsHandler(cms, { waitUntil })` elsewhere (Vercel's, OpenNext's).
  `cms.handler` itself is unchanged: `Request → Response`.

- 96a2f56: **Files at addresses made for the web, described for `<img>`, and a processor
  that fails without taking pages down.**

  - `uploads.publicPath: "/media"` serves the library at `/media/<id>/<name>`
    and `/media/<id>/<size>/<name>`, outside `basePath` (mount the handler there
    too), with an `ETag`, `HEAD`, and a year of caching. `MediaDocument.url`,
    `cms.media.url()`, `srcset`s and rich text point there.
  - `cms.media.url(file, { variant })`, `cms.media.srcset(file)` and
    `cms.media.image(file, { sizes, locale })` compute URLs, widths, heights and
    `srcset`s from the configuration — no request, no render.
  - `cms.media.renderRichText(doc, { locale, sizes })` resolves every library
    image in one query: public URL, `width`/`height`, `srcset`, lazy loading,
    and the library's alt text where the node has none. `?richText=html` on the
    REST API does the same; `richTextToHtml()` accepts a `mediaImage` resolver.
  - `cms.media.getMany(ids)` and `cms.media.forDocuments(collection)` — every
    file a collection's documents use, per document and locale, from
    `media_usages` (an image sitemap in two queries).
  - A processor that fails (Cloudflare's `9422` once a free quota is spent, an
    outage, an undecodable file) no longer fails the upload or the page: the
    original is stored or served, nothing is stored under the size's key, and
    `media.processing.failed` is emitted at most hourly per file and size.
    `image_processor_missing` still fails loudly.
  - A file already in the `convert` format is no longer re-encoded (a lossless
    WebP stays lossless), and a size that would not change the picture is
    answered with the original instead of a render.
  - `cloudflareImages()` sends `trim` as `{ top, left, width, height }`.

- 96a2f56: **`slug()`: a URL slug the engine looks after, on every write path.**

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

### Patch Changes

- b7cbcef: **SQLite no longer fails with "database is locked" when a second process
  writes to the same file.** That is the ordinary setup in development: the dev
  server and `heyo-cms seed` or `create-admin` next to it, or a Cloudflare
  project's local D1 under `.wrangler/state`, which the CLI opens directly while
  `wrangler dev` serves it. Two things made the second writer fail at once
  instead of waiting its turn:

  - `bun:sqlite` and `node:sqlite` open a database with a busy timeout of 0.
    `sqlite()` now sets `PRAGMA busy_timeout = 5000` — the default of
    `better-sqlite3` — unless the database already has one; the new
    `busyTimeout` option sets it explicitly (`0` restores the old behaviour).
  - Transactions opened with a plain `BEGIN`, which takes the write lock only at
    the first write. If another process wrote after the transaction's first
    read, SQLite refuses that lock immediately, timeout or not. The SQLite
    dialect now opens transactions with `BEGIN IMMEDIATE`, so the lock is taken
    — and waited for — up front. Postgres is unchanged, and D1 bindings, which
    have no interactive transactions, are not affected.

## 0.1.0

### Minor Changes

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

- a0603d9: Replace the document chat with a panel-wide AI assistant, and give every
  document a revision.

  **The assistant.** One agent, running in the CMS process, reachable from every
  signed-in screen. It calls typed tools that go through the ordinary public API
  with the signed-in actor and `source: "ai"`, so a change it makes runs exactly
  the same access control, field access, validation, hooks, media accounting,
  events and activity log as somebody typing into the form. There is no SQL tool,
  no database adapter, no `fetch`, no file read and no credential tool.

  - `ai.assistant` configures a model, one standing instruction and the budgets.
    Nothing else: what the agent may read and write is derived at runtime from
    the live configuration and the actor, so there is no second access-control
    system to drift from the real one.
  - `POST /ai/assistant` streams server-sent events with the CMS's own contract,
    independent of the agent library's internals. `POST /ai/assistant/plans/:id/approve`
    applies a stored plan.
  - A single unambiguous edit to an existing record saves immediately. Creating,
    deleting, restoring and anything touching more than one record become a plan
    with an expiry that a human approves; approving replays the stored row rather
    than asking the model again.
  - `@mariozechner/pi-agent-core` is a new optional peer dependency, imported
    lazily alongside `@mariozechner/pi-ai`. Without it the endpoint answers
    `ai_assistant_runtime_missing` by name.
  - New events `ai.agent.completed`, `ai.agent.failed` and
    `ai.agent.mutation.applied` carry run id, model, usage, duration, tool names
    and changed field names — never the prompt, the answer or the record.

  **Revisions (all writers, not only AI).** `documents` gains a `revision` column
  starting at `1` and incremented by every write, exposed on every read.
  `expectedRevision` on `update`/`delete`/`restore` — `If-Match` or `revision` in
  the body over HTTP — makes a write conditional and answers `409
revision_conflict` instead of overwriting. The panel sends it on every save and
  shows a conflict rather than silently winning. `CreateArgs`/`UpdateArgs` also
  accept `idempotencyKey`, recorded inside the write transaction so a retried
  request does not run the hooks and the outbox twice.

  The activity log gains a `source` column (`admin`, `rest`, `job`, `ai`, …),
  filterable through `GET /activity?source=ai`, and carries `runId` in `changes`
  for agent writes. The actor stays the human who asked.

  **Breaking.** The document chat is removed rather than deprecated:

  - `ai.chat` and `collection.ai.chat` are start-up errors with a migration
    message, including from untyped JavaScript. Ignoring a deployment's stated
    opinion about what AI may read, while shipping an agent that writes, would be
    the worst possible upgrade.
  - `POST /:collection/:id/chat` is gone and 404s; it is not redirected, because
    the replacement is not drop-in compatible.
  - `cms.ai.chat()` → `cms.ai.runAssistant()`; `PanelAi.chat` → `PanelAi.assistant`;
    `PanelCollection.chat` and `PanelChat` are removed, as is the panel's `AiDock`.

  Field actions (`field.ai`) are unchanged.

  Also fixes a latent bug in the MongoDB adapter: a conditional update re-read its
  rows through the original filter, so any update whose `WHERE` matched on a
  column it was about to change reported that it had modified zero rows.

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

- a0603d9: Create missing document and global language variants from the editor's locale selector, saving pending edits first. Optionally translate every localized text field with AI, preserving rich-text images, media IDs and links. Track which language fields actually exist independently of defaults, keep shared values intact and only save a new version once all translations succeed.
- a0603d9: **The `slug` field type is gone.** It was `text` with `unique`, `index` and a
  hyphen pattern already set, plus a `from` option that promised the value would
  be derived from another field and never did it — nothing in the engine
  generates one field out of another, so `from` only ever reached the panel as a
  placeholder. A type whose only feature is a default and a promise teaches the
  wrong thing. A URL handle is a text field:

  ```ts
  handle: text({
    unique: true,
    index: true,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  });
  ```

  and deriving it from the title is a `create.before` hook, which runs before
  validation precisely so that it can fill a required field. The templates, the
  examples and the documentation say so. Existing projects change the field type
  in the configuration; the column, the index and the stored values are
  identical, so the generated migration is empty.

  **The panel's property pane reads as a property pane.** Field names are muted,
  the way every other label that names something rather than being it is; the
  accordion's content clears the trigger row it opens out of; and the breadcrumb
  gives the `unsaved` badge room to breathe. A new document no longer carries
  the line "Nothing is written until you save." — the bar already says the
  document is unsaved, and nothing has been written anyway.

  **A `media` field is a drop zone, not a button.** The file being attached is
  nearly always on the laptop rather than in the library, and the gesture people
  reach for is dropping it on the field; it used to be a button that opened a
  dialog with a search box and a second upload button in it. The zone uploads
  what you drop or pick, the library is one link underneath for the file that is
  already uploaded, and a chosen file is a card with a thumbnail that you can
  drop a replacement onto.

  **The AI button closes the assistant.** It only ever opened it, which left the
  one conversational surface in the panel with no visible way out.

### Patch Changes

- a0603d9: Make the assistant's "this" mean what the editor is pointing at.

  `pageContext` is the only thing that gives "rewrite this", "translate this
  page" and "change the alt text of this image" a referent, and every failure in
  it is silent: the agent answers confidently about the wrong record. Six of
  them:

  - **A slug was resolved as a name.** The panel always sends the slug from the
    URL, but the lookup tried the configuration's keys first — so in a project
    where one collection is slugged `articles` and another is _named_ `articles`,
    the assistant read, described and offered to write the wrong one. Page
    contexts now match slugs only. A tool argument matching both a name and a
    different collection's slug is refused rather than picking a write target.
  - **The kind was not checked against the slug.** A document context naming a
    global resolved to the global, and `get_current_page` then failed with "no
    collection named site_settings" in the middle of a conversation. A context
    whose kind disagrees with what the slug names now resolves to nothing, which
    is the answer the prompt already knows how to handle.
  - **The open tab never travelled.** A record with two rich-text fields is two
    writing surfaces, and "rewrite this section" had no answer. `pageContext.tab`
    now carries the rich-text tab, the settings tab and the media library's
    status, and the prompt and `get_current_page` both name it. Only configured
    rich-text fields and known tabs can be interpolated into the system prompt;
    arbitrary text from a `?tab=` URL is discarded. `find_media` searches
    orphaned files by default when that is the open media tab.
  - **The media library's selection never travelled.** With a file open in the
    details pane, "this image" was unresolvable. `pageContext.mediaId` carries
    it, re-read through `cms.media` (media reads are public by design). The
    selected file's unsaved filename/crop/focal fields are now reported by name
    so the assistant refuses to overwrite that file until the form is saved.
  - **A new, unsaved form looked like a saved one.** `get_current_page` answered
    with the same keys as a stored record, which reads as "there is a record
    here, you just did not get it"; a list screen was equally silent about having
    no record at all. Both now say so, and a list points at `find_documents`.
  - **`runAssistant({ locale })` was declared and read by nothing.** A request
    with no page context silently used the project's default language. It is now
    the floor under the page's locale, and the panel sends the language being
    edited from every screen — including the ones with no record, where it was
    previously dropped entirely.

  On the panel side, `usePageContext()` no longer takes a dependency list: a
  screen that got it wrong (`dirty.size` rather than the field names) kept
  sending a stale set of unsaved fields, and the unsaved field the assistant was
  not told about is exactly the one it would have overwritten.

- a0603d9: Show TypeScript labels in API usage sheets. Add a read-only Deployment settings tab and show effective assistant model and limits in AI settings without exposing credentials or instructions.

## 0.1.0

### Minor Changes

- Stage 8: the panel — shadcn, TipTap v3, and one bundle for every deployment.

  - **`@heyo-sh/heyo-cms-admin` ships the panel**, and the integration is one
    line: `admin: { assets: adminAssets() }`. It is served by `cms.handler`
    under `admin.path`, so there is no second deployment, no CORS, no second
    build step — and it works on Workers, because the files are inlined into the
    package rather than read from a filesystem that is not there. The package has
    **no runtime dependencies**: React, TipTap, Radix and the table are compiled
    in.
  - **`GET /panel`: the configuration, as data.** The bundle is the same bytes in
    every deployment, so it learns what to render at runtime — collections,
    fields and their options, languages, media settings, the enabled sign-in
    methods, the trash deadline — all derived from the configuration, like the
    router and the OpenAPI document before it. A field added to a collection is
    in the form on the next page load. Public, because the sign-in screen is
    drawn from it, and it carries no content and no credentials: `ai.auth` and
    `webhooks.signing` are reported as "configured", never as their values.
  - **Two things cannot cross HTTP, and the payload says so rather than
    pretending.** An `admin.condition` is a function: the field is marked
    conditional and shown, because hiding content on a guess is worse than
    showing a field that did not apply. Access rules are **evaluated for the
    caller** without a record, so the panel knows whether to draw a "New" button
    or disable a select; the engine decides again, with the record, when the
    write arrives. The flags are advisory by construction.
  - **`AdminAssets.configure()`**, a new optional method on the stage-1 contract.
    A bundle is static and a mount point is not — the same files answer at
    `/api/heyo-cms/admin` in one project and `/cms` in the next — so the handler
    tells the bundle where it is while the router is built, once, and the shell
    is written with the right paths. Guessing from the browser's URL fails on the
    first deep link.
  - **Lists** are `@tanstack/react-table` over `admin.defaultColumns`, with
    filters expressed in the API's own query syntax (`?title[ilike]=`,
    `?status=`), sorting, `offset`/`count` paging and bulk delete.
  - **Forms are generated from `fields`** and honour field-level access: a field
    the actor may not read is absent (the engine removed it), one they may not
    write is rendered disabled with the value visible. `admin.position`,
    `admin.width`, defaults, descriptions and every built-in field type are
    covered, including pickers for `media` and `relation`.
  - **No autosave.** The draft belongs to the editor until they press Save, and
    **only the fields that changed are sent** — a `PATCH` carrying the whole
    document would overwrite what a colleague edited while the tab was open, and
    would push values the actor is not allowed to write.
  - **No publish button**, because there is no publish endpoint: `status` is an
    ordinary `select()` and publishing is writing to it. A writer sees it
    disabled, an editor sees it enabled, and the panel never implies a lifecycle
    the engine does not have.
  - **TipTap v3**: starter kit, tables, task lists, links, images, emoji,
    placeholder, underline, a slash menu, a bubble menu and a drag handle. The
    stored value is the ProseMirror document, never HTML, and an inserted image
    carries `mediaId` so the file counts as referenced. The emoji table is half a
    megabyte and is loaded as a separate chunk after the field is already usable.
  - **The media library puts the lifecycle on screen**: upload, crop, focal
    point, usages, and an "Unused" tab with the purge countdown the server set
    and a "Keep" button that clears the deadline without claiming anything
    references the file.
  - **Languages**: one switcher for the whole panel, and a value answered from
    another locale is badged with the language it came from — which is what
    `fallback.markAsFallback` exists to make possible.
  - **Trash** across every collection with its countdown and restore; **settings**
    for editors, roles, languages and API keys; the AI and webhook screens render
    what is configured and say that the runtime behind them arrives in stage 9,
    rather than offering a control that would do nothing.
  - **Styling is shadcn over Radix with semantic tokens** on `.heyo-cms`
    (`--panel-background`, `--panel-primary`, `--panel-border`, …), and every
    component's `className` wins over its own through `tailwind-merge`.
  - **The build enforces a size budget** and fails over it, which is what pushed
    the emoji table into its own chunk. First load is the entry, the shared chunk
    and the stylesheet.
  - **The panel is tested by being clicked.** A suite drives the real React
    application against a real `cms.handler` on SQLite — create, edit, publish
    through the select, trash, restore, a global — so "editor → draft → publish →
    trash → restore without touching the API" is asserted rather than claimed.
    `bun run example smoke` adds the shell, the bundle it references and
    `GET /panel` over a real socket.
  - `panel` joins the reserved route segments: a collection called `panel` would
    shadow the endpoint, and that is a start-up error with the fix in it rather
    than a surprise on the first request.

- Stage 5: scheduled changes, the trash and globals.

  - **Scheduled changes.** `cms.api.posts.schedule({ id, at, data })` stores a
    patch and a time; `cms.jobs.run()` applies it as an ordinary update, through
    the same write path, the same `update` hooks and the same events a human save
    produces — `document.updated`, one `document.field.changed` per field that
    actually changed, plus `document.schedule.applied`. There is no publish
    operation to schedule, so the patch may touch any field: a status, a price, a
    banner, three of them at once.
  - **Checked when scheduled, not when fired.** Access control, field-level write
    access and validation all run at `schedule()` time, so a writer who may not
    write `status` is refused on Tuesday instead of silently on Friday night. The
    change then carries the authority of whoever scheduled it, deliberately:
    re-deriving permissions at apply time would let a routine role change quietly
    cancel work an editor believed was finished.
  - **Applying claims first.** The schedule is cleared with a conditional update
    before the write, so two overlapping cron invocations cannot both apply it —
    the same portable trick the outbox uses, on all three engines, without a lock.
    If the write then fails, the patch is recorded in `jobs` (that row is the only
    remaining copy of it), `job.failed` is emitted, and the sweep continues.
  - **The trash.** `delete()` now sets `deleted_at` and a `purge_after` deadline
    when `trash.enabled` is on, which it is by default. `restore()`, `purge()` and
    `delete({ permanent: true })` complete the surface, and `cms.trash` lists,
    restores and purges across every collection at once — one keyset-paged query,
    with each collection's own `read` filter folded into it rather than applied
    afterwards.
  - **The `delete` hooks run once**, when the document leaves the live set. A
    purge thirty days later does not run them again, because a hook that
    decrements a counter must not decrement it twice for one document.
  - **A trashed document keeps its media usages and loses its schedule.** The
    first because an image used by a document you can still restore is not unused;
    the second because restoring a page must not detonate a publication that came
    due while it sat in the bin. A purge is the only operation that removes
    `media_usages` rows, so the trash never strands a reference and never leaves
    one behind.
  - **Retention is not a caller.** The purge sweep holds no permissions and never
    will: `purgeAfter` is a policy the configuration set and a human already
    triggered by deleting the document. People performing `restore` and `purge`
    need `collection:restore` and `collection:purge`, or the collection's own
    `delete` rule where it declares one — the one place section 4's "RBAC allows
    actions outside CRUD" becomes real.
  - **Globals.** `cms.globals.settings.get() / .update() / .schedule()`, on the
    same `documents` table, the same hooks, the same events and the same locales.
    `get()` never returns `null` and never writes: a global nobody has saved reads
    as its declared defaults with `createdAt: null`, and the row appears on the
    first save under an id derived from the slug, so two concurrent first saves
    cannot produce two rows. `databaseHooks` is keyed by globals as well as
    collections.
  - **`cms.jobs`.** A registry of sweeps — `scheduled-changes` and `trash-purge`
    today, `media-gc` in stage 6 — with `run()`, `failures()` and a report that
    says whether more work was waiting. Deliberately not a daemon: the deployment
    decides what calls it, because the CMS runs on Workers and Lambda as much as
    in a process that has timers.
  - Documents now carry `purgeAfter` and `scheduledPatch` alongside `deletedAt`
    and `scheduledAt`, so a panel can say "published on Friday" and "recoverable
    until the 12th" without computing either. The patch is exposed; the authority
    stored next to it is not.
  - `cms.inspect()` prints the registered sweeps and what a delete actually does.
  - New event: `document.schedule.cancelled`. The catalogue in section 7 had no
    way to say "that schedule is off", and reusing `document.scheduled` would make
    every subscriber announce a publication that is not coming.
  - **Fix: field names may be camelCase.** `siteName` and `seoTitle` were rejected
    by a rule meant for collection names, which made the documented `seoFields()`
    preset impossible to use. Collection names stay lowercase, because they become
    slugs and slugs are URLs; a dot stays forbidden in both, because `where: { "a.b": … }`
    addresses a path.

- Stage 4: editor authentication and RBAC.

  - `cms.auth`, the whole auth surface without HTTP: password sign-in, magic
    links, invitations, password resets, sessions, TOTP as a second factor,
    GitHub/Google/Microsoft OAuth, OIDC single sign-on with `mapRoles`, API keys
    and roles. The routes in stage 7 call exactly these functions, so there is
    never a second implementation to keep in step.
  - Web Crypto only — PBKDF2-SHA256 for passwords, SHA-256 for token hashes,
    HMAC for TOTP — so the same sign-in works on Node, Bun, Workers and the
    Vercel edge runtime without a native dependency.
  - The CMS mints single-use tokens and never sends email. `invite()`,
    `magicLink.request()` and `password.requestReset()` hand the token back; the
    matching event carries who it was for and never the secret.
  - A second factor cannot be stepped around: password and magic link both end
    in one function, so an account with TOTP returns a challenge from every door
    and a session from none of them until the code checks out. A challenge dies
    after five wrong codes.
  - API keys are an authentication method, not a feature: a key produces the
    same `Actor` a session does, its scopes are intersected with its owner's
    permissions — a read-only key on an administrator's account is read-only —
    and it carries the owner's id so ownership rules keep working.
  - RBAC: roles are `collection:action` patterns with `*` on either side,
    flattened once at sign-in. Roles can also be created in the panel
    (`rbac.customRoles`), and the configuration always wins a name collision.
  - **Declaring `rbac` changes the default.** A collection with no `access` rule
    for an operation then requires `collection:action` instead of being open. A
    rule that is declared stays the final word.
  - Field-level access decides who may publish, because there is no publish
    operation: `status` is an ordinary `select()` and the question is who may
    write it. A write to a field the actor may not write is refused rather than
    dropped; a field it may not read is absent rather than `null`, including
    through `depth`.
  - New system tables `cms_tokens` and `cms_accounts`, and
    `cms_users.two_factor_enabled` — a stored secret is an enrolment in
    progress, not a factor.
  - `cms.inspect().auth` prints the methods, the second factor, API keys, the
    SSO issuer and the configured roles.
  - Auth events (`user.invited`, `user.joined`, `user.removed`, `role.changed`,
    `apikey.created`, `apikey.revoked`) go through the engine's outbox, inside
    the transaction that caused them.
  - `bun run example smoke` now exercises sign-in, session resolution and a
    narrowed API key against a real Postgres.

- Stage 9: extensibility — fields, editor nodes, plugins, AI and webhooks.

  - **The AI runtime, and it lives on the field.** `POST /posts/:id/ai/:field/:action`
    runs exactly the actions `field.ai` declares, and a field with no key has no
    AI at all rather than a hidden one. There is a second route without an id,
    because a document being written for the first time only exists in the
    browser. pi (`@mariozechner/pi-ai`) is under the floor as an optional peer
    dependency, imported lazily and never mentioned in the configuration;
    `ai.complete` replaces it outright for a proxy, a self-hosted model or a
    test that must not make a network call.
  - **Nothing an action produces is written.** The answer is a value shaped for
    the field — a string, a ProseMirror document, an array of options that
    actually exist — and storing it is an ordinary save by a person, through the
    same hooks, validation and access control as typing it. Access is checked
    _before_ a token is spent, so a suggestion for a field the actor cannot
    write is refused rather than generated.
  - **Only the named context reaches a model.** `context` is per action; a field
    the actor may not read is removed from it first. Document chat requires
    `context` for the same reason and may only propose changes to fields inside
    it, filtered again by field-level access. Every call emits
    `ai.task.completed` with the action, the model and the token usage, or
    `ai.task.failed` with the error — through the outbox, so billing is a
    subscriber rather than a fork.
  - **`defineAiAction()`** registers an action on the same terms as the six
    built-ins (`generate`, `improve`, `summarize`, `translate`, `alt`, `tags`),
    which are themselves declared through it. The configuration refuses an
    action that does not apply to the field's type and a `translate` on a field
    that is not localized — both at start-up, naming the field.
  - **Provider keys can be managed in the panel** when `ai.storage.secret` is
    set: encrypted with AES-GCM before they are stored, never answered with (the
    panel sees the last four characters), and taking precedence over `ai.auth`.
    Rotating the secret invalidates them, which is what rotating a
    key-encryption key means, and the error says so.
  - **Webhook delivery, retries, the dead-letter queue and replay.** Every
    request carries `x-heyo-event-id`, `x-heyo-delivery-id`, `x-heyo-attempt`
    and an HMAC-SHA256 signature over `timestamp.body`; `verifySignature()` is
    exported from `@heyo-sh/heyo-cms/webhooks` so a consumer does not write the
    comparison by hand. Five attempts with exponential backoff, then the
    delivery is `failed` and stays in the table — a dead letter that disappears
    is one nobody can act on. A replay is a new attempt carrying the same event
    id, so idempotency keys still match and the original response stays
    readable. Subscriptions take exact types, families (`document.*`) or `*`,
    plus collection and locale filters, and may sign with their own secret.
  - **A failing subscriber never fails an event.** Delivery runs after the
    listeners and records its own failures; otherwise one unreachable endpoint
    would replay the event to everybody else on the next pass. The
    `webhook-retries` sweep joins `cms.jobs` when webhooks are enabled.
  - **`defineEditorNode()`, with mandatory serialisers.** A node is not
    registered unless it can render itself as HTML _and_ as Markdown. That is
    the whole reason the function exists: a node only the panel understands
    turns `GET /posts/1` into a shape no consumer knows. The built-in TipTap
    node set is declared through the same API, and `renderRichText()`,
    `richTextToHtml/Markdown/PlainText()` and `richTextFromMarkdown()` are
    exported from `@heyo-sh/heyo-cms/editor`.
  - **`?richText=html|markdown|text`** on any document or global read renders
    rich-text fields with those serialisers, resolving images through their
    `mediaId`. Opt-in, never the default: the stored value is the document, and
    silently answering with a string would make read-then-write destructive.
  - **The plugin loader is real.** A plugin's `schema.collections` become
    collections in every sense — routes, `cms.api`, the schema, RBAC;
    `extendCollections()` adds fields and hooks to collections it does not own;
    `migrations` are written into the migrations directory by `heyo-cms
generate`, after the schema diff, and recorded so a second run writes
    nothing. Collisions are start-up errors naming both sides, plugin hooks run
    before the configuration's own in `priority` order, and
    `cms.inspect().plugins` prints what each one actually contributed.
  - **Two job runners**, from `@heyo-sh/heyo-cms/jobs`: `startJobRunner()` for a
    process that owns a clock — it never overlaps itself and unrefs its timer —
    and `cmsScheduled()` for a platform that owns it, using `waitUntil` where it
    exists. Both drain the outbox after sweeping, which is not optional on
    serverless.
  - **The panel answers its own buttons.** The AI menu runs the action and
    offers the result for insertion; the chat shows proposals as a diff to
    approve; the webhook screen subscribes, sends a test event, shows the
    receiver's own response and replays a delivery; the settings screen stores
    provider keys. A plugin renders in the panel through `admin.scripts` —
    loaded before the first render, registering against `window.heyoCmsPanel` —
    and a custom node gets a TipTap extension built from `GET /panel`, so a
    document carrying one is never silently stripped.
  - `ai` and `webhooks` join the reserved route segments, and
    `cms_ai_credentials` the system tables.

- 1c8e346: Stages 1 and 2: contracts, fields, schema and database adapters.

  - Frozen contracts for the database adapter, the storage adapter, plugins,
    fields, hooks and the configuration, plus the one `HookContext` every hook
    receives.
  - `heyoCms()` and `defineCollection()` with eager validation: reserved names,
    slug collisions, relation targets, chat context, AI providers without
    credentials, webhooks without a signing secret.
  - A field registry built on the public `defineField()`, with thirteen built-in
    types and a `seoFields()` preset. Required-ness and literal options are
    carried into the inferred document type.
  - The schema layer: thirteen system collections, a snapshot built from the
    configuration, and a deterministic planner whose output is grouped into
    phases and ordered by foreign keys.
  - Four database adapters — Postgres, SQLite, D1 and MongoDB — behind one
    neutral `Query`/`Mutation` AST, all passing the same contract suite.
  - `heyo-cms generate | migrate | status`, diffing against a committed snapshot
    rather than a live database. There is no `push` mode.

- Stage 7: the HTTP layer — handler, auto-router, OpenAPI, typed client, adapters.

  - **`cms.handler`.** One `(request: Request) => Promise<Response>`, the only
    HTTP contract in the product. `basePath` (`/api/heyo-cms`) is stripped and the
    rest is matched against a router generated from the configuration, so **one
    catch-all route mounts everything**: CRUD per collection, globals, the media
    library, editor authentication, users and roles, the language registry, the
    trash, the audit trail, the sweeps, the OpenAPI document, the panel, and every
    route a plugin registered. A route added to the core or to a plugin tomorrow
    needs no change in the application (section 10).
  - **Every handler is three lines around `cms.api`, `cms.auth`, `cms.media`,
    `cms.trash` or `cms.jobs`.** Nothing in the HTTP layer knows about access
    control, hooks, locales, the trash or events; `cms.api.posts.find()` and
    `GET /posts` are the same operation rather than two implementations of the
    same intention. That is why the suite for this stage asserts statuses,
    parsing and headers and leaves behaviour to the engine suites.
  - **The router is the core's own, not a dependency.** The plan pointed at Hono;
    Better Auth, which the plan holds up as the pattern, writes its own for the
    reason that applies here too: the router ends up in the public contract, and
    `RouteContext` is a type plugin authors write against. A plugin ecosystem
    pinned to somebody else's router major version is exactly the framework
    coupling this project exists to avoid — and it keeps the installed size
    claim intact. It is ~200 lines: `:param`, a trailing `*`,
    static-before-dynamic precedence, `HEAD` answered from `GET`, 405 with an
    `Allow` header, and collisions detected at start-up naming both sides.
  - **Two filter syntaxes, one query language.** `?status=draft` and
    `?views[gte]=10` for curl; `?where=` carrying the JSON filter AST for
    anything composed, which is what the typed client sends. Both are built from
    the same `eq()`/`and()` helpers an access rule returns, both resolve a
    localized field inside the requested locale, and a path the collection does
    not declare is refused rather than passed through.
  - **Status codes are part of the contract.** `201` for a create; **`204` with
    `x-heyo-cms-stopped` when a `before` hook returned `false`** — the HTTP
    spelling of the local API's `null`, so the two cannot drift; `403` from access
    control; `404` for a document the actor may not see, because a `403` there
    would confirm it exists; `422` for validation. One error envelope,
    `{ error: { message, code, status } }`, built from the `CmsError` the engine
    already throws. An unexpected exception is logged server-side and answered
    without its message, because a driver error routinely contains a connection
    string.
  - **`hooks.before` / `hooks.after` wrap every request**, with the actor already
    resolved — a rate limiter that cannot tell an editor from a stranger is a
    rate limiter on the wrong thing. A `before` hook may answer instead of the
    route; an `after` hook gets writable headers and may replace the response.
  - **OpenAPI at `/openapi.json`**, generated from the configuration and from the
    router itself, so a route that answers is in the document by construction.
    Document schemas come from the zod schemas the field types already validate
    with — documentation and validation cannot disagree if they are the same
    object — with `x-heyo-cms-field`, `-localized`, `-required` and `-relation`
    for a panel or a generator. `info.version` is a fingerprint of the generated
    surface rather than the package version, because the endpoints come from your
    collections.
  - **`cms.inspect().routes`** prints every route in match order with its source
    and middleware count, and `cms.inspect().admin` prints where the panel is and
    whether a bundle is installed. This is the antidote to "magic": the generated
    surface is printable.
  - **The typed client** (`@heyo-sh/heyo-cms/client`), inferred from `typeof cms`
    with no code generation. The methods mirror `cms.api` deliberately — same
    arguments, same return types, including `null` for a stopped write — so code
    moves between the local API and the client by changing the object it is
    called on. Cookie or bearer, multipart uploads, `media.url()` as a string
    rather than a request, and `plugins: [...]` to install client extensions with
    their types. Errors arrive as the same `CmsError`, with the same `code`.
  - **Framework adapters, one file each**: `/next`, `/astro`, `/react-router`,
    `/sveltekit`, `/nuxt`. Ten lines apiece, no framework in the core's
    dependency tree, and SvelteKit or Nuxt pulls no React into `node_modules`.
    The Nuxt one is the only one with logic, because h3 does not hand over a
    `Request`: h3 v2, h3 v1 (streamed body, `node:stream` imported only on that
    path) and a plain `Request` are all accepted, duck-typed rather than
    importing h3.
  - **The panel is served from the same handler** under `admin.path` — no second
    deployment, no CORS. `admin.assets` is the contract stage 8 fills; until then
    that URL answers with a page that says what is missing and links to the
    generated spec, because a 404 is indistinguishable from a broken mount.
    Hashed filenames get `immutable`, the shell gets `no-cache`, and a deep link
    gets the shell while a missing `.js` stays a 404.
  - **`cms.locales`** — the language registry section 9 describes: rows when
    `i18n.locales` is `"dynamic"`, the configuration's list when it is a list,
    and the write methods refuse in the second case rather than writing rows
    nothing reads. Removing a locale does not delete the translations stored under
    it. **`cms.activity`** reads the audit trail the engine already writes, paged
    by the ordered row id. Both exist as instance methods because the routes call
    them, like everything else.
  - **Two new configuration keys, both because the HTTP layer made them
    necessary.** `admin.auth.deliverToken` — without it the magic-link and
    password-reset routes are **not registered**, because over HTTP the caller is
    an anonymous browser and returning the token would let a stranger request a
    link for an administrator and read it out of the response. And
    `admin.assets`, above. There is no sign-up route: accounts arrive by
    invitation or from SSO.
  - `RouteContext` gained `cms` (access control enforced) next to `db` (bypassed,
    by name — the same distinction hooks make), `body()`, `meta` shared with the
    HTTP hooks, and `database()` is now a function: a route serving a bundled
    asset or the OpenAPI document must not open a connection pool.
  - An image size may no longer be called `usages`, `keep`, `collect` or
    `upload`. Those are static media sub-routes, which win over
    `/media/:id/:variant`, so such a size would be unreachable rather than broken
    — and nothing would ever say so.
  - `bun run example up next` now **migrates, seeds and serves** the example's
    handler on its port: API, OpenAPI and panel, with an API token printed for
    curl. `bun run example smoke` adds the HTTP contract over a real socket
    against real Postgres — sign-in, the `HttpOnly` cookie, an anonymous read, a
    refused anonymous write, create, a field-level-gated publish, a filter, a
    multipart upload, a streamed variant, the trash, a purge and the panel.
  - The six framework × deployment examples are still not scaffolded: each needs
    its framework toolchain installed and the templates are the generator's job
    in stage 10. What they add over the configuration example is a dev server and
    a deployment overlay — the mount is one file, which `examples/next/api-route.ts`
    type-checks in CI, and every adapter is covered by `test/openapi.test.ts`.
    AI routes and webhook delivery arrive with their runtimes in stage 9; no
    placeholder routes were registered for them, so `cms.inspect().routes` stays
    a true statement.

- Stage 6: media — storage, processing and the lifecycle.

  - **`cms.media`.** Upload, library, variants, usages and collection, as methods
    rather than routes, for the same reason `cms.api` is: the REST endpoints in
    stage 7, the library screen in stage 8 and a seed script all get identical
    behaviour, including the parts that are easy to get wrong. Present whether or
    not `uploads` is configured; without a storage adapter every method answers
    with one error naming the missing section.
  - **Six storage adapters.** `local` and `memory` as before, plus `s3`, `r2`,
    `gcs` and `azure`. The cloud ones are four HTTP verbs over one transport and
    two signing schemes written out — AWS SigV4 and Azure shared key, on Web
    Crypto — rather than four vendor SDKs: an SDK per provider is the entire
    installation budget this project set itself (section 0). `r2()` takes either
    credentials or a Workers R2 binding, `s3()` takes an `endpoint` for MinIO,
    Tigris or Ceph, and all of them accept a `publicUrl` so a CDN serves what the
    bucket stores. Every one of them now runs the same storage contract suite.
  - **`StorageAdapter` gained two optional members.** `signedUrl()`, because a
    private bucket answers the plain URL with 403 and signing is asynchronous;
    and `prefix`, because where new objects live belongs to the bucket and to
    whatever lifecycle rules it carries, not to the engine.
  - **Nothing an edit does destroys a file.** Every save recomputes which files
    the document points at — per locale, including images inside rich text — and
    writes the result to `media_usages` inside the same transaction as the
    document. Losing the last reference marks a file `orphaned`: the bytes stay
    where they are and keep serving from the same URL, `purgeAfter` is set, and
    using the file again anywhere reclaims it with the deadline cleared.
  - **`media-gc` is the only thing in the product that deletes a file**, and the
    deadline is a necessary condition, never a sufficient one: every candidate is
    checked for references again immediately before its bytes go, because thirty
    days is long enough for somebody to have used it again. The claim is a
    conditional update, so two collectors cannot both delete the same object. A
    delete the bucket refuses is recorded in `purge_error` with the deadline
    pushed out rather than retried on every sweep. Registered in `cms.jobs` only
    when `uploads` is configured.
  - **The trash keeps its references on purpose.** A picture used by a document
    an editor can still restore is not an unused picture; a purge is the one
    operation that releases them, and whatever they pointed at is re-examined.
  - **Image work without a codec.** Dimensions are read from the file header for
    PNG, JPEG, GIF, WebP, AVIF and SVG, so `maxImageDimensions` is a real limit on
    every runtime and the stored MIME type is the one the bytes support rather
    than the one the browser claimed. `stripMetadata` removes EXIF, XMP and text
    chunks from JPEG, PNG and WebP in plain TypeScript — publishing the GPS
    coordinates embedded in somebody's holiday photograph is a privacy
    obligation, not an optimisation. ICC colour profiles are deliberately kept,
    because dropping them visibly shifts the colours of every wide-gamut
    photograph and is not what anybody asking for privacy meant.
  - **Resizing is pluggable.** `ImageProcessor` is a two-method interface and
    `sharpImages()` is the reference implementation, shipped as an optional peer
    dependency and imported the first time something asks for a pixel: a native
    module cannot load in a Worker, and a deployment that resizes at the edge has
    no use for one. It implements focal-point cropping by hand, because no image
    library takes a relative point and handing a cover resize `position:
"centre"` instead is how a CMS crops somebody's head off.
  - **`variants.mode`.** `on-demand` renders at first request, `pregenerate` at
    upload; both write the result into storage under a deterministic key, so the
    second request is a storage hit either way and a size added to the
    configuration next year applies to the whole archive. **`on-demand` without a
    processor is a supported deployment**: the original is served and its URL
    carries `?w=&h=&fit=&q=` for an image CDN to render at the edge. `convert`,
    `maxDimensions` and `pregenerate` do require a processor and say so while the
    configuration is still loading, as does a size with no dimensions or a
    `cover` with only one.
  - **Focal point and crop live on the file, not on the size**, so every variant
    inherits the decision an editor made once; changing either discards the sizes
    rendered from the old one. Both are stored in the `media.metadata` column
    under reserved keys and surfaced as fields, so enabling them is not a
    migration — and they are refused on write, so the rest of `metadata` stays
    yours.
  - **Deleting a file that documents point at is refused**, naming them, unless
    `force` is passed: "delete" in a media library is routinely clicked on the
    picture that is on the front page right now. The panel's "Keep" clears an
    orphan's deadline without claiming it is used again.
  - **Writing to the library needs `media:create` / `media:update` /
    `media:delete` when `rbac` is configured; reading does not.** A file's URL is
    public the moment it is on a page, so gating reads would break anonymous
    rendering and protect nothing that a private bucket and a signed URL do not
    already protect.
  - New events, through the same outbox as everything else: `media.uploaded`,
    `media.updated`, `media.orphaned`, `media.reclaimed`, `media.purged`,
    `media.processing.failed`.
  - `cms.inspect().storage` prints the adapter, the variant mode, the processor
    and the retention window — the only way to tell "the edge resizes" apart from
    "nothing resizes" from the outside.

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

- Stage 3: the engine — CRUD, hooks, events and transactions.

  - `cms.api`, the typed local API: `find`, `findOne`, `findById`, `count`,
    `create`, `update` and `delete` per collection, inferred from the fields. It
    is the code path the REST routes will call in stage 7, so there is never a
    second implementation to keep in step.
  - Query layer over the neutral AST: filters, sorting, offset and keyset
    pagination, `hasNextPage` without a second query, and `depth` resolved by a
    batch loader — one query per target collection per level, whatever the
    number of documents.
  - Hooks as specified in section 5: plugin hooks by priority, the
    configuration's own hooks last, one `HookContext`, and one return contract
    for all of them — `undefined` continue, `{ data }` replace, `false` stop
    silently, `throw CmsError` stop with a status. `cms.inspect().hooks` prints
    the order the engine actually runs.
  - A transactional outbox. `ctx.events.emit()` and the engine's own events
    (`document.created`, `document.updated`, one `document.field.changed` per
    changed field, `document.purged`) are written inside the transaction and
    delivered after the commit, with five retries and exponential backoff.
    `cms.drainEvents()` delivers now and waits. A rolled back write sends
    nothing; an engine without real transactions takes the documented
    compensating path instead of pretending.
  - One write path in the engine for every document write, so hooks, the outbox,
    the activity log and the future versions package attach in one place.
  - Per-read locale resolution with `i18n.fallback`, a per-call `fallbackLocale`
    override and `_fallback` metadata when `markAsFallback` is on.
  - Collection `access` is evaluated and a returned `Where` is added to the
    query — including the COUNT — rather than applied after fetching. Roles,
    field-level access and API keys remain stage 4.
  - The activity log is written by the engine, inside the transaction.
