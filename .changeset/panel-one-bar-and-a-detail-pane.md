---
"@heyo-sh/heyo-cms-admin": minor
---

The panel gets one bar, real confirmations and a usable image editor.

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
