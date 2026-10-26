# @heyo-sh/heyo-cms-admin

## 0.3.1

### Patch Changes

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

- Updated dependencies [92a82cd]
- Updated dependencies [ac155f8]
  - @heyo-sh/heyo-cms@0.3.1

## 0.3.0

### Minor Changes

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

- Updated dependencies [3bedc6e]
- Updated dependencies [8cc6e04]
- Updated dependencies [0b2ceac]
  - @heyo-sh/heyo-cms@0.3.0

## 0.2.0

### Minor Changes

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

- Updated dependencies [225e7d7]
- Updated dependencies [96a2f56]
- Updated dependencies [96a2f56]
- Updated dependencies [96a2f56]
- Updated dependencies [b7cbcef]
  - @heyo-sh/heyo-cms@0.2.0

## 0.1.0

### Minor Changes

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

- a0603d9: The panel gets a sidebar you can fold, rows you can click, and one of each
  state instead of three.

  **The sidebar.** Content and Globals are sections that fold away, so a
  deployment with forty collections no longer pushes Media, Trash and Settings
  off the bottom of the rail. The header is the Heyo mark on the same vertical
  line as the icons under it, instead of an initial in a square next to the
  deployment's name — the trail already opens with that name, and a sidebar
  header is not where you learn which project you are in. The search is a
  button shaped like a field, with the shortcut spelled for the platform (⌘K on
  a Mac, Ctrl K elsewhere) pinned to its right edge; on the collapsed rail it is
  the icon alone. The collapse control is gone from the sidebar — the page bar
  has one at the trail's level, and two triggers for one piece of state is one
  too many.

  **A record opens from its row.** The whole row, not the title in the first
  cell, which turned a 1200px-wide row into a 90px target. Rows are tab stops
  and answer Enter, the trash opens a deleted document the same way, and the
  cells that hold their own controls — a checkbox, Restore, Replay — keep their
  clicks to themselves. Conversely an empty state is marked as what it is, so it
  stops lighting up under the cursor promising something to click.

  **One empty state and one loading state.** Every "nothing here" is the same
  `Empty` — icon, title, sentence, the action that fixes it, a muted hint — and
  every wait is `<Spinner size="sm" />`. The skeletons are gone: a skeleton is a
  promise about a layout, and a panel whose layout arrives from `GET /panel`
  cannot make it. It was drawing five fake rows for a collection that turned out
  to be empty.

  **One measure per shape.** A screen that is a column of fields — a global, a
  collection with no sidebar fields — is `max-w-2xl` rather than `max-w-6xl`,
  because a label on the far left and its input 70rem away is not a form.
  Tables, grids and two-pane screens keep the width.

  **Settings.** Its sections are a segmented `Tabs` in a strip under the trail,
  with the same height and hairline as the trail itself, and the trail stays
  `Settings` on every tab — the tabs are already saying which section is open.
  The media library's Library/Unused switch and its filter moved into the same
  kind of strip. Labels above a `Select` are laid out by `Field` now, so the gap
  under "Role" in the invite dialog matches every other control in the panel.

  **Signing up.** The two passwords on the first-account screen are compared
  when you submit, not while you are still typing the second one.

  Under all of it, the pinned copy of heyo-ui carries
  [heyo-ui#10](https://github.com/heyo-sh/heyo-ui/pull/10): overlays have one
  layering scale, so the role select in "Invite an editor" opens over the dialog
  instead of behind it and a tooltip is never covered.

- a0603d9: The panel gets one bar, real confirmations and a usable image editor.

  **One bar instead of two.** The shell drew a strip with the language and the
  colour scheme in it and the document screen drew a second one underneath with
  the trail and the buttons, which spent forty-eight pixels saying nothing
  twice. There is one row now — `⌘B` trigger, breadcrumb, status, language,
  actions — and every screen wears it, so "where am I" is answered the same way
  everywhere instead of once with a heading, once with a back button and once
  not at all. The language switcher moved into that row at the trail's level,
  because the language is part of the address of what is on screen. The
  colour-scheme toggle moved into the account menu, where a preference set twice
  a year belongs.

  **Nothing destructive happens without a sentence first.** `window.confirm` is
  gone. Deleting a document, emptying a selection, purging from the trash,
  revoking an API key, deleting a webhook subscription or removing a language
  now opens a dialog that names what will happen, keeps its button spinning
  until the request settles, and shows the server's refusal inside itself rather
  than as a toast over a screen that has already moved on. Leaving a screen with
  unsaved changes asks too, and lists the fields.

  **The rich-text field no longer marks every document unsaved the moment it
  opens.** ProseMirror reports its own normalisation as an update — the editor
  rebuilds once when the emoji table lands, and parsing a stored document fills
  in default attributes — and the panel was treating both as edits. The badge,
  the Save button and the leave-confirmation all lied; now they do not.

  **The media pane is a `Sheet`.** It used to be a card wedged into the grid,
  taking a column from the thing it described. It floats off the edge now,
  leaves the library live underneath — picking the next file is one click — and
  the page makes room for it instead of being covered by it.

  **Focal point and crop are a feature you can see.** Two toggle buttons used to
  put the panel into a mode and explain, in a sentence, what clicking would do;
  nothing on screen ever showed what either had achieved. The point is a handle
  you drag with a crosshair, the crop is a rectangle you can draw, move, resize
  from any corner and snap to a ratio, and under both sit three frames — square,
  wide, portrait — rendered the way a variant renders, so the consequence of
  moving either one is visible rather than described.

  **The writing screen is a writing screen.** Title, a toolbar measured to the
  prose rather than to the window, and the document chat docked at the foot of
  the column instead of hidden behind an icon in the header. The dock is visible
  even when AI is not configured, with the reason where the placeholder goes and
  a way to fix it, because a feature nobody can see is a feature nobody reports
  as missing.

  **⌘K** opens a palette over every collection, global, screen and — through the
  same `?title[ilike]=` the list screens use, with the same access rules — every
  document whose title matches what has been typed.

  Plus: empty tables say what they are empty of instead of showing a head with
  nothing under it, the trash's Restore and Purge no longer wait for a hover
  that a touch screen never performs, `⌘S` saves, the account row in the sidebar
  has a gap between the avatar and the name, and `Optional` is no longer printed
  against eleven of a collection's fourteen fields.

### Patch Changes

- a0603d9: **The sign-in screen's second column is a drawing now, and a seam separates
  it from the form.** The auth layout always reserved half the screen on wide
  viewports and then left it blank: a column of page colour whose only job was
  to make the form look centred against something, with nothing between the two
  halves. The column is now one step deeper than the page (`recessed`, the token
  wells and code blocks already use) and the split is closed by
  `--color-heyo-hairline` — the same rule every other division in the panel is
  drawn with, from the media library's details pane to the page bars — so the
  card on the left reads as the lit side without a shadow doing that work.

  What stands in the column is **Layout**: a page taken apart into the blocks it
  is made of — a title bar, a media block, two columns of text and a footer,
  each floating over the place it came from on two dashed drops. That is what
  the panel behind the form is for; a page here is not a file, it is these
  pieces. The pointer is projected back onto the page and every block rises by
  its distance to it, each on its own spring, so the answer spreads out and
  falls off rather than switching, and the block under the pointer takes the one
  bright stroke. At rest the blocks already sit at uneven heights with the media
  block lit, and left alone the figure walks that lap by itself, giving way the
  moment a real pointer or the keyboard arrives.

  It is drawn, not downloaded: isometric line work on the Hairline engine
  (`src/app/art/hairline-kernel.js`, vendored unchanged under MIT, with its
  licence beside it), one SVG built at runtime, no request and about 29 KiB of
  the bundle. The palette is five CSS variables mapped onto heyo tokens in
  `styles.css`, so the figure follows the panel's colour mode and a deployment
  that overrides the tokens gets a figure that matches; nothing in the figure
  sets a colour of its own. Motion is the engine's single frame loop: it sleeps
  while the figure is off screen, and under `prefers-reduced-motion` every
  spring lands at once. Under 768px, where the form is the whole screen, the
  column is still `display: none`, and in a DOM without `IntersectionObserver`
  nothing mounts.

- a0603d9: Add context-aware API usage sheets to the panel's content and settings screens, with server and HTTP client examples and a guide link.
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

- a0603d9: **The document pane says Fields, once.** The right-hand pane on
  `/c/:collection/new` and `/c/:collection/:id` called itself "Properties" in
  its header strip and then opened an accordion whose only item was labelled
  "Fields" — two names for one list, and a disclosure with nothing to disclose:
  there is no second section for it to collapse in favour of, and the pane
  already folds as a whole from the trigger beside the heading. The accordion is
  gone and its contents stay exactly where they were, at the padding they had.
  What is left is one heading, "Fields", at the size and tone every other label
  in the panel's chrome uses rather than a caption under a strip. The region's
  accessible name follows it (`aria-label="Document fields"`), as do the
  trigger's tooltip and label.

  **The dashboard banner is half as tall, and it is drawn rather than
  downloaded.** It was 13rem of photograph fetched from `heyo.sh`, which is a
  third of the first screen spent on a picture and a home page that cannot
  finish painting until another origin answers. It is now 6.5rem of CSS: a
  14px ruling panning by exactly one cell, three soft washes crossing each other
  on a sine curve, hairline signals that cross the strip and a single wide
  sheen — monochrome, because the system is, and every layer resolves both
  colour modes through `light-dark()`. The artwork fades to the page colour
  before the bottom edge, so the rule that closes the strip is the same
  hairline, composited over the same ground, as the one closing the page bar
  two rows above it. The greeting itself is set at regular weight: nothing else
  in the panel goes heavier than `medium`, and at three times the size of every
  other word on the screen it did not need the bold as well. Nothing animates but `transform` and
  `opacity`, so the compositor owns all of it, and every loop turns around
  either where it is invisible or where it is transparent. `prefers-reduced-
motion` stops the motion and keeps the composition.

- a0603d9: The properties pane makes room for the assistant, and three small corrections.

  **The pane halves when the assistant opens.** Its drawer takes 24rem off the
  right of the window, and a 24rem properties column next to it left the writing
  — the thing a document screen is for — with a gutter. The pane is half as wide
  while the drawer is open, and its fields stop pairing a label with its control
  on one line: the label goes above the control, which is heyo-ui's own `Field`
  layout and the only one that survives a column that narrow. Closing the drawer
  puts both back.

  **The trail is no longer flush against the rule beside the sidebar trigger.**

  **"Or POST to /posts from your own code" is gone**, from the empty collection
  and from the empty media library. An empty table is where somebody is told how
  to fill it, not where the HTTP API is advertised; the OpenAPI document and the
  README are where that belongs.

- a0603d9: Show TypeScript labels in API usage sheets. Add a read-only Deployment settings tab and show effective assistant model and limits in AI settings without exposing credentials or instructions.
- Updated dependencies [a0603d9]
- Updated dependencies [a0603d9]
- Updated dependencies [a0603d9]
- Updated dependencies [a0603d9]
- Updated dependencies [a0603d9]
- Updated dependencies [a0603d9]
- Updated dependencies [a0603d9]
- Updated dependencies [a0603d9]
  - @heyo-sh/heyo-cms@0.1.0

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

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies [1c8e346]
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @heyo-sh/heyo-cms@0.1.0
