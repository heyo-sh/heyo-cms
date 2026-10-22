---
"@heyo-sh/heyo-cms-admin": patch
---

**The document pane says Fields, once.** The right-hand pane on
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
