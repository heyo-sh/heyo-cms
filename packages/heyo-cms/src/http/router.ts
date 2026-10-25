import { CmsConfigError } from "../errors";
import type { RouteInspection } from "../types/instance";
import type {
  OpenApiRouteSpec,
  RouteContext,
  RouteMethod,
} from "../types/plugin";

/**
 * The router.
 *
 * Written here rather than taken from a package, and that is a decision worth
 * defending. The plan points at Better Auth's arrangement (section 10) and
 * Better Auth does exactly this: its own matcher, because the router ends up
 * in the public contract. Ours is in `RouteContext`, which a plugin author
 * types against — and a plugin ecosystem pinned to somebody else's router
 * major version is the framework coupling this project exists to avoid.
 *
 * What it owes: `:param` and a trailing `*`, static-before-dynamic
 * precedence, 405 with an `Allow` header, and collisions detected while the
 * configuration is still loading.
 */

export type RouteHandler = (
  context: RouteContext,
) => Response | Promise<Response>;

export type RouteMiddleware = (
  context: RouteContext,
  next: () => Promise<Response>,
) => Promise<Response>;

export interface RouteRecord {
  method: RouteMethod;
  /** Relative to `basePath`: `/posts/:id`, `/admin/*`. */
  path: string;
  /** `core`, or the id of the plugin that registered it. */
  source: string;
  handler: RouteHandler;
  middleware?: RouteMiddleware[];
  openapi?: OpenApiRouteSpec;
}

type Segment =
  | { kind: "static"; value: string }
  | { kind: "param"; name: string }
  | { kind: "wildcard" };

interface CompiledRoute extends RouteRecord {
  segments: Segment[];
  /** A trailing `*` matches any number of remaining segments. */
  wildcard: boolean;
  /** Static segments first; the tiebreaker that makes `/media/upload` win. */
  specificity: number;
}

export type RouteMatch =
  | { kind: "found"; route: RouteRecord; params: Record<string, string> }
  | { kind: "method-not-allowed"; allowed: RouteMethod[] }
  | { kind: "not-found" };

export class Router {
  private readonly compiled: CompiledRoute[] = [];
  private readonly signatures = new Map<string, string>();

  add(route: RouteRecord): void {
    const segments = compile(route.path, route.source);
    const wildcard = segments.at(-1)?.kind === "wildcard";

    // The collision check Better Auth performs at start-up, for the same
    // reason: two plugins claiming one path is a mistake somebody has to be
    // told about, and letting the last registration win makes it invisible
    // until a user reports that half a feature is missing.
    const signature = `${route.method} ${segments
      .map((segment) =>
        segment.kind === "static" ? segment.value : `{${segment.kind}}`,
      )
      .join("/")}`;
    const owner = this.signatures.get(signature);
    if (owner) {
      throw new CmsConfigError(
        route.source === "core" ? "routes" : `plugins.${route.source}.routes`,
        `"${route.method} ${route.path}" collides with a route already registered by "${owner}"`,
      );
    }
    this.signatures.set(signature, route.source);

    this.compiled.push({
      ...route,
      segments,
      wildcard,
      specificity: segments.filter((segment) => segment.kind === "static")
        .length,
    });
    // Sorted once, on registration: a request is matched hundreds of times
    // more often than a route is added. Static-heavy patterns first, then
    // longer patterns, then non-wildcards — so `/media/upload` is reached
    // before `/media/:id` and `/admin/*` only after everything concrete.
    this.compiled.sort(
      (a, b) =>
        Number(a.wildcard) - Number(b.wildcard) ||
        b.specificity - a.specificity ||
        b.segments.length - a.segments.length,
    );
  }

  /** Registration order is not match order; this is match order. */
  list(): RouteRecord[] {
    return this.compiled.map(({ segments, wildcard, specificity, ...route }) => route); // prettier-ignore
  }

  /**
   * What `cms.inspect().routes` prints.
   *
   * Paths carry `basePath`, because the question somebody has when they print
   * this is "what do I call", and the answer to that is a URL rather than a
   * pattern the router happens to store.
   */
  routes(basePath: string): RouteInspection[] {
    return this.compiled.map((route) => ({
      method: route.method,
      path: route.path === "/" ? basePath || "/" : `${basePath}${route.path}`,
      source: route.source,
      middleware: route.middleware?.length ?? 0,
    }));
  }

  match(method: string, path: string): RouteMatch {
    const parts = split(path);
    const allowed = new Set<RouteMethod>();
    // HEAD is answered by the GET handler with the body dropped, which is
    // what every health check and `curl -I` expects.
    const wanted = method === "HEAD" ? "GET" : method;

    for (const route of this.compiled) {
      const params = matchSegments(route, parts);
      if (!params) continue;
      if (route.method === wanted) return { kind: "found", route, params };
      allowed.add(route.method);
    }

    if (allowed.size > 0) {
      return { kind: "method-not-allowed", allowed: [...allowed].sort() };
    }
    return { kind: "not-found" };
  }
}

function matchSegments(
  route: CompiledRoute,
  parts: string[],
): Record<string, string> | null {
  if (route.wildcard) {
    if (parts.length < route.segments.length - 1) return null;
  } else if (parts.length !== route.segments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (const [index, segment] of route.segments.entries()) {
    if (segment.kind === "wildcard") {
      params["*"] = parts.slice(index).join("/");
      return params;
    }
    const part = parts[index];
    if (part === undefined) return null;
    if (segment.kind === "static") {
      if (segment.value !== part) return null;
      continue;
    }
    if (part.length === 0) return null;
    params[segment.name] = safeDecode(part);
  }
  return params;
}

function compile(path: string, source: string): Segment[] {
  if (!path.startsWith("/")) {
    throw new CmsConfigError(
      source === "core" ? "routes" : `plugins.${source}.routes`,
      `route path "${path}" must start with "/"`,
    );
  }
  const parts = split(path);
  return parts.map((part, index) => {
    if (part === "*") {
      if (index !== parts.length - 1) {
        throw new CmsConfigError(
          source === "core" ? "routes" : `plugins.${source}.routes`,
          `route path "${path}" may only use "*" as its last segment`,
        );
      }
      return { kind: "wildcard" };
    }
    if (part.startsWith(":")) {
      const name = part.slice(1);
      if (name.length === 0) {
        throw new CmsConfigError(
          source === "core" ? "routes" : `plugins.${source}.routes`,
          `route path "${path}" has an unnamed parameter`,
        );
      }
      return { kind: "param", name };
    }
    return { kind: "static", value: part };
  });
}

/** Trailing and repeated slashes are noise, not meaning. */
function split(path: string): string[] {
  return path.split("/").filter((part) => part.length > 0);
}

/**
 * A malformed escape sequence is a bad request, not a crash.
 *
 * `decodeURIComponent("%")` throws, and an id that fails to decode simply
 * cannot name a document, so the raw segment is the most useful thing to pass
 * on: the handler answers 404 with the string the caller actually sent.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
