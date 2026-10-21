---
"@heyo-sh/heyo-cms-admin": minor
---

The panel gets a sidebar you can fold, rows you can click, and one of each
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
