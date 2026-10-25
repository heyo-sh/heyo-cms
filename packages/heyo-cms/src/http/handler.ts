import { CmsError } from "../errors";
import type { Actor } from "../types/actor";
import type { HttpHook, HttpHookContext } from "../types/hooks";
import type { CmsHandler, CmsInstance, RouteInspection } from "../types/instance"; // prettier-ignore
import type { JsonObject } from "../types/json";
import type { RouteContext, RouteDefinition } from "../types/plugin";
import { buildOpenApi } from "./openapi";
import { requestDb } from "./request-db";
import { errorResponse, json, readJson, text } from "./respond";
import { Router, type RouteRecord } from "./router";
import { accessRoutes } from "./routes/access";
import { adminRoutes, openApiRoute } from "./routes/admin";
import { aiRoutes } from "./routes/ai";
import { generateRoutes } from "./routes/generate";
import { authRoutes } from "./routes/auth";
import { documentRoutes, globalRoutes } from "./routes/documents";
import {
  mediaCollectRoute,
  mediaRoutes,
  publicMediaRoutes,
} from "./routes/media";
import { panelRoutes } from "./routes/panel";
import {
  activityRoutes,
  jobRoutes,
  localeRoutes,
  trashRoutes,
} from "./routes/system";
import { webhookRoutes } from "./routes/webhooks";

/**
 * `cms.handler`: the only HTTP contract in the product.
 *
 * `basePath` is stripped and the rest is matched, which is the whole of the
 * Better Auth arrangement the plan asks for (section 10): one catch-all route
 * in any framework mounts the API, the panel and every plugin route, and a
 * route added to the core or to a plugin tomorrow needs no change in the
 * application.
 *
 * The order inside a request is fixed and worth knowing:
 *
 * 1. the path is resolved against `basePath`,
 * 2. the caller is resolved from the cookie or the `Authorization` header,
 * 3. `hooks.before` run, and may answer instead of the route,
 * 4. the route's own middleware wrap the handler,
 * 5. `hooks.after` see the response and may add to it.
 *
 * Authentication is resolved before the hooks because a rate limiter that
 * cannot tell an editor from a stranger is a rate limiter on the wrong thing.
 */
export interface CmsHttp {
  handler: CmsHandler;
  /** What `cms.inspect().routes` prints. */
  routes(): RouteInspection[];
  /** The generated document, memoised. */
  openapi(): JsonObject;
}

export function createCmsHttp(cms: CmsInstance): CmsHttp {
  const config = cms._config;
  const basePath = config.basePath;
  const router = new Router();

  let document: JsonObject | undefined;
  const openapi = (): JsonObject => {
    document ??= buildOpenApi(cms, router.list());
    return document;
  };

  // Routes matched against the whole URL path rather than below `basePath`:
  // the public media path and a plugin's fixed-address files.
  const rootRouter = new Router();
  for (const route of publicMediaRoutes(cms)) rootRouter.add(route);

  for (const route of coreRoutes(cms)) router.add(route);
  for (const plugin of config.plugins) {
    for (const route of plugin.routes ?? []) {
      (route.root === true ? rootRouter : router).add(
        pluginRoute(plugin.id, route),
      );
    }
  }
  // Last, so the document it describes contains every other route; the
  // generation itself is deferred to the first request.
  router.add(openApiRoute(openapi));

  const before = sortHooks(config.hooks?.before ?? []);
  const after = sortHooks(config.hooks?.after ?? []);

  const handler: CmsHandler = async (request, options) => {
    const response = await handle(request);
    // A write's events are delivered after the response on a runtime that
    // would otherwise freeze first. Reads have nothing to deliver, and a
    // drain costs a query, so only the methods that write ask for one.
    if (options?.waitUntil && !safeMethods.has(request.method)) {
      options.waitUntil(cms.drainEvents().catch(() => 0));
    }
    return response;
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = stripBasePath(url.pathname, basePath);

    // Outside `basePath` only: a root route is a file at a fixed address,
    // and must never be able to answer in the API's place.
    if (
      path === null &&
      rootRouter.match(request.method, url.pathname).kind !== "not-found"
    ) {
      try {
        return await dispatch({
          cms,
          router: rootRouter,
          request,
          url,
          path: url.pathname,
          actor: null,
          meta: {},
        });
      } catch (error) {
        return errorResponse(error);
      }
    }

    if (path === null) {
      // The catch-all is mounted somewhere else, or the application
      // forwarded a request that was never ours. Saying so beats a 404 that
      // looks like a missing endpoint.
      return json(
        {
          error: {
            message: `This handler serves ${basePath}; the request was for ${url.pathname}.`,
            code: "outside_base_path",
            status: 404,
          },
        },
        404,
      );
    }

    let actor: Actor | null = null;
    const meta: Record<string, unknown> = {};
    let response: Response | undefined;

    try {
      assertRequestOrigin(request);
      actor = await resolveActor(cms, request);
      const hookContext: HttpHookContext = {
        request,
        path,
        method: request.method,
        headers: request.headers,
        actor,
        cms,
        meta,
      };
      for (const hook of before) {
        if (!hook.matcher(hookContext)) continue;
        const answer = await hook.handler(hookContext);
        if (answer instanceof Response) {
          // A `before` hook that answers short-circuits the route — which is
          // what makes rate limiting expressible without a second middleware
          // concept (section 5).
          response = answer;
          break;
        }
      }

      response ??= await dispatch({ cms, router, request, url, path, actor, meta }); // prettier-ignore
    } catch (error) {
      response = errorResponse(error);
    }

    if (after.length === 0) return response;
    return runAfterHooks({ after, cms, request, path, actor, meta, response });
  };

  return {
    handler,
    routes: () => [...router.routes(basePath), ...rootRouter.routes("")],
    openapi,
  };
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

interface DispatchOptions {
  cms: CmsInstance;
  router: Router;
  request: Request;
  url: URL;
  path: string;
  actor: Actor | null;
  meta: Record<string, unknown>;
}

async function dispatch(options: DispatchOptions): Promise<Response> {
  const { cms, router, request, url, path, actor, meta } = options;
  const match = router.match(request.method, path);

  if (match.kind === "method-not-allowed") {
    return json(
      {
        error: {
          message: `${request.method} is not allowed on ${path}.`,
          code: "method_not_allowed",
          status: 405,
        },
      },
      405,
      { allow: [...match.allowed, "OPTIONS"].join(", ") },
    );
  }
  if (match.kind === "not-found") {
    // `OPTIONS` on a path nothing matches is still answered, because a
    // preflight for a path that does not exist is not an error the browser
    // can act on.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { allow: "OPTIONS" } });
    }
    return json(
      {
        error: {
          message: `No route for ${request.method} ${path}.`,
          code: "not_found",
          status: 404,
        },
      },
      404,
    );
  }

  const context: RouteContext = {
    request,
    params: match.params,
    query: url.searchParams,
    actor,
    cms,
    db: requestDb(() => cms.database()),
    database: () => cms.database(),
    body: () => readJson(request),
    meta,
    json: (body, status) => json(body, status),
    text: (body, status) => text(body, status),
  };

  const response = await invoke(match.route, context);

  // HEAD is matched against GET; the body has to go, the headers stay.
  if (request.method === "HEAD") {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
}

/** The route's own middleware, innermost last, around the handler. */
function invoke(route: RouteRecord, context: RouteContext): Promise<Response> {
  const middleware = route.middleware ?? [];
  let index = -1;

  const next = async (): Promise<Response> => {
    index += 1;
    const current = middleware[index];
    if (!current) return route.handler(context);
    return current(context, next);
  };
  return next();
}

interface AfterOptions {
  after: HttpHook[];
  cms: CmsInstance;
  request: Request;
  path: string;
  actor: Actor | null;
  meta: Record<string, unknown>;
  response: Response;
}

/**
 * `hooks.after`, with headers they can actually write to.
 *
 * The headers of an existing `Response` are not reliably mutable across
 * runtimes, so the hooks are handed a copy and the response is rebuilt from
 * it. Only when there are hooks: rebuilding every response to support a
 * feature nobody configured would be a cost on every request.
 */
async function runAfterHooks(options: AfterOptions): Promise<Response> {
  const { after, cms, request, path, actor, meta, response } = options;
  const headers = new Headers(response.headers);
  const context: HttpHookContext = {
    request,
    path,
    method: request.method,
    headers,
    status: response.status,
    actor,
    cms,
    meta,
  };

  try {
    for (const hook of after) {
      if (!hook.matcher(context)) continue;
      const answer = await hook.handler(context);
      // An `after` hook may also replace the response outright — a cache
      // layer has to be able to — and then the remaining hooks see the
      // replacement.
      if (answer instanceof Response) return answer;
    }
  } catch (error) {
    return errorResponse(error);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function coreRoutes(cms: CmsInstance): RouteRecord[] {
  return [
    ...documentRoutes(cms),
    ...globalRoutes(cms),
    ...mediaRoutes(cms),
    ...mediaCollectRoute(cms),
    ...aiRoutes(cms),
    ...generateRoutes(cms),
    ...webhookRoutes(cms),
    ...authRoutes(cms),
    ...accessRoutes(cms),
    ...localeRoutes(cms),
    ...trashRoutes(cms),
    ...activityRoutes(cms),
    ...jobRoutes(cms),
    ...panelRoutes(cms),
    ...adminRoutes(cms),
  ];
}

function pluginRoute(id: string, route: RouteDefinition): RouteRecord {
  return {
    method: route.method,
    path: route.path,
    source: id,
    handler: route.handler,
    ...(route.middleware === undefined ? {} : { middleware: route.middleware }),
    ...(route.openapi === undefined ? {} : { openapi: route.openapi }),
  };
}

/**
 * Who is calling, or nobody.
 *
 * A credential that does not resolve is an anonymous caller rather than a
 * 401: a revoked key or an expired cookie on a public read should serve the
 * public document, and the endpoints that need somebody say so themselves.
 */
async function resolveActor(
  cms: CmsInstance,
  request: Request,
): Promise<Actor | null> {
  try {
    return await cms.auth.actorFromRequest(request);
  } catch (error) {
    // Only invalid credentials degrade to anonymous. Database failures or
    // explicit account denials must go through the HTTP error boundary.
    if (error instanceof CmsError && error.status === 401) return null;
    throw error;
  }
}

/**
 * The mount point, removed.
 *
 * `/api/heyo-cms/posts` under `/api/heyo-cms` is `/posts`; the base path
 * itself is `/`. A path that merely starts with the same characters —
 * `/api/heyo-cms-staging` — is not ours, which is why the boundary is checked
 * rather than the prefix.
 */
function stripBasePath(pathname: string, basePath: string): string | null {
  if (basePath === "/") return pathname;
  if (!pathname.startsWith(basePath)) return null;
  const rest = pathname.slice(basePath.length);
  if (rest.length === 0) return "/";
  if (!rest.startsWith("/")) return null;
  return rest;
}

/**
 * SameSite alone does not cover sibling origins on the same site. Browser
 * writes (including sign-in) must come from this origin. Explicit bearer
 * clients and non-browser callers without Origin remain supported; no CORS
 * permission is implied. Check before auth or hooks perform any side effects.
 */
function assertRequestOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (/^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "")) return;
  const origin = request.headers.get("origin");
  if (
    (origin !== null && origin !== new URL(request.url).origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw CmsError.forbidden("Cross-origin browser writes are not allowed.");
  }
}

/** Plugin hooks first, the configuration's own last; ties keep their order. */
function sortHooks(hooks: HttpHook[]): HttpHook[] {
  return [...hooks]
    .map((hook, index) => ({ hook, index }))
    .sort(
      (a, b) =>
        (a.hook.priority ?? 100) - (b.hook.priority ?? 100) ||
        a.index - b.index,
    )
    .map((entry) => entry.hook);
}
