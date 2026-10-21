/**
 * `@heyo-sh/heyo-cms/http`.
 *
 * The HTTP layer, for the two callers who need it directly: a plugin writing
 * route handlers, and a test or tool that wants the router without a request.
 * An application mounts `cms.handler` through a framework adapter and never
 * imports this.
 */
export { createCmsHttp, type CmsHttp } from "./http/handler";
export { buildOpenApi } from "./http/openapi";
export {
  Router,
  type RouteHandler,
  type RouteMatch,
  type RouteMiddleware,
  type RouteRecord,
} from "./http/router";
export {
  errorResponse,
  json,
  noContent,
  optionalString,
  optionalStringArray,
  readJson,
  readJsonObject,
  requireData,
  requireString,
  stopped,
  text,
} from "./http/respond";
export {
  requestSource,
  requireActor,
  requirePermission,
  requireSession,
} from "./http/guard";
export {
  boolean as booleanParam,
  findArgs,
  integer as integerParam,
  parseSort,
  parseWhere,
  readArgs,
} from "./http/params";
export { requestDb } from "./http/request-db";
export {
  jsonBody,
  listParams,
  localeParams,
  okJson,
  pathParam,
  queryParam,
  readResponses,
  ref,
  writeResponses,
} from "./http/spec";
