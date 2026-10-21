import { cms } from "../../heyo-cms.config.ts";

/**
 * The sweeps: scheduled changes, the expired trash and unused files.
 *
 * `cms.jobs.run()` has to be called by something, because the package does
 * not know whether it is running in a process that has timers. On a platform
 * with a cron this is that something; `vercel.json` or `wrangler.jsonc` in
 * this project points at it.
 *
 * It authenticates with the platform's own secret rather than with a CMS
 * credential, which is why it is a route of yours and not one of the CMS's.
 */
export async function loader({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const report = await cms.jobs.run();
  // Delivered before the response: an invocation that freezes with events
  // still in the outbox would hold them until the next cron.
  await cms.drainEvents();
  return Response.json(report);
}
