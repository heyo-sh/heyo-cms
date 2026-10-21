import { cmsHandler } from "@heyo-sh/heyo-cms/react-router";

import { cms } from "../../heyo-cms.config.ts";

/**
 * The whole CMS, mounted. This file never changes again.
 *
 * Everything the CMS answers is behind this one splat route: CRUD for every
 * collection, the media library, editor authentication, the trash, the
 * language registry, the audit trail, the OpenAPI document, the admin panel
 * and every route a plugin registers. Adding a collection or installing a
 * plugin adds routes here without touching the file (section 10).
 *
 * Two exports rather than seven: React Router reads through `loader` and
 * writes through `action`, and the method dispatch happens inside the handler
 * where it already lives.
 *
 * The handler is built inside the function rather than beside it, and that is
 * load-bearing: a route module is compiled into the browser bundle too, with
 * its server exports removed. A `cmsHandler(cms)` evaluated at module scope
 * is a side effect the client build cannot drop, so the whole CMS — and the
 * Node modules it reaches for — would be dragged in front of a browser.
 *
 *   GET  /api/heyo-cms/posts
 *   POST /api/heyo-cms/media/upload
 *   GET  /api/heyo-cms/openapi.json
 *   GET  /api/heyo-cms/admin          ← the panel
 */
export async function loader({
  request,
}: {
  request: Request;
}): Promise<Response> {
  return cmsHandler(cms).loader({ request });
}

export const action = loader;
