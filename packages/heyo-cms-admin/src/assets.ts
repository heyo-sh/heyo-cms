import type {
  AdminAsset,
  AdminAssets,
  AdminMountContext,
} from "@heyo-sh/heyo-cms/types";

/**
 * The panel, as files the CMS handler can serve.
 *
 * The panel is not a deployment. It is a bundle inlined into this module and
 * handed to `admin.assets`, so the same handler that answers `GET /posts`
 * answers `GET /admin/assets/app-9f2c1a.js` — one origin, no CORS, no second
 * build in the pipeline, and no filesystem, which is what makes it work on
 * Workers (section 10).
 *
 * The HTML shell is not one of those files. It is written per deployment from
 * `AdminMountContext`, because a static bundle cannot know whether it is
 * mounted at `/api/heyo-cms/admin` or at `/cms` — and every request the panel
 * makes, plus every link it writes, is derived from exactly that.
 */

/** One built file, inlined. Text stays text; anything else is base64. */
export interface PanelBundleFile {
  /** Path under the panel root: `assets/app-9f2c1a.js`. */
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  contentType: string;
  /** Content hash, so `If-None-Match` is answered without re-reading. */
  etag: string;
}

export interface PanelBundle {
  /** `heyo-cms-admin@<hash>`, printed by `cms.inspect().admin.panel`. */
  id: string;
  /** The two files the shell references. */
  entry: { script: string; style: string };
  files: PanelBundleFile[];
  /** False in a source checkout where `bun run build` has not run. */
  built: boolean;
}

export interface AdminAssetsOptions {
  /**
   * Overrides the page title.
   *
   * Defaults to `admin.title`, which is what the handler passes in. Here for
   * the deployment that wants the browser tab to say something other than
   * what the panel's own header says.
   */
  title?: string;
  /** Inlined `<link rel="icon">`; a data URI or a URL. */
  favicon?: string;
}

/** Where the panel ends up when the handler has not said otherwise. */
const defaultMount: AdminMountContext = {
  basePath: "/api/heyo-cms",
  panelPath: "/api/heyo-cms/admin",
  title: "Heyo CMS",
};

/*
 * This runs before the stylesheet is requested. `light-dark()` follows
 * `color-scheme`, so waiting for React to read localStorage would first paint
 * the OS mode and then repaint every surface after the app starts.
 */
const initialThemeScript = `(() => {
  let stored = null;
  try { stored = window.localStorage.getItem("heyo-cms:theme"); } catch {}
  const mode = stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const root = document.documentElement;
  root.setAttribute("data-mode", mode);
  root.style.colorScheme = mode;
})();`;

export function createAdminAssets(
  bundle: PanelBundle,
  options: AdminAssetsOptions = {},
): AdminAssets {
  const files = new Map(bundle.files.map((file) => [file.path, file]));
  let mount = defaultMount;
  let shell: AdminAsset | null = null;

  return {
    id: bundle.id,

    configure(context: AdminMountContext): void {
      mount = context;
      // The shell embeds the mount, so a re-mount has to invalidate it. In
      // practice this is called once per process, before the first request.
      shell = null;
    },

    async asset(path: string): Promise<AdminAsset | null> {
      if (path === "" || path === "/" || path === "index.html") {
        shell ??= shellAsset(bundle, mount, options);
        return shell;
      }

      const file = files.get(normalise(path));
      if (!file) return null;
      return {
        body:
          file.encoding === "base64"
            ? decodeBase64(file.content)
            : file.content,
        contentType: file.contentType,
        etag: file.etag,
      };
    },
  };
}

function normalise(path: string): string {
  return path.replace(/^\/+/, "");
}

function shellAsset(
  bundle: PanelBundle,
  mount: AdminMountContext,
  options: AdminAssetsOptions,
): AdminAsset {
  const html = bundle.built
    ? shellHtml(bundle, mount, options)
    : unbuiltHtml(mount);
  return {
    body: html,
    contentType: "text/html; charset=utf-8",
    // Never cached: the shell carries the mount point and the bundle's
    // hashed filenames, and both change without the URL changing.
    cacheControl: "no-cache",
    etag: `"${hash(`${bundle.id}:${mount.panelPath}:${html.length}`)}"`,
  };
}

/**
 * The one HTML file, written per deployment.
 *
 * Three things have to reach the browser before any JavaScript runs: where
 * the API is, where the panel is mounted, and what to call it. They go in a
 * single global rather than in `data-` attributes because the panel reads
 * them during module evaluation, when the DOM is one empty div.
 *
 * The executable inline script is static and contains no user input: it
 * applies the stored theme before CSS. Configuration values go through
 * `JSON.stringify` into a `<script type="application/json">`, which cannot
 * execute whatever it holds.
 */
function shellHtml(
  bundle: PanelBundle,
  mount: AdminMountContext,
  options: AdminAssetsOptions,
): string {
  const title = options.title ?? mount.title;
  const base = mount.panelPath;
  const context = JSON.stringify({
    basePath: mount.basePath,
    panelPath: mount.panelPath,
    title,
  });

  return `<!doctype html>
<html lang="en" class="heyo-cms">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(title)}</title>
    ${options.favicon ? `<link rel="icon" href="${escapeAttribute(options.favicon)}" />` : ""}
    <script>${initialThemeScript}</script>
    <link rel="stylesheet" href="${escapeAttribute(`${base}/${bundle.entry.style}`)}" />
    <script type="application/json" id="heyo-cms-panel">${escapeJson(context)}</script>
    <script type="module" src="${escapeAttribute(`${base}/${bundle.entry.script}`)}"></script>
  </head>
  <body>
    <div id="heyo-cms-root"></div>
    <noscript>The panel needs JavaScript. The API does not: see ${escapeHtml(mount.basePath)}/openapi.json.</noscript>
  </body>
</html>
`;
}

/**
 * The page a source checkout serves.
 *
 * `bun run build` produces the bundle; importing this package from `src`
 * without it is a normal thing to do by accident, and a blank page is the
 * worst possible answer to it.
 */
function unbuiltHtml(mount: AdminMountContext): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Heyo CMS</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; max-width: 42rem; padding: 4rem 1.5rem; }
      code { font-family: ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <h1>The panel is not built</h1>
    <p>
      <code>@heyo-sh/heyo-cms-admin</code> is being loaded from source and its
      bundle has not been produced yet. Run
      <code>bun run --filter @heyo-sh/heyo-cms-admin build</code>.
    </p>
    <p>The API is unaffected: <a href="${escapeAttribute(`${mount.basePath}/openapi.json`)}">openapi.json</a>.</p>
  </body>
</html>
`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** FNV-1a. Not a security boundary: an ETag only has to change when bytes do. */
function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

/** `</script>` inside JSON would end the element it is written into. */
function escapeJson(value: string): string {
  return value.replaceAll("<", "\\u003c");
}
