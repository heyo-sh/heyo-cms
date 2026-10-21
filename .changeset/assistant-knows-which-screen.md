---
"@heyo-sh/heyo-cms": patch
"@heyo-sh/heyo-cms-admin": patch
---

Make the assistant's "this" mean what the editor is pointing at.

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
