import type { CmsHandler } from "../types/instance";

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
export interface HandlerLike {
  handler: CmsHandler;
}

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
  waitUntil?: (promise: Promise<unknown>) => void;
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
  const handle: DataFunction = ({ request, context }) => {
    const ctx = (
      context as
        | { cloudflare?: { ctx?: { waitUntil?: (promise: Promise<unknown>) => void } } } // prettier-ignore
        | undefined
    )?.cloudflare?.ctx;
    const waitUntil =
      options.waitUntil ??
      (typeof ctx?.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : undefined); // prettier-ignore
    return cms.handler(request, waitUntil ? { waitUntil } : undefined);
  };
  return { loader: handle, action: handle };
}
