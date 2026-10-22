---
"@heyo-sh/heyo-cms-admin": patch
---

**The sign-in screen's second column is a drawing now, and a seam separates
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
