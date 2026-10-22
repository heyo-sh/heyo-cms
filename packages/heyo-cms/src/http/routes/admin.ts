import type { CmsInstance } from "../../types/instance";
import type { JsonObject } from "../../types/json";
import { json } from "../respond";
import type { RouteRecord } from "../router";
import { pathParam } from "../spec";

/**
 * The panel, served from the same handler as the API.
 *
 * No separate deployment, no CORS, no second origin to configure: the bundle
 * is files, the handler serves files, and the panel talks to the API through
 * relative URLs (section 10). `admin.assets` is where the files come from —
 * an interface rather than a directory, because the bundle has to be readable
 * from a Worker, where there is no filesystem.
 *
 * Without one — `admin.assets` unset — this answers with a page that says
 * what is missing and links to the generated OpenAPI document.
 * Deliberately not a 404: a mount point that answers nothing is
 * indistinguishable from a mount point that is wrong, and the first thing
 * somebody does after wiring the catch-all route is open this URL.
 */
export function adminRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  // `admin.path: "/"` normalises to the empty string, meaning "the mount root":
  // the shell is then served at `basePath` itself and the wildcard becomes
  // `/*`, which is matched after every concrete route, so the API still wins.
  const adminPath = config.admin.path === "" ? "/" : config.admin.path;
  const assets = config.admin.assets;

  // Once, here, rather than per request: the bundle is static but the mount
  // point is configuration, and the panel's own links and API calls are
  // written from it (`AdminMountContext`).
  assets?.configure?.({
    basePath: config.basePath,
    panelPath: `${config.basePath}${config.admin.path}`,
    title: config.admin.title ?? "Heyo CMS",
  });

  const serve = async (path: string, request: Request): Promise<Response> => {
    if (!assets) return placeholder(cms);

    const asset =
      (await assets.asset(path)) ??
      // The SPA fallback: a deep link like `/admin/posts/doc_1` is a route
      // the panel resolves in the browser, not a file. Only paths that look
      // like files are allowed to 404, so a missing script is still a missing
      // script rather than an HTML page the browser cannot execute.
      (looksLikeFile(path) ? null : await assets.asset(""));

    if (!asset) {
      return json(
        { error: { message: "Not found.", code: "not_found", status: 404 } },
        404,
      );
    }

    const etag = asset.etag;
    if (etag && request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    // `Uint8Array` is a legal body at runtime on every supported engine; the
    // DOM typings model `BodyInit` as the browser's narrower union.
    return new Response(asset.body as BodyInit, {
      status: 200,
      headers: {
        "content-type": asset.contentType,
        "cache-control":
          asset.cacheControl ??
          (looksHashed(path)
            ? "public, max-age=31536000, immutable"
            : "no-cache"),
        ...(etag ? { etag } : {}),
      },
    });
  };

  return [
    {
      method: "GET",
      path: adminPath,
      source: "core",
      handler: (context) => serve("", context.request),
      openapi: {
        summary: "The admin panel",
        description:
          "The panel's HTML shell. Everything below it is the same single-page application.",
        tags: ["admin"],
        security: false,
        responses: { "200": { description: "HTML." } },
      },
    },
    {
      method: "GET",
      path: adminPath === "/" ? "/*" : `${adminPath}/*`,
      source: "core",
      handler: (context) => serve(context.params["*"] ?? "", context.request),
      openapi: {
        summary: "The admin panel's files and deep links",
        tags: ["admin"],
        security: false,
        parameters: [pathParam("*", "Asset path, or a panel route.")],
        responses: {
          "200": { description: "The asset, or the shell for a panel route." },
          "304": { description: "The cached copy is current." },
          "404": { description: "No such asset." },
        },
      },
    },
  ];
}

/**
 * `GET /openapi.json`: the canonical description of this deployment.
 *
 * Takes a function rather than the document because the document describes
 * this route too: the router has to be complete before it can be generated,
 * and generating it on first request also keeps it off the cold-start path.
 */
export function openApiRoute(document: () => JsonObject): RouteRecord {
  return {
    method: "GET",
    path: "/openapi.json",
    source: "core",
    handler: () => json(document()),
    openapi: {
      summary: "This document",
      description:
        "Generated from the configuration and the registered routes, including the ones plugins brought. It is the contract: a generated client, Postman and curl all read the same source.",
      tags: ["system"],
      security: false,
      responses: { "200": { description: "An OpenAPI 3.1 document." } },
    },
  };
}

function looksLikeFile(path: string): boolean {
  const last = path.split("/").at(-1) ?? "";
  return last.includes(".");
}

/** `app-9f2c1a.js`: a name that cannot describe two different files. */
function looksHashed(path: string): boolean {
  return /[.-][0-9a-f]{8,}\.[a-z0-9]+$/i.test(path);
}

function placeholder(cms: CmsInstance): Response {
  const config = cms._config;
  const base = config.basePath;
  const collections = Object.values(config.collections);
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(config.admin.title ?? "Heyo CMS")}</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; max-width: 46rem; padding: 4rem 1.5rem; }
      h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
      p { color: color-mix(in oklab, currentColor 70%, transparent); }
      code { font-family: ui-monospace, monospace; font-size: .9em; }
      ul { padding-left: 1.1rem; }
      a { color: inherit; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(config.admin.title ?? "Heyo CMS")}</h1>
    <p>
      The API is mounted at <code>${escapeHtml(base)}</code> and answering.
      The panel is not installed: <code>admin.assets</code> is not configured.
      Install <code>@heyo-sh/heyo-cms-admin</code> and pass
      <code>assets: adminAssets()</code>.
    </p>
    <ul>
      <li><a href="${escapeHtml(base)}/openapi.json">openapi.json</a> &mdash; every route this deployment answers</li>
      <li><a href="${escapeHtml(base)}/panel">panel</a> &mdash; what the panel would render here</li>
      <li><a href="${escapeHtml(base)}/auth/session">auth/session</a> &mdash; who you are right now</li>
${collections
  .map(
    (collection) =>
      `      <li><a href="${escapeHtml(base)}/${escapeHtml(collection.slug)}">${escapeHtml(collection.slug)}</a></li>`,
  )
  .join("\n")}
    </ul>
  </body>
</html>
`;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
