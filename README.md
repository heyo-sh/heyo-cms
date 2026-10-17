# Heyo CMS

Framework-agnostic, TypeScript-first headless CMS with its own panel, RBAC,
i18n, native AI and media treated as a first-class citizen.

> **0.1.0 release candidate — stages 1–10 implemented.** The generator ships
> Next.js, Astro and React Router projects for Vercel and Cloudflare, including
> the panel, migrations and seeds. Publication remains a maintainer-approved
> release workflow. See [documentation](./docs/index.mdx),
> [known limits](#implementation-status) and [release checks](./RELEASING.md).

## Why

1. **Zero framework coupling.** The core is a plain `Request → Response`. No
   React, no Next.js, no framework of any kind in the engine's dependency tree.
2. **Lightweight.** Target: under 30 MB installed, cold start under 200 ms.
3. **Migrations as a first-class citizen.** A deterministic schema diff written
   to files in the repository, and no `push` mode. The same flow on Postgres,
   MongoDB and SQLite.
4. **Better Auth-style DX.** `heyoCms({ plugins: [...] })`, explicit
   `before`/`after` hooks, type inference, an extensible client.

## Quick start

Use Node 24+ or Bun. Once the packages are published:

```bash
bun create @heyo-sh/heyo-cms
# Choose framework, platform, database, storage and package manager.
# Follow the printed migration and seed commands, then open the panel:
# with no accounts yet, it asks you to create the administrator.
```

Non-interactive: `bun create @heyo-sh/heyo-cms my-cms --template astro
--deployment cloudflare --database d1 --storage r2 --no-install`.

[Next.js](./docs/quickstart/next.mdx) · [Astro](./docs/quickstart/astro.mdx) ·
[React Router](./docs/quickstart/react-router.mdx). Documentation uses
**heyo-docs**: `bun run docs:dev`, `bun run docs:build`.

### Configure by hand

```ts
// heyo-cms.config.ts
import { defineCollection, heyoCms } from "@heyo-sh/heyo-cms";
import { richText, select, text } from "@heyo-sh/heyo-cms/fields";
import { postgres } from "@heyo-sh/heyo-cms/postgres";

export const cms = heyoCms({
  database: postgres(process.env.DATABASE_URL!),
  collections: {
    posts: defineCollection({
      fields: {
        title: text({ required: true, localized: true }),
        handle: text({ unique: true, index: true, pattern: "^[a-z0-9-]+$" }),
        status: select({
          options: ["draft", "review", "published"],
          default: "draft",
        }),
        body: richText({ localized: true }),
      },
    }),
  },
});
```

```ts
// app/api/heyo-cms/[...path]/route.ts — the whole HTTP mount, forever
import { cmsHandler } from "@heyo-sh/heyo-cms/next";
import { cms } from "@/heyo-cms.config";

export const { GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS } = cmsHandler(cms);
```

Add the panel to the configuration above and it is served by that same route,
at `/api/heyo-cms/admin`:

```ts
import { adminAssets } from "@heyo-sh/heyo-cms-admin";

admin: { path: "/admin", title: "Acme", assets: adminAssets() },
```

```bash
heyo-cms generate   # write a migration for what changed
heyo-cms migrate    # apply pending migrations
heyo-cms status     # applied, pending, and changes with no migration yet
```

[`examples/next/heyo-cms.config.ts`](./examples/next/heyo-cms.config.ts) is the
full configuration — auth, RBAC, i18n, uploads, AI, webhooks, trash — with
[`api-route.ts`](./examples/next/api-route.ts) next to it as the mount. Both are
type-checked in CI, so the documented experience cannot drift from the types,
and `bun run example up next` serves them.

## Design decisions worth knowing before you read the code

**Status is an ordinary `select()` field.** There is no document lifecycle in
the engine: no `drafts`, no `published_data`, no `publish()`. A consumer filters
`where: { status: "published" }`. This removes a whole layer from the core, and
the thing it costs — preparing an edit to a published page without publishing it
— is what the paid versions package is for.

**Content lives in a JSON document body.** One `documents` table holds every
collection. Adding a field or a locale is therefore not a table rewrite, and
fields that need to be queried get expression indexes over their JSON path
instead of columns. This is also what makes one engine-neutral model work on
Postgres, MongoDB and SQLite at once.

**No SQL leaves an adapter.** The engine builds a neutral `Query`/`Mutation`
AST and neutral migration steps; each adapter renders them. A feature that
cannot be expressed in the AST cannot be expressed in the engine either, which
is what keeps the fourth adapter a translation job rather than a project.

**Migrations diff against a committed snapshot, never against your database.**
`heyo-cms generate` reads `migrations/meta/snapshot.json`, not the live schema.
It works offline, produces the same file on every machine, and can never
propose dropping a table it does not own.

**There is no `push` mode.** A schema change that leaves no file behind is one
nobody can review, roll back or reproduce.

## Databases

|                 | Postgres                     | MongoDB             | SQLite / D1      |
| --------------- | ---------------------------- | ------------------- | ---------------- |
| Transactions    | yes                          | replica set only    | yes (D1: none)   |
| Migrations      | `.sql` files                 | indexes + backfills | `.sql` files     |
| Content queries | JSONB                        | native              | `json_extract`   |
| Adapter         | `@heyo-sh/heyo-cms/postgres` | `/mongodb`          | `/sqlite`, `/d1` |

```ts
postgres(process.env.DATABASE_URL!); // or postgres(client)
mongodb(process.env.MONGODB_URL!); // or mongodb(db)
sqlite({ file: "./cms.db" }); // or sqlite(database)
d1(env.DB);
```

Drivers are peer dependencies: nothing is bundled, so a Cloudflare deployment
does not ship a Node Postgres client it never calls.

All four adapters pass the same contract suite
([`test/contract/database-adapter.ts`](./packages/heyo-cms/test/contract/database-adapter.ts)).
Postgres runs it on PGlite — Postgres compiled to WebAssembly — so `jsonb`,
partial unique indexes and real transactions are exercised in CI without a
server.

## Hooks

Two layers, explicit `before`/`after`, one return contract for all of them:
`undefined` continue, `{ data }` continue with a replacement, `false` stop
silently, `throw CmsError` stop with a status.

```ts
databaseHooks: {
  posts: {
    create: {
      before: async (input, ctx) => ({
        data: { ...input.data, handle: slugify(input.data.title) },
      }),
      after: async (doc, ctx) => {
        ctx.events.emit("search.index", { id: doc.id });
      },
    },
  },
}
```

`ctx.db` bypasses access control and `ctx.cms` enforces it — the difference is
in the name, not in a flag buried in an options object. Side effects always go
through `ctx.events`, which writes to the outbox inside the transaction and
delivers after the commit: a rolled back write sends nothing, a committed one
sends for certain.

`cms.inspect()` prints the final schema, the hook pipeline in execution order
and the registered routes. Plugin hooks run by priority, the configuration's
own hooks always run last.

## The local API

`cms.api` is typed from the collections and is the code path the REST routes
call — same access control, same hooks, same events. Each route handler is
three lines around one of these methods, so there is never a second
implementation to keep in step.

```ts
const page = await cms.api.posts.find({
  where: eq("status", "published"),
  orderBy: [orderBy("created_at", "desc")],
  limit: 20,
  depth: 1, // resolves relations and media, one batched query per collection
  locale: "de",
  actor,
});

page.cursor; // feed back as `cursor` for the next page

const post = await cms.api.posts.create({ data: { title: "Hello" }, actor });
await cms.api.posts.update({ id: post.id, data: { status: "published" } });
await cms.api.posts.delete({ id: post.id }); // to the trash
```

**Writes return `null` when a `before` hook returned `false`.** That is the
documented way to stop an operation without an error; everything else throws a
`CmsError` carrying a status.

**Pagination is keyset-based.** `limit` reads one row past the page to answer
`hasNextPage` without a second query, and `totalDocs` stays `null` unless you
ask for `count: true`. `offset` still works; `cursor` is what survives somebody
publishing while a reader is paging.

**`depth` batches, never joins.** Collect the ids at one level, run one query
per target collection, recurse. The query count depends on the schema, not on
the number of documents — resolving `depth: 2` over five posts costs three
queries, and the test that says so counts them.

**One locale is resolved per read.** A localized field is stored as
`{ [locale]: value }` and arrives as a plain value, so nothing downstream has
to know which fields are translated. `i18n` is a list of codes —
`{ defaultLocale: "en", locales: ["en", "fr"] }` — a field with no value in the
language being read is answered from `defaultLocale`, and the document says
which fields those were in `_fallback`. `fallbackLocale: false` on a single
call turns the substitution off, which is how the panel shows the gaps.

**Validation runs after the `before` hooks**, which is what makes "generate the
slug in a hook" work on a required field. A create validates every field; an
update validates the fields it touched, because a localized field is required
per locale and partial translations are the norm.

## Scheduled changes

There is no `publish()`, so there is no "scheduled publishing" either. There is
a patch and a time, and the patch may touch any field.

```ts
await cms.api.posts.schedule({
  id: post.id,
  at: "2026-03-01T09:00:00Z",
  data: { status: "published" }, // or a price, or a banner, or three fields
  actor,
});

await cms.api.posts.unschedule({ id: post.id });
await cms.jobs.run(); // applies everything that is due
```

**It is checked when it is scheduled and applied as an ordinary update.** Access
control, field-level access and validation all run at `schedule()` time, so a
writer who may not write `status` is refused on Tuesday rather than silently on
Friday night. When it fires it goes through the one write path like everything
else: the same `update` hooks, `document.updated`, one
`document.field.changed` per field that actually changed, and
`document.schedule.applied` next to them. `ctx.source` is `"job"`.

**The change carries the authority of whoever scheduled it.** That is a
decision, not an accident: re-deriving permissions at apply time would let a
routine role change quietly cancel work an editor believed was finished. Cancel
the schedule, or purge the document, to stop it.

**Applying claims first.** The schedule is cleared with a conditional update
before the write, so two overlapping cron invocations cannot both apply it. If
the write then fails, the patch is recorded in `jobs` — that row is the only
remaining copy — and `job.failed` is emitted. One failure never stops the
sweep.

## The trash

```ts
trash: { enabled: true, purgeAfter: "30d" }   // the default
```

`delete()` sets `deleted_at` and a deadline. The row stays, keeps its media
references, and disappears from every read that does not ask for it.

```ts
await cms.api.posts.delete({ id }); // trashed
await cms.api.posts.restore({ id }); // back
await cms.api.posts.purge({ id }); // gone
await cms.api.posts.delete({ id, permanent: true }); // gone, in one step

const bin = await cms.trash.list({ limit: 20 }); // every collection at once
await cms.trash.restore({ collection: "posts", id });
```

**The `delete` hooks run once**, when the document leaves the live set — on the
trash when there is a trash, on the delete when there is not. A purge thirty
days later does not run them again, because a hook that decrements a counter
must not decrement it twice for one document.

**A trashed document keeps its media usages and loses its schedule.** The first
because an image used by a document you can still restore is not unused; the
second because restoring a page should not detonate a publication that came due
while it sat in the bin.

**Retention is not a caller.** `cms.jobs.run()` purges what is past its deadline
without holding any permission, because `purgeAfter` is a policy the
configuration set and a human already triggered by deleting the document.
`restore` and `purge` performed by people need the `collection:restore` and
`collection:purge` permissions, or the collection's own `delete` rule where it
declares one.

## Globals

Singletons on the same machinery: one row in `documents`, the same hooks, the
same events, the same locales.

```ts
globals: {
  settings: defineGlobal({
    fields: {
      siteName: text({ required: true, default: "Acme" }),
      maintenance: boolean({ default: false }),
    },
  }),
}

await cms.globals.settings.get({ locale: "de" });
await cms.globals.settings.update({ data: { maintenance: true }, actor });
await cms.globals.settings.schedule({ at, data: { maintenance: false } });
```

**`get()` never returns `null` and never writes.** A global nobody has saved
reads as its declared defaults with `createdAt: null`; the row appears on the
first save. A read that wrote could not run on a replica, and a 404 for a
document the developer declared themselves would put a null check at the top of
every template.

There is no `create` and no `delete`: a singleton the panel can delete is a
collection with one row.

## Media

Media is a high-level setting, not a plugin: without it the CMS does not do its
job. `cms.media` is the whole surface, available without HTTP.

```ts
uploads: {
  storage: s3({ bucket, region }),
  limits: { maxFileSize: "25mb", accept: ["image/*", "application/pdf"] },
  images: {
    processor: sharpImages(),
    convert: { to: "webp", keep: ["image/gif", "image/svg+xml"] },
    stripMetadata: true,
    focalPoint: true,
    variants: {
      mode: "on-demand",
      sizes: { thumb: { width: 320, height: 320, fit: "cover" } },
    },
  },
  retention: { purgeAfter: "30d" },
}

const file = await cms.media.upload({ file: blob, filename: "photo.jpg" });
await cms.api.posts.update({ id, data: { cover: file.id } });
const thumb = await cms.media.variant({ id: file.id, variant: "thumb" });
```

Adapters: `local`, `memory`, `s3`, `r2` (credentials **or** a Workers binding),
`gcs` and `azure`. The cloud ones are four HTTP verbs and two signing schemes
written out — AWS SigV4 and Azure shared key, on Web Crypto — rather than four
vendor SDKs, because an SDK per provider is the entire installation budget this
project set itself. `StorageAdapter` is five methods, so an in-house store is
an afternoon.

**Nothing an edit does destroys a file.** Every save recomputes which files the
document points at — per locale, including images inside rich text — and writes
the result to `media_usages` inside the same transaction. Losing the last
reference marks a file `orphaned`:

- the bytes stay where they are and keep serving from the same URL,
- `purgeAfter` is set, and the panel can say "gone on the 12th",
- using the file again anywhere reclaims it, deadline cleared,
- `media-gc` deletes it only after the deadline passes **and** only after
  re-checking the references one more time, immediately before the delete.

Thirty days is long enough for somebody to have used the file again, so the
deadline is a necessary condition and never a sufficient one. A delete that the
bucket refuses is recorded in `purge_error` with the deadline pushed out, so a
transient permissions problem does not become a log fire. The trash keeps its
references on purpose: a picture used by a document you can still restore is
not an unused picture.

**Image work without a codec.** Dimensions are read from the file header —
PNG, JPEG, GIF, WebP, AVIF and SVG — so `maxImageDimensions` is a real limit on
every runtime, and the stored MIME type is the one the bytes support rather
than the one the browser claimed. `stripMetadata` removes EXIF, XMP and text
chunks from JPEG, PNG and WebP in plain TypeScript, because publishing the GPS
coordinates embedded in somebody's holiday photograph is a privacy obligation,
not an optimisation. ICC colour profiles are deliberately kept.

**Resizing is pluggable.** `ImageProcessor` is a two-method interface;
`sharpImages()` is the reference implementation and an optional peer
dependency, because a native module cannot load in a Worker. `variants.mode`
picks when sizes are produced:

|                    | `on-demand`                  | `pregenerate`        |
| ------------------ | ---------------------------- | -------------------- |
| Rendered           | first request                | at upload            |
| Upload cost        | none                         | one render per size  |
| A size added later | applies to the whole archive | applies to new files |

Both write the result into storage under a deterministic key, so the second
request is a storage hit either way. **`on-demand` without a processor is a
supported deployment, not a misconfiguration**: the original is served and its
URL carries `?w=&h=&fit=&q=` for an image CDN to render at the edge.
`convert`, `maxDimensions` and `pregenerate` do require one, and say so while
the configuration is still loading.

A focal point and a crop are stored on the file, not on the size, so every
variant inherits the decision an editor made once. Changing either discards the
sizes rendered from the old one.

## Jobs

```ts
await cms.jobs.run(); // every registered sweep
await cms.jobs.run({ only: ["trash-purge"], limit: 500 });
await cms.jobs.failures(); // what threw, with the payload
```

Deliberately not a daemon. The CMS runs on Workers and on Lambda as much as on
a long-lived Node process, so the engine exposes the sweep and the deployment
decides what calls it. `run()` reports what it did and whether more was
waiting, so a caller can loop instead of watching a backlog build.

`scheduled-changes`, `trash-purge`, `media-gc` when `uploads` is configured,
and `webhook-retries` when webhooks are. All four are queries, not queues: a
scheduled change is found in `documents.scheduled_at`, an expired deletion in
`documents.purge_after`, a collectable file in `media.purge_after` and an
undelivered event in `webhook_deliveries.next_attempt_at`. Nothing has to be
enqueued, so a schedule written by a seed script, a migration or a hook is
applied exactly like one written through the API.

Two runners ship, for the two kinds of deployment:

```ts
import { cmsScheduled, startJobRunner } from "@heyo-sh/heyo-cms/jobs";

// A process that owns a clock. Never overlaps itself; unrefs its timer, so
// it cannot be the reason a CLI refuses to exit.
const jobs = startJobRunner({ cms, interval: "1m" });
process.on("SIGTERM", () => void jobs.stop());

// A platform that owns the clock.
export default { fetch: (request) => cms.handler(request), scheduled: cmsScheduled(cms) }; // prettier-ignore
```

Both run the sweeps and then drain the outbox, in that order. The second half
is not optional on serverless: a handler that returns with events still in the
outbox freezes them until the next cron.

## AI

The rule from the plan, as a rule in the code: **AI is a capability of a
field.** There is no global task list, and the only global switch is the
absence of the `ai` section.

```ts
ai: {
  auth: { openai: { type: "api-key", token: env.OPENAI_API_KEY } },
  defaultModel: { provider: "openai", model: "gpt-4o-mini" },
  chat: { enabled: true, model: { provider: "anthropic", model: "claude-sonnet-4" } }, // prettier-ignore
  storage: { secret: env.AI_KEY_SECRET },  // lets the panel manage keys
}
```

`provider` and `model` are looked up in pi's catalogue; pi itself is never
mentioned in the configuration and is imported lazily, so a deployment without
AI does not carry a provider catalogue in its bundle. `ai.complete` replaces it
wholesale — a proxy, a self-hosted model, or a test that must not make a
network call.

`aiGenerate` enables a Generate action for this field alone. `context` names
other fields of the same collection and is validated at startup; a suggestion
is inserted into the form only after the editor approves it:

```ts
slug: text({
  pattern: "^[a-z0-9-]+$",
  generate: ({ fields }) => slugify(String(fields.title ?? "")),
  aiGenerate: {
    label: "Suggest slug",
    prompt: "Generate a lowercase URL slug from the title.",
    context: ["title"],
    maxLength: 64,
  },
}),
```

`generate` is a separate, deterministic server function. Its button fills the
current form without AI; the AI button previews a suggestion. Neither saves
the document. The older `field.ai` actions remain available for existing configurations;
other actions such as `translate` can still be configured there.

```
POST /posts/:id/ai/:field/:action     an existing document
POST /posts/ai/:field/:action         one that has never been saved
```

The second feature is the **panel-wide assistant**: one agent, running in the
CMS process, with typed tools that call the ordinary API.

```
POST /ai/assistant                      server-sent events
POST /ai/assistant/plans/:id/approve    applies a plan a human approved
```

It is configured by `ai.assistant` — a model, one standing instruction and the
budgets — and by nothing else. What it may read and write comes from the live
configuration and the signed-in actor at runtime, so there is no second
access-control system to drift from the real one. A mutating tool goes through
`cms.api.*` with that actor and `source: "ai"`, which means an agent write runs
the same validation, field access, hooks, media accounting, events and activity
log as somebody typing into the form. Creating, deleting and anything touching
more than one record do not happen inline: they become a stored plan the editor
approves, and approving replays the stored row rather than asking the model
again.

What the routes do and, more importantly, do not do:

- **Nothing is written.** The answer is a value shaped for the field — a
  string, a ProseMirror document, an array — and storing it is an ordinary
  save by a human, with the same hooks, validation and access control as
  typing it. Autosave was ruled out; a model writing silently would be worse.
- **Only the named context travels.** `context` is per action, and a field the
  actor may not read is removed from it before the prompt is built. Chat
  requires `context` for the same reason, and may only write what it can see.
- **Access is checked before a token is spent.** A suggestion for a field the
  actor cannot write is refused rather than generated.
- **Every call is accounted for.** `ai.task.completed` carries the action, the
  field, the model and the token usage; a failure emits `ai.task.failed` with
  the error. Both go through the outbox, so a billing integration is a
  subscriber rather than a fork.

Keys may also live in the database. With `ai.storage.secret` set, an
administrator can paste a provider key into the settings screen; it is
encrypted with AES-GCM before it is stored, never answered with — the panel
sees the last four characters — and takes precedence over `ai.auth`, because it
is the more recent decision by whoever could see both.

## Webhooks

```ts
webhooks: {
  enabled: true,
  signing: { algorithm: "hmac-sha256", secret: env.WEBHOOK_SECRET },
  delivery: { retries: 5, backoff: "exponential", timeout: "10s", dlq: true },
}
```

Subscriptions are rows, managed through `cms.webhooks` or the endpoints under
`/webhooks`, and an event type may be exact (`document.updated`), a family
(`document.*`) or everything (`*`). A family keeps working as the catalogue
grows, which is why it exists.

Every delivery carries:

```
x-heyo-event-id      the event; the same across retries and replays
x-heyo-delivery-id   this attempt
x-heyo-attempt       1, 2, 3…
x-heyo-signature     t=<unix>,v1=<hmac-sha256 of "t.body">
```

```ts
import { verifySignature } from "@heyo-sh/heyo-cms/webhooks";

const ok = await verifySignature({ body, header, secret }); // in your receiver
```

The timestamp is inside the signed string, so a captured delivery cannot be
replayed at a consumer forever. Five attempts with exponential backoff, then
the delivery is `failed` and stays in the table — a dead letter that
disappears is one nobody can act on. `cms.webhooks.retry()` sends it again as a
new attempt carrying the same event id, so the consumer's idempotency key still
matches and the original response stays readable in the panel.

Delivery never fails an event. The outbox worker hands each committed event to
the listeners first and to the subscribers second, and the subscriber half
records its own failures rather than throwing — otherwise one unreachable
endpoint would replay the event to every other subscriber on the next pass.

## Rich text, without a frontend

A `richText()` field stores a ProseMirror document, which is JSON and
therefore useless to a consumer that has no ProseMirror. So every node carries
its own serialisers, and the REST layer can render with them:

```
GET /posts/:id?richText=html        <p>Hello <strong>world</strong></p>
GET /posts?richText=markdown        Hello **world**
GET /posts/:id?richText=text        Hello world
```

Opt-in, never the default: the stored value is the document, and a response
that silently replaced it with a string would make read-then-write destructive.
The same functions are exported for anything that renders outside a request —
a static build, an RSS feed, a mail template:

```ts
import { richTextToHtml, richTextToMarkdown } from "@heyo-sh/heyo-cms/editor";

richTextToHtml(post.body, { mediaUrl: (id) => `/api/heyo-cms/media/${id}/hero` }); // prettier-ignore
```

## Extending

Everything the CMS ships is declared through the same public API a third party
would use. There is no privileged path, which is the only way an extension
point stays honest.

### Your own field

```ts
import { defineField } from "@heyo-sh/heyo-cms";

export const stars = defineField<number, { max?: number }>({
  name: "stars",
  optionsSchema: z.looseObject({ max: z.number().int().max(10).optional() }),
  schema: (options) =>
    z
      .number()
      .int()
      .min(1)
      .max(options.max ?? 5),
  column: () => ({ type: "integer", index: true }),
  aiActions: ["guess-stars"],
});
```

Four things: a zod schema for one locale's value, a portable column, an
options schema checked while the configuration loads, and the AI actions the
type may expose. The panel renders it with the control for its column type
until a plugin ships one of its own.

### Your own editor node

```ts
import { defineEditorNode } from "@heyo-sh/heyo-cms/editor";

export const pullQuote = defineEditorNode({
  name: "pullQuote",
  group: "block",
  content: "inline*",
  attrs: { attribution: { default: null } },
  toHtml: ({ node, children }) => `<figure>…${children}…</figure>`,
  toMarkdown: ({ node, children }) => `> ${children}`,
});
```

`toHtml` and `toMarkdown` are required, and the registry refuses a definition
without them. A node that renders only in the panel turns `GET /posts/1` into
a shape no consumer knows, and the promise that the REST API is usable without
a frontend quietly stops being true. The panel builds a TipTap extension for
every registered node it does not already have, so a document carrying one is
never silently stripped when somebody opens it.

### Your own AI action

```ts
import { defineAiAction } from "@heyo-sh/heyo-cms/ai";

defineAiAction({
  id: "tone-of-voice",
  appliesTo: ["text", "richText"],
  label: "Match our tone",
  prompt: "Rewrite in the house style: plain, short sentences.",
  run: async (context) => {
    const result = await context.complete({ system: "…", prompt: "…" });
    return { value: result.text, preview: result.text, usage: result.usage };
  },
});
```

`complete` arrives bound to the resolved model and credentials, so an action
never sees a token. A field may also declare an action nobody registered, as
long as it brings a prompt — `ai: { "tone-of-voice": { prompt: "…" } }` works
without the registration above, and behaves like `generate` with that
instruction.

### Your own plugin

```ts
export const reviews: CmsPlugin<ReviewsClient> = {
  id: "reviews",
  schema: { collections: { reviews: defineCollection({ … }) }, tables: [ … ] },
  migrations: [{ id: "index_scores", steps: [ … ] }],
  extendCollections: () => [{ collection: "posts", fields: { editorsPick: stars({}) } }], // prettier-ignore
  hooks: [{ collection: "posts", operation: "create", timing: "before", handler }], // prettier-ignore
  routes: [{ method: "GET", path: "/reviews/top", handler }],
  client: (base) => ({ reviews: { top: () => base.request("/reviews/top") } }),
  admin: { navItems: [{ label: "Reviews", path: "/c/reviews" }], scripts: [] },
};
```

A plugin's collection is a collection in every sense: routes, an entry in
`cms.api`, a place in the schema, a migration, RBAC. What the loader guarantees:

- **Collisions are start-up errors.** Two plugins with one id, two routes on
  one path, a collection that already exists, a field that would shadow one,
  a patch aimed at a collection that is not there — each names both sides.
- **Order is explicit.** Plugin hooks run in `priority` order and the
  configuration's own hooks always run last, so a user can override a plugin
  without the plugin anticipating it. `cms.inspect().hooks` prints the result.
- **Migrations are files.** `heyo-cms generate` writes a plugin's steps into
  the migrations directory, after the schema diff of the same run, and records
  that it has — running it twice writes nothing twice.
- **Everything is printable.** `cms.inspect().plugins` reports what each one
  actually contributed: collections, tables, routes, hooks, migrations.

The panel is one static bundle compiled before your plugin existed, so a
component cannot travel to it as JSON. `admin.scripts` is the mechanism
instead: the panel loads each URL before its first render, and the script
registers controls against the global it installs.

```js
// served by one of the plugin's own routes
window.heyoCmsPanel.registerField("stars", StarsInput);
```

A script that fails to load is reported and survived: the field falls back to
the built-in control, which is what happens when no plugin is installed at all.

[`examples/next/plugin.ts`](./examples/next/plugin.ts) is all of the above in
one file, type-checked in CI and exercised by `bun run example smoke`.

## Authentication and access

The CMS authenticates **editors and machines, and nobody else**: the
application you are building brings its own identity layer, and the plan says
so out loud. `cms.auth` is the whole surface, available without HTTP, and the
routes call exactly these functions.

```ts
const { token, actor } = await cms.auth.password.signIn({
  email: "editor@example.com",
  password,
});

const caller = await cms.auth.actorFromRequest(request); // cookie or bearer
const invite = await cms.auth.users.invite({ email, roles: ["editor"] });
const key = await cms.auth.apiKeys.create({ name: "Deploy", scopes: ["read"] });
```

Password, magic link, GitHub/Google/Microsoft OAuth, OIDC single sign-on, TOTP
as a second factor, invitations, resets, sessions and API keys — all on Web
Crypto alone (PBKDF2-SHA256, SHA-256, HMAC), so the same code signs people in
on Node, Bun and Cloudflare Workers.

**The first account is created from the sign-in screen**, and only ever once.
A CMS whose `cms_users` is empty has nobody to sign in as, so the panel offers
to create the administrator instead of asking for a password that does not
exist. The account it creates closes the offer: `POST /auth/setup` is
registered only while there are no accounts, and the count is taken inside the
transaction that does the insert, so two browsers racing produce one
administrator and one 409. This is not an open sign-up route left behind to be
remembered — the account _is_ what shuts it. For a pipeline, or a public URL
that should never offer it at all:

```ts
admin: {
  auth: cmsUsers({
    methods: ["password"],
    firstUser: false,            // or { roles: ["owner"] }; default: admin
  }),
}
```

```bash
bunx heyo-cms create-admin --email you@example.com   # the shell route, always available
```

**The CMS never sends email.** `invite()`, `magicLink.request()` and
`password.requestReset()` mint a single-use token and hand it back; delivering
it is the application's job. The matching event carries who was invited and
never the token, because a webhook subscriber that could read the secret could
become the invitee.

**A second factor cannot be stepped around.** Password and magic link both end
in the same function, so an account with TOTP enabled gets
`{ status: "two-factor-required", challenge }` from every door and a session
from none of them until `twoFactor.complete()` succeeds.

**An API key can never exceed its owner.** Scopes are intersected with the
user's permissions, so a read-only key on an administrator's account is
read-only. A key bound to a user carries that user's id, so an ownership rule
keeps working; an unbound key carries its scopes and nothing else.

### RBAC

Roles are lists of `collection:action` patterns, with `*` allowed on either
side. A sign-in flattens them once, so every later check is a string match.

```ts
rbac: {
  roles: {
    admin: ["*"],
    editor: ["posts:*", "media:*"],
    writer: ["posts:read", "posts:create", "posts:update"],
    viewer: ["*:read"],
  },
  customRoles: true,     // roles created in the panel, stored in `cms_roles`
}
```

**Declaring `rbac` changes the default.** A collection with no `access` rule
for an operation then requires `collection:action` instead of being open — the
only safe reading once roles exist. A rule that _is_ declared is the final
word, and RBAC is not consulted for it.

**An access rule may return a filter**, and the filter goes into the query
(including the `COUNT`), never into the serialiser. A row the actor may not
read is never fetched, never counted and never paged over.

```ts
access: {
  read: ({ actor }) =>
    permits(actor, "posts:read") ? true : eq("status", "published"),
}
```

### Who may publish

Nobody, and everybody: there is no publish operation. Status is an ordinary
`select()` field, so the question is who may **write** that field — which is
field-level access, and nothing else.

```ts
status: select({
  options: ["draft", "published"],
  default: "draft",
  access: { update: ({ actor }) => permits(actor, "posts:publish") },
}),

salary: number({
  access: { read: ({ actor }) => permits(actor, "posts:read_secret") },
}),
```

A write that touches a field the actor may not write is **refused**, not
silently dropped: ignoring half a form is how an editor comes to believe they
published something. A field the actor may not read is **absent** from the
document rather than `null` — absent is a fact about permission, `null` is a
fact about content — and `depth` cannot be used to read it through a relation,
because a related document is filtered by the rules of the collection it
belongs to.

Field rules are checked against what the caller sent, before any hook runs.
Hooks are server code, for the same reason `ctx.db` bypasses access control by
name.

## Events

`ctx.events.emit()` and the engine's own events (`document.created`,
`document.updated`, one `document.field.changed` per field that actually
changed, `document.scheduled`, `document.schedule.applied`,
`document.schedule.cancelled`, `document.trashed`, `document.restored`,
`document.purged`, `media.uploaded`, `media.updated`, `media.orphaned`,
`media.reclaimed`, `media.purged`, `media.processing.failed`, `job.failed`) are
written to the `outbox` table inside the transaction and delivered after the
commit.

```ts
cms.on("document.field.changed", async (event) => {
  if (event.data.field === "status") await revalidate(event.data.documentId);
});

await cms.drainEvents(); // deliver now and wait — for tests, CLIs, serverless
```

A listener that throws fails the delivery, which is retried five times with
exponential backoff and then marked `failed` — the same treatment a webhook
gets, because "it ran" has to mean the same thing for both. `ai.task.completed`
and `ai.task.failed` are in the same catalogue and carry the token usage of
the call that produced them, which is what makes billing a subscriber rather
than a fork.

Auth uses the same outbox rather than a mechanism of its own: `user.invited`,
`user.joined`, `user.removed`, `role.changed`, `apikey.created` and
`apikey.revoked` are written inside the transaction that caused them and
delivered after the commit, exactly like a document change.

On an engine without real transactions (standalone MongoDB, D1) the outbox row
is written in the same operation sequence as the document, and the worker
claims a row before delivering it, so a retry cannot deliver twice. That is the
compensating path `capabilities.transactions: false` exists to trigger.

Every document write — local API, REST, the panel, a job — goes through one
function in the engine. Hooks, the outbox, the activity log and the future
versions plugin all attach there, and there is no second path for any of them
to be forgotten in.

## Caching

A generated project caches its two post views and empties them on save,
without a webhook pointed back at itself. The whole mechanism is two names
and three hooks, in files you own:

```ts
// heyo-cms.cache.ts — the tags, and what a purge is on this platform
export const postsTag = "posts";
export const postTag = (handle: string) => `posts:${handle}`;

// heyo-cms.config.ts — the write that empties them
databaseHooks: {
  posts: {
    update: {
      after: ({ doc, previous }) =>
        revalidatePosts([...postTags(doc), ...postTags(previous)]),
    },
  },
}
```

A database hook rather than an event listener, deliberately: events are
delivered after the response has been sent, and on serverless the process is
frozen by then. The hook runs inside the write, so the panel, `cms.api`, an
API key, an import and a scheduled publication all purge the same way.

What differs per platform is only `heyo-cms.cache.ts`: `revalidateTag` on
Next.js (with KV and a Durable Object behind it on Cloudflare),
`@vercel/functions` CDN tags for Astro and React Router on Vercel, and the
Workers Cache API plus a purge by tag on Cloudflare. The views and the
configuration are identical in all six. See
[caching](./docs/caching.mdx).

## HTTP

`cms.handler` is a plain `(request: Request) => Promise<Response>` and it is
the only HTTP contract in the product. `basePath` — `/api/heyo-cms` by default
— is stripped from the URL and the rest is matched against a router generated
from the configuration, so **one catch-all route mounts everything**: CRUD for
every collection, globals, the media library, editor authentication, roles and
users, the language registry, the trash, the audit trail, the sweeps, the
OpenAPI document, the admin panel, and every route a plugin registered.

| Framework    | File                                           | Import                           |
| ------------ | ---------------------------------------------- | -------------------------------- |
| Next.js      | `app/api/heyo-cms/[...path]/route.ts`          | `@heyo-sh/heyo-cms/next`         |
| Astro        | `src/pages/api/heyo-cms/[...path].ts`          | `@heyo-sh/heyo-cms/astro`        |
| React Router | `app/routes/api.heyo-cms.$.ts`                 | `@heyo-sh/heyo-cms/react-router` |
| SvelteKit    | `src/routes/api/heyo-cms/[...path]/+server.ts` | `@heyo-sh/heyo-cms/sveltekit`    |
| Nuxt         | `server/routes/api/heyo-cms/[...path].ts`      | `@heyo-sh/heyo-cms/nuxt`         |

Each adapter is ten lines around `cms.handler`, and no framework appears in the
core's dependency tree. Nothing stops you from calling the handler directly
either — `Bun.serve({ fetch: cms.handler })` is a working deployment, and it is
what `bun run example up next` does.

**A route added to the core or to a plugin needs no change in your
application.** That is the point of the arrangement, and the reason it is not
magic is that the result is printable and machine-readable:

```ts
cms.inspect().routes;
// [{ method: "GET", path: "/api/heyo-cms/posts", source: "core", middleware: 0 },
//  { method: "GET", path: "/api/heyo-cms/analytics/pageviews", source: "analytics", ... }]
```

```
GET    /api/heyo-cms/posts?status=published&sort=-updatedAt&limit=20&depth=1
POST   /api/heyo-cms/posts
PATCH  /api/heyo-cms/posts/doc_1
DELETE /api/heyo-cms/posts/doc_1?permanent=true
POST   /api/heyo-cms/posts/doc_1/schedule
GET    /api/heyo-cms/globals/settings
POST   /api/heyo-cms/media/upload
GET    /api/heyo-cms/media/med_1/thumb
GET    /api/heyo-cms/auth/session
POST   /api/heyo-cms/auth/setup           ← only while there are no accounts
GET    /api/heyo-cms/trash
GET    /api/heyo-cms/openapi.json
GET    /api/heyo-cms/admin/            ← the panel
```

**Two filter syntaxes, one query language.** `?status=draft` and
`?views[gte]=10` for curl; `?where=` carrying the JSON filter AST for anything
composed, which is what the typed client sends. Both are built with the same
`eq()`/`and()` helpers an access rule returns, and a path that is not a field
of the collection is refused rather than passed through. A localized field is
filtered inside the requested locale, so `?locale=de&title=Hallo` looks where
the German title actually lives.

**Status codes are part of the contract.** `201` for a create, `204` with
`x-heyo-cms-stopped` when a `before` hook returned `false` (the HTTP spelling
of the local API's `null`), `403` from access control, `404` for a document the
actor may not see — a `403` there would confirm it exists — `405` with an
`Allow` header, `422` for validation. Errors are always
`{ error: { message, code, status } }`, and an unexpected exception is logged
server-side and answered as `500` without its message, because a driver error
routinely contains a connection string.

**HTTP hooks wrap every request.** `hooks.before` sees the path, the method and
the resolved actor, and may answer instead of the route — which is how rate
limiting is expressed without a second middleware concept. `hooks.after` sees
the status and may add headers.

```ts
hooks: {
  before: [{
    matcher: (c) => c.path.startsWith("/posts") && c.method === "POST",
    handler: async (c) => (await overLimit(c.actor) ? new Response(null, { status: 429 }) : undefined),
  }],
  after: [{ matcher: (c) => c.status === 200, handler: (c) => c.headers.set("x-cms-cache", "miss") }],
}
```

**The panel is served from the same handler** under `admin.path`, so there is
no second deployment and no CORS. Without `admin.assets` that URL answers with
a page saying the panel is not installed and linking to the OpenAPI document —
not a 404, which would be indistinguishable from a broken mount.

### OpenAPI

`GET /openapi.json` is generated from the configuration and the router, not
maintained by hand: the document schemas come from the zod schemas the field
types already validate with, so documentation and validation cannot disagree,
and a route that answers is in the document by construction. Plugin routes
carry their own fragment; one that does not is still listed, labelled with the
plugin that registered it.

`info.version` is a fingerprint of the generated surface rather than the
package version, because the endpoints come from your collections — what a
client needs to notice is the configuration changing under it.

### The typed client

```ts
import { heyoCmsClient } from "@heyo-sh/heyo-cms/client";
import { eq } from "@heyo-sh/heyo-cms/query";

// Same origin, default /api/heyo-cms mount.
const client = heyoCmsClient();

await client.auth.signIn({ email, password }); // sets the cookie
const page = await client.posts.find({ where: eq("status", "published") });
const post = await client.posts.create({ data: { title: "Hello" } });
await client.globals.settings.update({ data: { maintenance: true } });
const file = await client.media.upload({ file, filename: "photo.jpg" });
client.media.url(file.id, "thumb"); // a string, not a fetch
```

`create-heyo-cms` writes one `heyo-cms.client.d.ts` that registers `typeof cms`
as a type-only link. It is not bundled, it follows configuration changes without
regeneration, and it makes the no-argument client infer the documents from your
collections. The methods mirror `cms.api` deliberately: the same arguments,
the same return types, including `null` for a write a hook stopped. Code moves
between the local API and the client by changing the object it is called on.

A custom mount or a plugin stays concise too:

```ts
const client = heyoCmsClient({
  baseUrl: "https://cms.acme.dev/api/heyo-cms",
  plugins: [analytics],
});
await client.analytics.pageviews({ period: "7d" });
```

`heyoCmsClient<typeof otherCms>()` remains available when one TypeScript
program intentionally works with more than one CMS.

It ships to browsers, so it is `fetch` plus URL building, the error shape and
the 204 convention — an error from the server arrives as the same `CmsError`,
with the same `code`, that the engine threw.

### Plugin routes

```ts
const analytics: CmsPlugin = {
  id: "analytics",
  routes: [
    {
      method: "GET",
      path: "/analytics/pageviews",
      handler: async (c) => c.json(await c.db.find("pageviews")),
      openapi: { summary: "Page views", tags: ["analytics"] },
    },
  ],
};
```

Registered under `basePath` automatically, documented in the generated spec,
visible in `cms.inspect().routes`, and wrapped by the same HTTP hooks as every
core route. `RouteContext` gives a plugin `cms` (access control enforced),
`db` (bypassed, by name), the matched params, the query and the actor — and it
is deliberately not a third-party router's context, so a plugin never pins the
router version. Two routes claiming one path is a start-up error naming both
sides.

## The panel

```ts
import { adminAssets } from "@heyo-sh/heyo-cms-admin";

admin: { path: "/admin", title: "Acme", assets: adminAssets() },
```

One bundle, inlined into the package and served by `cms.handler` — same
origin, no CORS, no second deployment, and it runs on Workers because there is
no filesystem involved. The package has no runtime dependencies: React, TipTap
and [heyo-ui](https://heyo.sh/heyo-ui/introduction/) are compiled in.

**It is the same bytes in every deployment.** On load it asks `GET /panel`,
which the CMS derives from your configuration — collections, fields and their
options, languages, media settings, what the caller may do — so a field added
to a collection is in the form on the next page load, with no rebuild of
anything. That payload contains no credentials: `ai.auth` and
`webhooks.signing` are reported as "configured", never as their values.

| Screen    | What it does                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Lists     | heyo-ui's `Table`, `admin.defaultColumns`, sort and filters in the API's own query syntax, selection and bulk delete; the row opens the record |
| Documents | Prose on the left and settings on the right when a collection has a body; one column when it does not                                          |
| Rich text | TipTap v3 — tables, task lists, links, images, emoji, slash menu, bubble menu, drag handle                                                     |
| Media     | Upload, crop, focal point, and an "Unused" tab with the purge countdown and "Keep"                                                             |
| Languages | One switcher for the whole panel, and a second one in the document header; a fallback value is badged with its locale                          |
| Trash     | Every collection at once, the deadline the server set, and restore                                                                             |
| Settings  | Editors, roles, languages, API keys, and what AI and webhooks are configured to do                                                             |

**A document screen is laid out around its content.** A collection with a
`richText()` field the configuration left in the main column gets two panes:
the body on the left with its own toolbar, its own scroll and the title as the
page's heading, and everything else on the right as settings. A collection
without one is a single form — a settings pane next to four text inputs is two
columns of the same thing.

**Nothing autosaves.** The draft is the editor's until they press Save, and
only the fields they changed are sent — a `PATCH` carrying the whole document
would overwrite what a colleague changed while the tab was open, and would
push values the actor is not allowed to write.

**There is no publish button**, because there is no publish endpoint:
`status` is an ordinary `select()`, and who may publish is whoever may write
that field. A writer sees the select disabled; an editor sees it enabled. The
same is true of `maintenance` on a global.

One consequence of shipping one bundle for every configuration is worth
stating plainly:

- **Permission flags are advisory.** Access rules are evaluated for the caller
  without a record, so the panel knows which buttons to draw; the engine
  decides again, with the record, when the write arrives.

**Every control is [heyo-ui](https://heyo.sh/heyo-ui/introduction/).** The
panel has no local `Button`, no local `Select`, no copied `cn()` and no second
palette: `Sidebar`, `Table`, `Dialog`, `Dropdown`, `Select`, `Input`,
`Toaster` and the rest come from the package, every icon is
[Tabler](https://tabler.io/icons), and every colour in the panel is a heyo
token (`bg-heyo-base`, `text-heyo-subtle`, `ring-heyo-line`). Colour mode is
one attribute — `data-mode` on `<html>` — because every token resolves both
modes through `light-dark()`, so nothing in the panel carries a `dark:`
variant. A deployment that wants a different panel overrides tokens rather
than hunting for classes in forty files.

There is one empty state (`Empty` — icon, title, sentence, the action that
fixes it, a muted hint), one loading state (`<Spinner size="sm" />`, no
skeletons: a skeleton promises a layout, and this panel's layout arrives from
`GET /panel`), and one measure per shape — a screen that is a column of fields
is `max-w-2xl`, while tables, grids and two-pane screens take the width.

## Local development

```bash
bun install
bun test                     # 540 tests, four database engines, six storage adapters
bun run quality              # lint, knip, typecheck, test, build
bun run example list         # the examples, their databases and ports
bun run example up next      # migrate, seed and serve the handler on :4320
bun run example smoke next   # the whole contract against a real Postgres
```

`bun run example` is the canonical way to check a change before it ships. `up`
migrates a real Postgres, seeds it and serves `cms.handler` — API, OpenAPI and
panel — on a fixed port; `smoke` runs the engine, auth, media and HTTP
contracts against it, the last one over a real socket. It creates an editor
and signs in over HTTP so the write half is exercised with a real session. It reuses a Postgres that is already
listening, starts a container only if none is, and removes anything it started
on the way out.

## CLI and content transfer

```bash
bunx heyo-cms create-admin --email you@example.com   # the panel does this too, once
bunx heyo-cms seed
bunx heyo-cms export --out content.ndjson
bunx heyo-cms import content.ndjson --on-conflict update
bunx heyo-cms telemetry
```

NDJSON preserves content IDs and every locale. Imports run validation, hooks
and events with the system actor. This is not a database backup: accounts,
media rows/bytes and history are excluded; timestamps are new and trashed
records are skipped. See [CLI reference](./docs/cli.mdx).

The CLI and generator report adoption metadata only, never server traffic or
content. Disable it with `HEYO_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, or
`telemetry: { enabled: false }` in CMS configuration. CI/tests are off by default.

## Benchmarks

Local Apple M4, Node 24.7.0; Payload 3.90.2, Next.js 16.3.8. Full methodology,
fixtures and limits: [benchmarks](./benchmarks/README.md).

| Measurement                                                   | Heyo CMS |   Payload |
| ------------------------------------------------------------- | -------: | --------: |
| Headless core + Postgres, excluding panel/framework           | 10.6 MiB | 170.1 MiB |
| Fresh process import + config, no database/HTTP (median of 5) |  36.9 ms |  380.8 ms |
| Next production sample build, empty cache (median of 3)       |   3.29 s |    7.28 s |

These are differently featured sample applications, not a universal speed
comparison. Bootstrap excludes process launch and database connection; it is
not a deployed request cold start. Heyo ships a prebuilt panel and externalizes
its Node runtime; Payload builds its panel with the application.

## Implementation status

| Entry point                               | State                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `@heyo-sh/heyo-cms`                       | `heyoCms()`, `defineCollection()`, validation, schema                                  |
| `/types`                                  | every frozen contract from stages 1–3                                                  |
| `/fields`                                 | registry, `defineField()`, 13 built-in types, `seoFields()`                            |
| `/schema`, `/query`, `/migrations`        | snapshot, planner, AST helpers, store                                                  |
| `/postgres`, `/sqlite`, `/d1`, `/mongodb` | complete, contract-tested                                                              |
| `cms.api`                                 | find/findOne/findById/count, create, update, delete, restore, purge, schedule          |
| `cms.globals`                             | `get`, `update`, `schedule`, `unschedule`                                              |
| `cms.trash`, `cms.jobs`                   | cross-collection bin; the scheduled-change, purge and media sweeps                     |
| hooks, events, outbox, activity log       | complete; one write path, three engines                                                |
| `cms.auth`                                | sign-in, invitations, 2FA, OAuth/OIDC, API keys, roles                                 |
| `/auth`                                   | `cmsUsers()`, `oidc()`, `createAuth()`, TOTP, OAuth helpers                            |
| `cms.media`                               | upload, library, variants, usages, the orphan/reclaim/collect lifecycle                |
| `/uploads`                                | `local`, `memory`, `s3`, `r2`, `gcs`, `azure`; `sharpImages()`; probe, strip           |
| `cms.handler`, `cms._router`              | the auto-router: documents, globals, media, auth, access, i18n, trash, jobs            |
| `cms.locales`, `cms.activity`             | the configured languages and the audit trail, read by the routes above                 |
| `/http`                                   | `createCmsHttp()`, `Router`, the helpers a plugin route needs                          |
| `/client`                                 | same-origin `heyoCmsClient()`, typed through `heyo-cms.client.d.ts`; plugin extensions |
| `/next`, `/astro`, `/react-router`        | `cmsHandler()` — one catch-all file per framework                                      |
| `/sveltekit`, `/nuxt`                     | adapters available; no SvelteKit/Nuxt generator templates                              |
| `GET /openapi.json`                       | generated from the configuration, the fields' zod schemas and the router               |
| `GET /panel`                              | the configuration as data: collections, fields, languages, what you may do             |
| `@heyo-sh/heyo-cms-admin`                 | `adminAssets()` — the panel, inlined, served under `admin.path`                        |
| `cms.ai`                                  | field actions, the panel-wide assistant, `defineAiAction()`, encrypted keys            |
| `cms.webhooks`                            | subscriptions, HMAC delivery, retries, the dead-letter queue, replay                   |
| `/editor`                                 | `defineEditorNode()`, the built-in nodes, HTML/Markdown/text serialisers               |
| `/ai`, `/webhooks`, `/jobs`               | the extension points: actions, signature verification, the two job runners             |
| plugins                                   | collections, fields, nodes, actions, routes, hooks, migrations, panel scripts          |
| `/content`, `/telemetry`                  | streaming transfer; inspectable CLI-only adoption metadata                             |
| `@heyo-sh/create-heyo-cms`                | three frameworks × two platforms; Postgres/MongoDB/D1 layers; cached post views        |

Known limits of the current stages, by design rather than by omission:

- A localized field cannot be `unique`: uniqueness would have to be enforced per
  locale, and the set of locales is configuration rather than a column.
- Nested `group` and `array` fields are not in the built-in registry yet.
- An index on a multi-value field (`multiselect`, `relation({ many: true })`)
  indexes the JSON text of the array, which serves equality but not membership.
  `contains` works through the AST on all three engines; the matching container
  index is still outstanding.
- Sign-in has no rate limiting of its own. Failed passwords are answered in
  constant time with one message and a two-factor challenge dies after five
  wrong codes, but throttling an address is a `hooks.before` matcher — the CMS
  does not ship a limiter because it does not know whether this deployment has
  one process or two hundred.
- **The magic-link and password-reset routes only exist when
  `admin.auth.deliverToken` is configured.** The local API hands the token to
  its caller, which is server code; over HTTP the caller is an anonymous
  browser, and returning it there would let a stranger request a link for an
  administrator and read it out of the response. `POST /users/invite` does
  return its token, because an administrator who may already create accounts is
  being handed a link to send.
- **There is no sign-up route.** The CMS authenticates a small, known set of
  people; accounts arrive by invitation or from SSO.
- API keys are self-service over HTTP: a session may issue and revoke its own
  keys, and an API key may not issue another one — a key that can mint keys
  turns one leak into a foothold that revoking the original does not close.
- `?where=` accepts the filter AST from a client. It can only name fields the
  collection declares, only use the comparators in the AST, and only nest 100
  nodes deep; access control is applied to whatever it produces, as always.
- The CMS sets no CORS headers. The panel is served from the same origin as the
  API by construction, and a public read API that needs a browser from another
  origin is a decision for the deployment to make in `hooks.after`.
- `cms.inspect().routes` builds the router if it has not been built yet. That
  is deliberate: an answer assembled from the configuration a second time could
  differ from the one serving requests.
- A session is not renewed as it is used: it expires at `session.expiresIn`
  from the moment it was created. Sliding expiry costs a write per request and
  will be a configuration choice, not a default.
- OAuth client credentials are resolved at sign-in, not at build time, so a
  template that lists `github` still starts on a machine where the OAuth app
  does not exist. The error names the provider and the variables that would
  fix it.
- Only SSO provisions accounts. Signing in with GitHub links to an existing or
  invited address and refuses a stranger, because a GitHub account is not an
  invitation.
- A scheduled change is applied with the permissions its author held when they
  scheduled it. Revoking somebody's access does not cancel their pending
  schedules; `unschedule()` does.
- `cms.jobs.run()` has to be called by something. Nothing in the package calls
  it on a timer, because the package does not know whether it is running in a
  process that has timers. `POST /jobs/run` is the HTTP spelling and needs an
  actor with `jobs:run`; a platform cron that authenticates with its own secret
  calls `cms.jobs.run()` from its own route instead — see
  [`examples/next/api-route.ts`](./examples/next/api-route.ts).
- The six framework × deployment examples are generated on first use.
  `bun run example smoke` tests real development servers;
  `bun run example build` checks production bundling. Neither deploys to a
  live account. The tested matrix uses Postgres/local storage for Vercel dev
  and D1/R2 for Cloudflare. MongoDB and S3 require separate integration checks.
- Local storage is development-only on Vercel and rejected for Workers.
  Cloudflare templates use CDN images and require a Worker-compatible
  `ai.complete` instead of the optional Node AI runtime.
- D1 CLI commands target the local Wrangler database by default. Explicit
  `HEYO_D1_REMOTE=1` with Cloudflare credentials selects production D1; see
  [deployment](./docs/deployment.mdx). Content dumps do not contain accounts.
- A failed scheduled change is recorded, not retried: the patch is in `jobs`
  and re-applying it is a decision, because the document may have moved on in
  the meantime.
- The trash list pages by `deleted_at`, so a cursor taken from it is only valid
  for that sort. It is not a general cross-collection query.
- A collection-level access rule that returns a `Where` is applied to the
  query; one that returns a `Where` for `create` throws, because there is no
  row to filter and silently allowing the write would turn a restriction into
  a no-op.
- Keyset pagination assumes the sort paths hold a value. `id` is always
  appended as a tiebreaker, so the order is total, but sorting by a field that
  is `null` in some documents will page over them unpredictably.
- `introspect()` reports tables and indexes, not the logical collections — a
  database cannot know which collection a document belongs to. It is used for
  drift detection, never as the `from` side of a diff.
- Reading media is not governed by RBAC; writing it is. A file's URL is public
  the moment it is on a page, so gating `get` would break anonymous rendering
  and protect nothing that a private bucket and a signed URL do not already
  protect.
- `MediaDocument.url` is the adapter's public URL. On a private bucket the
  signed URL is produced at the moment of serving — `cms.media.variant()` —
  because signing every entry of a twenty-five file listing would charge every
  deployment for a feature most of them do not use.
- Only declared sizes can be requested. Arbitrary dimensions in a URL are how a
  stranger fills a bucket and burns CPU one pixel at a time.
- A file referenced from rich text has to carry a `mediaId` attribute on its
  node. A bare `src` is not counted, because a URL is not a reference and
  parsing one back into an id would be guesswork.
- `media({ accept })` is a hint for the picker, not a constraint on writes.
  Enforcing it would mean reading every referenced file's MIME type on every
  save; `uploads.limits.accept` is the enforcement point, and it is checked
  against what the bytes are rather than what the form called them.
- Uploads are buffered in memory before they are stored. Streaming straight
  through is incompatible with reading the header, checking the size and
  hashing the bytes before anything is written, which is the order that makes a
  rejected upload cost nothing.
- `probeImage` finds AVIF dimensions by locating the `ispe` box rather than
  walking the full ISO-BMFF tree. It validates what it finds, and an image it
  cannot read is stored without dimensions rather than refused.
- **A custom field type from `defineField()` renders with a built-in
  control** until a plugin registers one through `admin.scripts`. The
  fallback is chosen from the field's column type, so a `stars` field is a
  number input rather than a blank space.
- **A node a plugin registered renders in the panel as a plain block.** Its
  content, attributes and serialisers are correct — the document survives an
  edit untouched — but the editing affordances are the generic ones until the
  plugin ships a node view through the same `admin.scripts` mechanism.
- **AI runs in the request, not in a queue.** A generation is interactive and
  a person is waiting for it, so there is no job type for one. Bulk work —
  translating a whole collection — is a script calling `cms.ai.run()`, or a
  plugin with its own sweep; both reach the same function the button does.
- **A field action does not stream; the assistant does.** One prompt producing
  one value a human approves has nothing to animate. An agent run has: the
  editor has to see which record was read and which field was written while it
  happens, so `POST /ai/assistant` is server-sent events with the CMS's own
  event contract rather than the agent library's.
- **The assistant's conversation is not stored.** It lives in one browser tab,
  in memory, and a reload loses it. That is a real cost, paid deliberately:
  the alternative is CMS content in browser storage on a shared machine, or a
  transcript table nobody asked for.
- **`ai.complete` is not a fallback for the assistant.** It replaces the model
  call for field actions, which are one prompt and one answer. A single
  completion cannot run a tool-call loop, and an agent built on one would
  confidently describe writes it never made; without the agent runtime the
  endpoint says `ai_assistant_runtime_missing` instead.
- **The assistant will not write a record whose form is dirty.** It answers
  `active_draft_dirty` and asks the editor to save or discard first. The
  unsaved values never leave the browser — only the field names travel.
- **"This" is resolved from the screen, and the screen is a hint.**
  `pageContext` carries the kind of screen, the collection slug, the record or
  file in front of the editor, the open tab and the language being edited —
  and every part of it is re-resolved server-side against the configuration
  and re-read by the server. Document reads use the caller's permissions;
  media metadata reads are public by design. A slug is matched as a slug,
  a document context that names a global resolves to nothing, and a forged
  context does not bypass access or write checks.
- **Caching is a template, not a feature of the core.** `@heyo-sh/heyo-cms`
  emits no cache tags and calls no `revalidateTag`: a generated project owns
  both halves in `heyo-cms.cache.ts` and `databaseHooks`, because what a tag
  should be called and which views exist are decisions about a site rather
  than about a CMS. The cost is that a project which deploys its site
  separately from the CMS has to subscribe a webhook instead; the benefit is
  that nothing in the engine has an opinion about Next.js.
- **Webhook ordering is per document, not global.** The outbox is drained in
  insertion order and a document's events are inserted in the order they
  happened; across documents, parallel delivery is the point.
- **A subscription's custom headers cannot start with `x-heyo-`.** They are
  dropped, because a subscription that could rewrite the event id or the
  signature would be able to disable its own verification by accident.
- **Rotating `ai.storage.secret` invalidates every stored provider key.**
  That is what rotating a key-encryption key means; the panel says so when a
  key stops decrypting, and the fix is to paste it again.
- **Validation errors are shown per document, not per field.** The engine
  answers `422` with one message naming the field in prose; threading a field
  path through the error shape is a change to a frozen contract and will come
  with the error-detail work, not with the panel.
- **A localized column cannot be sorted from the list.** It is stored as a map
  keyed by locale, so ordering by it would order by whatever the engine's path
  resolution picks; the header is not clickable rather than quietly wrong.
- **Lists page with `offset` and `count`,** because a table with page numbers
  needs a total. Past a few thousand rows that is a search problem, and the
  keyset cursor the API also offers is the answer to it.
- **An image inserted into rich text carries `mediaId`.** Pasting a bare URL
  into the editor produces an image the lifecycle does not count, which is the
  same rule the engine documents: a URL is not a reference.

## Licence

MIT.
