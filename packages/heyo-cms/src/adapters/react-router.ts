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
}

export type DataFunction = (args: DataFunctionArgs) => Promise<Response>;

export interface ReactRouterRouteHandlers {
  loader: DataFunction;
  action: DataFunction;
}

export function cmsHandler(cms: HandlerLike): ReactRouterRouteHandlers {
  const handle: DataFunction = ({ request }) => cms.handler(request);
  return { loader: handle, action: handle };
}
