# @heyo-sh/heyo-cms-admin

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
