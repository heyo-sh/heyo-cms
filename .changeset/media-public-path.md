---
"@heyo-sh/heyo-cms": minor
---

**Files at addresses made for the web, described for `<img>`, and a processor
that fails without taking pages down.**

- `uploads.publicPath: "/media"` serves the library at `/media/<id>/<name>`
  and `/media/<id>/<size>/<name>`, outside `basePath` (mount the handler there
  too), with an `ETag`, `HEAD`, and a year of caching. `MediaDocument.url`,
  `cms.media.url()`, `srcset`s and rich text point there.
- `cms.media.url(file, { variant })`, `cms.media.srcset(file)` and
  `cms.media.image(file, { sizes, locale })` compute URLs, widths, heights and
  `srcset`s from the configuration — no request, no render.
- `cms.media.renderRichText(doc, { locale, sizes })` resolves every library
  image in one query: public URL, `width`/`height`, `srcset`, lazy loading,
  and the library's alt text where the node has none. `?richText=html` on the
  REST API does the same; `richTextToHtml()` accepts a `mediaImage` resolver.
- `cms.media.getMany(ids)` and `cms.media.forDocuments(collection)` — every
  file a collection's documents use, per document and locale, from
  `media_usages` (an image sitemap in two queries).
- A processor that fails (Cloudflare's `9422` once a free quota is spent, an
  outage, an undecodable file) no longer fails the upload or the page: the
  original is stored or served, nothing is stored under the size's key, and
  `media.processing.failed` is emitted at most hourly per file and size.
  `image_processor_missing` still fails loudly.
- A file already in the `convert` format is no longer re-encoded (a lossless
  WebP stays lossless), and a size that would not change the picture is
  answered with the original instead of a render.
- `cloudflareImages()` sends `trim` as `{ top, left, width, height }`.
