/**
 * Everything the panel knows about talking to the CMS.
 *
 * Not the typed client from `@heyo-sh/heyo-cms/client`: that one infers its
 * methods from `typeof cms`, and the panel is one bundle compiled before any
 * configuration exists. So it is `fetch` plus three conventions the handler
 * already guarantees — the error envelope, the `204` that means "a hook
 * stopped it", and the session cookie — and nothing else.
 */

export interface PanelMount {
  basePath: string;
  panelPath: string;
  title: string;
}

/**
 * Where the shell said we are.
 *
 * Written into the page by `createAdminAssets`, because the bundle is static
 * and the mount point is configuration. The fallback is the documented
 * default, which keeps a hand-assembled page from failing silently.
 */
export const mount: PanelMount = readMount();

function readMount(): PanelMount {
  const element = document.getElementById("heyo-cms-panel");
  const fallback: PanelMount = {
    basePath: "/api/heyo-cms",
    panelPath: "/api/heyo-cms/admin",
    title: "Heyo CMS",
  };
  if (!element?.textContent) return fallback;
  try {
    const parsed = JSON.parse(element.textContent) as Partial<PanelMount>;
    return {
      basePath: safePath(parsed.basePath, fallback.basePath),
      panelPath: safePath(parsed.panelPath, fallback.panelPath),
      title: typeof parsed.title === "string" ? parsed.title : fallback.title,
    };
  } catch {
    return fallback;
  }
}

/**
 * The mount JSON is written by the server from the configuration, but the
 * panel still refuses anything that is not a plain absolute path: a value
 * that could carry a scheme (`javascript:`), an authority (`//evil`) or a
 * backslash never reaches `location.href` or an `href` attribute.
 */
function safePath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

/**
 * The server's error, rethrown as itself.
 *
 * `code` is the contract — `validation_failed`, `forbidden`, `not_found` —
 * and the panel branches on it rather than on a message, so a reworded error
 * never changes behaviour.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Multipart upload; set instead of `body`. */
  form?: FormData;
  signal?: AbortSignal;
}

async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetch(url(path, options.query), {
    method,
    // The session is an HttpOnly cookie scoped to `basePath`; the panel is
    // served from the same origin by construction, so there is nothing to
    // configure and nothing to store in `localStorage`.
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      // Labels the operation in the activity log and in every hook as
      // `admin` rather than `rest`. It grants nothing.
      "x-heyo-cms-client": "admin",
      ...(options.form || options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.form
      ? { body: options.form }
      : options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) {
    // The HTTP spelling of the local API's `null`: a `before` hook refused
    // the write. Callers check for `null` and say so.
    return null as T;
  }

  const text = await response.text();
  const payload = text.length > 0 ? safeJson(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { message?: string; code?: string } } | null)?.error; // prettier-ignore
    throw new ApiError(
      error?.message ?? `${method} ${path} failed with ${response.status}.`,
      response.status,
      error?.code ?? "request_failed",
    );
  }

  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** An absolute URL under `basePath`, with undefined parameters dropped. */
export function url(path: string, query?: RequestOptions["query"]): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return `${mount.basePath}${path.startsWith("/") ? path : `/${path}`}${suffix}`;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>("GET", path, options), // prettier-ignore
  post: <T>(path: string, options?: RequestOptions) => request<T>("POST", path, options), // prettier-ignore
  patch: <T>(path: string, options?: RequestOptions) => request<T>("PATCH", path, options), // prettier-ignore
  put: <T>(path: string, options?: RequestOptions) => request<T>("PUT", path, options), // prettier-ignore
  delete: <T>(path: string, options?: RequestOptions) => request<T>("DELETE", path, options), // prettier-ignore
  url,
};

/** The URL of a stored file, at a declared size. Not a fetch. */
export function mediaUrl(id: string, variant?: string): string {
  return url(`/media/${id}/${variant ?? "original"}`);
}
