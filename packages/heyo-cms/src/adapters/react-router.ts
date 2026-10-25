import { boundWaitUntil, handle as respond, type HandlerLike, type WaitUntil } from "./deliver"; // prettier-ignore

/**
 * React Router (and Remix).
 *
 * ```ts
 * // app/routes/api.heyo-cms.$.ts
 * import { cmsHandler } from "@heyo-sh/heyo-cms/react-router";
 * import { cms } from "../../heyo-cms.config";
 *
 * export const { loader, action } = cmsHandler(cms);
 * ```
 *
 * Two exports rather than seven: React Router routes reads through `loader`
 * and everything else through `action`, so the CMS needs both and the method
 * dispatch happens inside the handler where it already lives.
 */
export type { HandlerLike } from "./deliver";

export interface DataFunctionArgs {
  request: Request;
  /**
   * The load context. On Cloudflare the template puts the Worker's execution
   * context at `context.cloudflare.ctx`, and its `waitUntil` is used.
   */
  context?: unknown;
}

export interface ReactRouterHandlerOptions {
  /** For a platform whose `waitUntil` is not in the load context. */
  waitUntil?: WaitUntil;
}

export type DataFunction = (args: DataFunctionArgs) => Promise<Response>;

export interface ReactRouterRouteHandlers {
  loader: DataFunction;
  action: DataFunction;
}

export function cmsHandler(
  cms: HandlerLike,
  options: ReactRouterHandlerOptions = {},
): ReactRouterRouteHandlers {
  const handle: DataFunction = ({ request, context }) =>
    respond(
      cms,
      request,
      options.waitUntil ??
        boundWaitUntil((context as { cloudflare?: { ctx?: unknown } } | undefined)?.cloudflare?.ctx), // prettier-ignore
    );
  return { loader: handle, action: handle };
}
