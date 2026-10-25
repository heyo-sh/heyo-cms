import type { APIRoute } from "astro";
import { getSecret } from "astro:env/server";

import { cms } from "../../../heyo-cms.config.ts";

/**
 * The sweeps: scheduled changes, the expired trash and unused files.
 *
 * `cms.jobs.run()` has to be called by something, because the package does
 * not know whether it is running in a process that has timers. On a platform
 * with a cron this is that something; `vercel.json` points at it on Vercel,
 * and `DEPLOYMENT.md` says what calls it elsewhere.
 *
 * It authenticates with the platform's own secret rather than with a CMS
 * credential, which is why it is a route of yours and not one of the CMS's.
 *
 * The secret is read with `getSecret`, when a request arrives — never as
 * `import.meta.env.CRON_SECRET`. Astro replaces `import.meta.env.*` with the
 * value it finds at build time, from `.env` or the shell, so that spelling
 * writes the secret into the server bundle and keeps answering to it after
 * the platform's secret has been changed.
 */
export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const secret = getSecret("CRON_SECRET");
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const report = await cms.jobs.run();
  // Delivered before the response: an invocation that freezes with events
  // still in the outbox would hold them until the next cron.
  await cms.drainEvents();
  return Response.json(report);
};
