---
"@heyo-sh/heyo-cms": minor
"@heyo-sh/create-heyo-cms": patch
---

**`convert: { to: "webp" }` now works on Cloudflare Workers.**
`uploads.images.convert`, `maxDimensions` and `variants.mode: "pregenerate"`
need an `ImageProcessor`, and the only one shipped was `sharpImages()` — a
native module that a Worker cannot load. The Cloudflare templates therefore
shipped without a processor, and those options could not be used there.

`cloudflareImages()` from `@heyo-sh/heyo-cms/uploads` is a processor backed by
the Workers Images binding (`env.IMAGES`), which resizes and re-encodes inside
the runtime:

```ts
import { cloudflareImages } from "@heyo-sh/heyo-cms/uploads";

images: {
  processor: cloudflareImages(() => env.IMAGES),
  convert: { to: "webp", keep: ["image/gif", "image/svg+xml"] },
  maxDimensions: { width: 3840, height: 3840 },
}
```

The binding is typed structurally, so nothing is added to the dependencies,
and it may be passed directly or as a (possibly async) function. Without a
binding the upload fails with `image_processor_missing` rather than storing
the wrong file. Crop and focal point are resolved by the same code
`sharpImages()` uses and sent as a `trim`; the fit modes are translated
(`inside` to `scale-down`, `contain` to `pad`, `outside` computed), and an
image is never enlarged. JPEG, PNG, GIF and WebP are accepted as input.

Two things differ from `sharpImages()`: the binding always re-encodes, so EXIF
is always stripped and `stripMetadata: false` has no effect; and `wrangler dev`
simulates the binding locally without applying `trim` or `gravity`
coordinates, so a crop or focal point only shows in development with
`"remote": true` on the binding.

The configuration error for a missing processor now names both processors.

**The generated Cloudflare projects use it.** `wrangler.json` declares
`"images": { "binding": "IMAGES" }` and the `images` block in
`heyo-cms.config.ts` now has the same `convert`, `quality`, `maxDimensions`
and `crop` settings as the Vercel projects, resolving the binding the way the
bucket and the database are resolved. Cloudflare bills transformations, so
`DEPLOYMENT.md` says how to go back to serving the original with the size in
the URL.
