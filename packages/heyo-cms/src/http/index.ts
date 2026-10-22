/**
 * The HTTP layer.
 *
 * Nothing here knows how a document is stored, who may read it or what a
 * hook does: every handler parses a URL, calls one method on the instance and
 * serialises the answer. That is what keeps `cms.api.posts.find()` and
 * `GET /api/heyo-cms/posts` the same operation rather than two implementations
 * of the same intention (section 10).
 */
export { createCmsHttp, type CmsHttp } from "./handler";
export { buildOpenApi } from "./openapi";
export {
  Router,
  type RouteHandler,
  type RouteMatch,
  type RouteMiddleware,
  type RouteRecord,
} from "./router";
