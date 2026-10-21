/**
 * The whole HTTP mount, in one file.
 *
 * In a Next.js project this file is `app/api/heyo-cms/[...path]/route.ts` and
 * nothing else changes about it, ever: the CRUD endpoints for every
 * collection, the media library, editor authentication, the trash, the
 * language registry, the audit trail, the sweeps, the OpenAPI document, the
 * admin panel and every route a plugin registers are all served by the
 * catch-all below (section 10).
 *
 * It lives here rather than under `app/` because this example deliberately
 * has no framework installed — it is the configuration example, and the
 * harness serves `cms.handler` directly (`bun run example up next`). Keeping
 * the file in the type-checked set means the documented mount cannot drift
 * from the adapter: if `cmsHandler` ever stopped producing what a Next.js
 * route handler needs, CI would fail here rather than in somebody's project.
 *
 * The other frameworks are the same two lines with a different import path:
 *
 *   @heyo-sh/heyo-cms/astro         →  src/pages/api/heyo-cms/[...path].ts
 *   @heyo-sh/heyo-cms/react-router  →  app/routes/api.heyo-cms.$.ts
 *   @heyo-sh/heyo-cms/sveltekit     →  src/routes/api/heyo-cms/[...path]/+server.ts
 *   @heyo-sh/heyo-cms/nuxt          →  server/routes/api/heyo-cms/[...path].ts
 */
import { cmsHandler } from "@heyo-sh/heyo-cms/next";
import { cmsScheduled, startJobRunner } from "@heyo-sh/heyo-cms/jobs";

import { cms } from "./heyo-cms.config";

export const { GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS } = cmsHandler(cms);

/**
 * The sweeps, for a deployment with a cron.
 *
 * `cms.jobs.run()` applies scheduled changes, empties the expired trash and
 * collects unused files. It is also reachable as `POST /jobs/run` with an API
 * key holding `jobs:run` — this variant exists because a platform cron
 * (`vercel.json`, `wrangler.jsonc`) authenticates with its own secret rather
 * than with a CMS credential.
 *
 * In a project this is `app/api/cron/route.ts`.
 */
export async function runScheduledWork(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const report = await cms.jobs.run();
  // Delivered before the response: a serverless invocation that freezes with
  // events still in the outbox would hold them until the next cron.
  await cms.drainEvents();
  return Response.json(report);
}

/**
 * The same sweeps, for a deployment that owns its process.
 *
 * A long-lived Node or Bun server has a clock, so it does not need a cron
 * hitting an endpoint. The runner never overlaps itself and unrefs its
 * timer, so it cannot be the reason a process refuses to exit.
 *
 * ```ts
 * const jobs = startJobRunner({ cms, interval: "1m" });
 * process.on("SIGTERM", () => void jobs.stop());
 * ```
 */
export const jobRunner = { start: () => startJobRunner({ cms, interval: "1m" }) }; // prettier-ignore

/**
 * And on Cloudflare, where the platform owns the clock.
 *
 * ```ts
 * export default { fetch: (request) => cms.handler(request), scheduled };
 * ```
 *
 * `waitUntil` is used when it exists, so the outbox drain is allowed to
 * outlive the handler instead of being killed mid-delivery.
 */
export const scheduled = cmsScheduled(cms);
