---
"@heyo-sh/heyo-cms-admin": patch
---

The properties pane makes room for the assistant, and three small corrections.

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
