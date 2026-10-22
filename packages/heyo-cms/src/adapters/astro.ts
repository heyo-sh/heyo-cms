import type { CmsHandler } from "../types/instance";

/**
 * Astro.
 *
 * ```ts
 * // src/pages/api/heyo-cms/[...path].ts
 * import { cmsHandler } from "@heyo-sh/heyo-cms/astro";
 * import { cms } from "../../../heyo-cms.config";
 *
 * export const prerender = false;
 * export const { GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS } = cmsHandler(cms);
 * ```
 *
 * Astro hands an endpoint context rather than a `Request`, so the adapter
 * reaches for `context.request` — the one difference from the Next.js version,
 * and the reason the import path names the framework instead of a flag doing
 * it.
 */
export interface HandlerLike {
  handler: CmsHandler;
}

/** The shape of what Astro passes an endpoint. */
export interface AstroContextLike {
  request: Request;
}

export type AstroRoute = (context: AstroContextLike) => Promise<Response>;

export interface AstroRouteHandlers {
  GET: AstroRoute;
  POST: AstroRoute;
  PATCH: AstroRoute;
  PUT: AstroRoute;
  DELETE: AstroRoute;
  HEAD: AstroRoute;
  OPTIONS: AstroRoute;
  ALL: AstroRoute;
}

export function cmsHandler(cms: HandlerLike): AstroRouteHandlers {
  const handle: AstroRoute = ({ request }) => cms.handler(request);
  return {
    GET: handle,
    POST: handle,
    PATCH: handle,
    PUT: handle,
    DELETE: handle,
    HEAD: handle,
    OPTIONS: handle,
    // `ALL` is Astro's own catch-all. Exported so a project can mount the CMS
    // with one named export if it prefers.
    ALL: handle,
  };
}
