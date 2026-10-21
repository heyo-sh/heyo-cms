import { createRequestHandler } from "react-router";
import { cmsScheduled } from "@heyo-sh/heyo-cms/jobs";

import { serveFromEdgeCache } from "../heyo-cms.cache.ts";
import { cms } from "../heyo-cms.config.ts";

const handleRequest = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

/**
 * The Worker.
 *
 * `fetch` is React Router's; `scheduled` is the CMS's sweeps, wired to the
 * cron in `wrangler.json`. On Workers the platform owns the clock, so there
 * is no HTTP cron route to protect with a secret — which is why this is the
 * one deployment where `/api/cron` is not what runs the jobs.
 *
 * `cmsScheduled` uses `waitUntil` when it exists, so delivering the outbox is
 * allowed to outlive the handler instead of being killed mid-delivery.
 */
export default {
  fetch(request: Request, env: Record<string, unknown>) {
    // The bindings, handed to the database and storage modules. They also
    // read `cloudflare:workers` when it resolves; this is the half that works
    // in every build, including a dev server running outside workerd.
    (globalThis as { __heyoCloudflareEnv?: unknown }).__heyoCloudflareEnv = env;
    // A Worker runs in front of Cloudflare's cache rather than behind it, so
    // nothing is stored unless this line stores it. The decision is not taken
    // here: only a response that went through `cachePage` is kept, which is a
    // view's way of saying it holds nothing private.
    //
    // Not in development: the dev server runs inside workerd, so the cache is
    // real and persists in `.wrangler/state`, while the thing that empties it
    // is an HTTP call to Cloudflare with credentials a laptop does not have.
    // That combination is a dev server showing an editor their own page from
    // an hour ago with no way to make it stop.
    return import.meta.env.DEV
      ? handleRequest(request)
      : serveFromEdgeCache(request, () => handleRequest(request));
  },
  scheduled: cmsScheduled(cms),
};
