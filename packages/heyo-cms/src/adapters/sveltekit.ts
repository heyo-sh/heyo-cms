import { boundWaitUntil, handle as respond, type HandlerLike, type WaitUntil } from "./deliver"; // prettier-ignore

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
export type { HandlerLike } from "./deliver";

export interface RequestEventLike {
  request: Request;
  /** `adapter-cloudflare` puts the execution context at `platform.ctx`. */
  platform?: unknown;
}

export interface SvelteKitHandlerOptions {
  /** For a platform whose `waitUntil` is not on `event.platform`. */
  waitUntil?: WaitUntil;
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

export function cmsHandler(
  cms: HandlerLike,
  options: SvelteKitHandlerOptions = {},
): SvelteKitRouteHandlers {
  const handle: SvelteKitRoute = ({ request, platform }) =>
    respond(
      cms,
      request,
      options.waitUntil ??
        boundWaitUntil((platform as { ctx?: unknown } | undefined)?.ctx),
    );
  return {
    GET: handle,
    POST: handle,
    PATCH: handle,
    PUT: handle,
    DELETE: handle,
    fallback: handle,
  };
}
