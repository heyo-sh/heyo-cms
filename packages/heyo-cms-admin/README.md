# @heyo-sh/heyo-cms-admin

The Heyo CMS panel: one bundle, served by the CMS handler itself.

```ts
import { heyoCms } from "@heyo-sh/heyo-cms";
import { adminAssets } from "@heyo-sh/heyo-cms-admin";

export const cms = heyoCms({
  admin: { path: "/admin", title: "Acme", assets: adminAssets() },
  // …
});
```

That is the whole integration. The panel is then at
`/api/heyo-cms/admin` — the same origin as the API, the same deployment, no
CORS, no second build step in your pipeline — and it works on Workers,
because the files are inlined into this package rather than read from a
directory that does not exist there.

## It is the same bundle everywhere

Nothing in it is generated per project. On load it asks `GET /panel`, which
the CMS derives from your configuration: the collections, their fields and
options, the languages, the media settings, what the signed-in person may do.
A field added to a collection appears on the next page load.

What that implies is worth stating, because it is the cost of the design:
anything in the configuration that is a **function** stays on the server. A
field's `generate` function runs through a server endpoint, while an access
rule is _evaluated for the caller_ and the answer travels, so
the panel knows to disable the `status` select for a writer — and the engine
decides again when the write arrives, because a browser's opinion about
permissions is a suggestion.

## What is in it

- **Navigation** — a sidebar generated from `GET /panel`: Content and Globals
  are sections you can fold away (a deployment with forty collections
  otherwise pushes Media, Trash and Settings off the bottom), the Heyo mark
  sits on the same line as the icons under it, and the search is a button
  shaped like a field that opens the ⌘K palette. There is no collapse control
  in the sidebar itself — the page bar has one, and one is enough.
- **Lists** — heyo-ui's composable `Table`, the columns from
  `admin.defaultColumns`, server-side sort, search and filters in the API's
  own query syntax, selection and bulk delete. The row opens the record.
- **Forms** — generated from `fields`, respecting field-level access, with
  `admin.hidden` and localized values. A document with a main
  `richText()` field gives prose the left pane and settings the right; a form
  without prose stays one column. **No autosave**: the draft is yours until
  you press Save, and only the fields you changed are sent.
- **Rich text** — TipTap v3: starter kit, tables, task lists, links, images,
  emoji, placeholder, underline, a slash menu, a bubble menu and a drag
  handle. The value stored is the ProseMirror document, and an inserted image
  carries `mediaId` so the file counts as used.
- **Media** — upload (including dropping files onto the grid), an "Unused" tab
  with the purge countdown and a "Keep" button, and a detail pane that leaves
  the library live underneath it so the next file is one click. Framing is
  direct: the focal point is a handle you drag, the crop is a rectangle you
  can move, resize and snap to a ratio, and three preview frames show what a
  variant will actually look like as you move either one.
- **Languages** — a switcher at the breadcrumb's level, which is where it
  belongs: `posts / my-article` in German is a different document from the
  same path in English. Fields answered from another locale are badged with
  the language they came from.
- **Trash** — every collection at once, with the countdown the server set, and
  restore.
- **AI** — two things, and they are different things. One menu entry per key
  in `field.ai`, next to the field it belongs to: a result is shown and
  inserted on request, and nothing is written on your behalf, which is the
  same decision as having no autosave. And the **assistant**: a centred
  composer at the foot of every screen, which opens a drawer on the right when
  you send the first message. The page underneath stays live, so you can
  navigate to the record it just changed while the conversation stays where it
  is. It can save directly — "edit this and save it" means that — but
  creating, deleting and multi-record changes arrive as a plan with an
  Approve button, naming the records and the fields. Both are visible even
  when the deployment has no `ai` section or no provider key, with the reason
  in place of the placeholder.
- **Webhooks** — subscriptions, the delivery log with the receiver's own
  response, a test event and a replay button. "It did not arrive" is the only
  webhook support question there is, and this screen is where it is answered.
- **Settings** — editors, roles, languages, API keys, and provider keys when
  `ai.storage.secret` lets the panel manage them. A key is posted once and
  never answered with: what comes back is its last four characters. Its
  sections are a segmented control in a strip under the trail, and the trail
  itself stays `Settings` on every one of them: the tabs are already saying
  which section is open.

Publishing is not in that list, deliberately. There is no publish button and
no publish endpoint: `status` is an ordinary `select()`, and who may publish is
whoever may write that field.

## Options

```ts
adminAssets({ title: "Newsroom", favicon: "/favicon.svg" });
```

`title` defaults to `admin.title`. Both are optional and there is nothing
else: the panel is configured by configuring the CMS.

## What a plugin can add to it

The bundle is static and compiled before your plugin existed, so a React
component cannot reach it as JSON. A plugin declares `admin.scripts` instead;
the panel loads each URL before its first render and the script registers
against the global it installs.

```js
window.heyoCmsPanel.registerField("stars", StarsInput);
```

Until it does — or if the script fails to load, which is reported and
survived — a custom field renders with the built-in control for its column
type. Editor nodes need no script at all: the panel builds a TipTap extension
for every node in `GET /panel`'s editor schema, so a document carrying one is
never silently stripped when somebody opens it.

## Components

Every control in this panel is [heyo-ui](https://heyo.sh/heyo-ui/introduction/).
Not "heyo-ui-inspired" and not a fork: `Sidebar`, `Table`, `Dialog`,
`Dropdown`, `Select`, `Combobox`, `Input`, `Calendar`, `Tabs`, `Empty`,
`Spinner`, `ScrollArea`, `Toaster` and the rest are imported from the package. There is
no local `Button`, no local `Select`, and no `cn()` copied into `src/`. Every
icon is [Tabler](https://tabler.io/icons), which is the set heyo-ui's own
glyphs are drawn from, so nothing in the panel is half a stroke off from
everything else.

Five compositions are this panel's own, and all of them are built from heyo-ui
parts: `PageBar` (the one row every screen wears — trail, status, language,
actions), `PageStrip` (a second row of the same chrome, for a screen with
sections of its own — Settings puts its tabs there), `ErrorNote` (how a
server's refusal is shown), `ConfirmProvider` (`await confirm({…})`, which
replaced `window.confirm` everywhere) and `ImageEditor` (the focal point and
the crop). A CMS panel is a layout problem on top of a component library, not
a reason to start a second one.

Four house rules keep it from drifting:

- **One empty state.** `Empty` with an icon, a title, a sentence, the action
  that fixes it and a muted hint — the same five slots everywhere, so "no
  pages yet" and "no API keys" are recognisably the same kind of answer.
- **One loading state.** `<Spinner size="sm" />`. There are no skeletons: a
  skeleton is a promise about a layout, and a panel whose layout comes from
  `GET /panel` cannot make that promise — it was drawing five fake rows for a
  collection that turned out to be empty.
- **One measure per shape.** A screen that is a column of fields is `max-w-2xl`
  wide, because a label on the far left and its input 70rem away is not a
  form. Tables, grids and two-pane screens get the full width.
- **The row is the target.** A record opens from anywhere in its row — it is
  also a tab stop and answers Enter — rather than from a link in the first
  cell, which turns a 1200px row into a 90px target.

Nothing destructive happens without being named first, and no screen is left
behind with unsaved changes without being asked — both through the same
dialog, which keeps its button spinning until the request settles and shows
the server's refusal inside itself rather than as a toast over a screen that
has already moved on.

```css
@import "@heyo-sh/heyo-ui";
```

That is the whole stylesheet setup. Colour is semantic throughout —
`bg-heyo-base`, `text-heyo-subtle`, `ring-heyo-line` — and both colour modes
resolve from one set of classes through `light-dark()`, so no component here
carries a `dark:` variant and the theme toggle is one attribute:

```ts
document.documentElement.setAttribute("data-mode", "dark");
```

A deployment that wants a different panel overrides heyo tokens rather than
forking the components, and every component takes a `className` that wins over
its own (`tailwind-merge`, not string concatenation).

## Building it

```bash
bun run build
```

Produces `dist/index.js`: the runtime plus the application inlined as text,
with hashed filenames and an ETag per file. The build fails if the bundle
goes over its size budget — the emoji table alone is half a megabyte, which is
why it is loaded as a separate chunk after the editor is already usable.

The package has **no runtime dependencies**. React, TipTap, heyo-ui and the
rest are compiled in, which is the only honest way to ship a panel that has to
run inside a Worker.
