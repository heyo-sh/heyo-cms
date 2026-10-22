import type { CmsHandler } from "../types/instance";

/**
 * SvelteKit.
 *
 * ```ts
 * // src/routes/api/heyo-cms/[...path]/+server.ts
 * import { cmsHandler } from "@heyo-sh/heyo-cms/sveltekit";
 * import { cms } from "$lib/heyo-cms.config";
 *
 * export const { GET, POST, PATCH, PUT, DELETE, fallback } = cmsHandler(cms);
 * ```
 *
 * The adapter exists in v1; the generator has no SvelteKit template yet
 * (stage 10). That distinction is the point of a `Request → Response` core:
 * supporting a framework is this file, not a port — and nothing here pulls
 * React into a Svelte project's `node_modules`.
 *
 * `fallback` is SvelteKit's catch-all for the methods a `+server.ts` does not
 * name, which is how `HEAD` and `OPTIONS` reach the router.
 */
export interface HandlerLike {
  handler: CmsHandler;
}

export interface RequestEventLike {
  request: Request;
}

export type SvelteKitRoute = (event: RequestEventLike) => Promise<Response>;

export interface SvelteKitRouteHandlers {
  GET: SvelteKitRoute;
  POST: SvelteKitRoute;
  PATCH: SvelteKitRoute;
  PUT: SvelteKitRoute;
  DELETE: SvelteKitRoute;
  fallback: SvelteKitRoute;
}

export function cmsHandler(cms: HandlerLike): SvelteKitRouteHandlers {
  const handle: SvelteKitRoute = ({ request }) => cms.handler(request);
  return {
    GET: handle,
    POST: handle,
    PATCH: handle,
    PUT: handle,
    DELETE: handle,
    fallback: handle,
  };
}
