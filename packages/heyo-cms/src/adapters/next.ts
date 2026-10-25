import { handle as respond, type HandlerLike, type WaitUntil } from "./deliver";

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
export type { HandlerLike } from "./deliver";

/**
 * One route handler, as Next.js calls it.
 *
 * Only the request: Next passes `{ params }` as the second argument, and a
 * handler typed to accept anything else there fails Next's own route type
 * check at build time.
 */
export type NextRoute = (request: Request) => Promise<Response>;

export interface NextRouteHandlers {
  GET: NextRoute;
  POST: NextRoute;
  PATCH: NextRoute;
  PUT: NextRoute;
  DELETE: NextRoute;
  HEAD: NextRoute;
  OPTIONS: NextRoute;
}

export interface NextHandlerOptions {
  /**
   * `waitUntil` from `@vercel/functions`, or a function that reaches
   * OpenNext's `getCloudflareContext().ctx.waitUntil`: delivers a write's
   * events before the function is frozen.
   */
  waitUntil?: WaitUntil;
}

export function cmsHandler(
  cms: HandlerLike,
  options: NextHandlerOptions = {},
): NextRouteHandlers {
  const handle: NextRoute = (request) => respond(cms, request, options.waitUntil); // prettier-ignore
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
