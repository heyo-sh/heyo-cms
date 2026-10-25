import type { CmsHandler } from "../types/instance";

/**
 * Next.js App Router.
 *
 * ```ts
 * // app/api/heyo-cms/[...path]/route.ts
 * import { cmsHandler } from "@heyo-sh/heyo-cms/next";
 * import { cms } from "@/heyo-cms.config";
 *
 * export const { GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS } = cmsHandler(cms);
 * ```
 *
 * One file, and it never changes again: a route added to the core or to a
 * plugin is served by the same catch-all (section 10). The adapter is this
 * small because the handler is already `Request → Response`, which is exactly
 * what a Next.js route handler is.
 */
export interface HandlerLike {
  handler: CmsHandler;
}

export interface NextRouteHandlers {
  GET: CmsHandler;
  POST: CmsHandler;
  PATCH: CmsHandler;
  PUT: CmsHandler;
  DELETE: CmsHandler;
  HEAD: CmsHandler;
  OPTIONS: CmsHandler;
}

export interface NextHandlerOptions {
  /**
   * `waitUntil` from `@vercel/functions`, or a function that reaches
   * OpenNext's `getCloudflareContext().ctx.waitUntil`: delivers a write's
   * events before the function is frozen.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function cmsHandler(
  cms: HandlerLike,
  options: NextHandlerOptions = {},
): NextRouteHandlers {
  const settings = options.waitUntil ? { waitUntil: options.waitUntil } : undefined; // prettier-ignore
  const handle: CmsHandler = (request) => cms.handler(request, settings);
  return {
    GET: handle,
    POST: handle,
    PATCH: handle,
    PUT: handle,
    DELETE: handle,
    HEAD: handle,
    // Exported so a 405 carries an `Allow` header from the router rather than
    // from Next's default, which does not know what the CMS answers.
    OPTIONS: handle,
  };
}
