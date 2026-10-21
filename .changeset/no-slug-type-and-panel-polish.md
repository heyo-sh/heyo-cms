---
"@heyo-sh/heyo-cms": minor
"@heyo-sh/heyo-cms-admin": minor
---

**The `slug` field type is gone.** It was `text` with `unique`, `index` and a
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
