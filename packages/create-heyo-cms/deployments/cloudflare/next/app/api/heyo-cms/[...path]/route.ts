import { cmsHandler } from "@heyo-sh/heyo-cms/next";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { cms } from "../../../../heyo-cms.config.ts";

/**
 * The whole CMS, mounted — plus the two lines Cloudflare needs.
 *
 * `next dev` runs in Node with a proxy to the real local bindings (see
 * `initOpenNextCloudflareForDev()` in `next.config.ts`), so the D1 and R2
 * objects only exist inside `getCloudflareContext()`. Handing them over here
 * is what lets the database and storage modules stay unaware of which
 * framework they are in.
 */
const handlers = cmsHandler(cms);

const withBindings =
  (handle: (request: Request) => Promise<Response>) =>
  async (request: Request): Promise<Response> => {
    const { env } = getCloudflareContext();
    (globalThis as { __heyoCloudflareEnv?: unknown }).__heyoCloudflareEnv = env;
    return handle(request);
  };

export const GET = withBindings(handlers.GET);
export const POST = withBindings(handlers.POST);
export const PATCH = withBindings(handlers.PATCH);
export const PUT = withBindings(handlers.PUT);
export const DELETE = withBindings(handlers.DELETE);
export const HEAD = withBindings(handlers.HEAD);
export const OPTIONS = withBindings(handlers.OPTIONS);

export const dynamic = "force-dynamic";
