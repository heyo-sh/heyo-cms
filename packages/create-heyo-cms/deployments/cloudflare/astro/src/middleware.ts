import type { MiddlewareHandler } from "astro";

import { serveFromEdgeCache } from "../heyo-cms.cache.ts";

/**
 * The edge cache, wrapped around the whole application.
 *
 * A Worker runs in front of Cloudflare's cache rather than behind it, so
 * nothing is stored unless this file stores it. It is one line because the
 * decision is not taken here: `serveFromEdgeCache` only keeps a response
 * that went through `cachePage`, which is the view's way of saying it holds
 * nothing private. The CMS routes, the panel and every signed-in page pass
 * straight through without opting in to anything.
 *
 * Not in development, though. `astro dev` runs inside workerd, so the Cache
 * API is real and so is its state directory — and the thing that empties it
 * is an HTTP call to Cloudflare with credentials a laptop does not have.
 * That combination is a dev server that serves an editor their own page from
 * an hour ago with no way to make it stop.
 */
export const onRequest: MiddlewareHandler = (context, next) =>
  import.meta.env.DEV
    ? next()
    : serveFromEdgeCache(context.request, () => next());
