import { defaultBasePath } from "../defaults";
import { CmsError } from "../errors";
import { trimTrailingSlashes } from "../strings";
import type { JsonObject } from "../types/json";
import type { CmsPlugin } from "../types/plugin";
import type { OrderBy, Where } from "../types/query";
import type {
  ClientCollection,
  ClientCore,
  ClientFindArgs,
  ClientGlobal,
  ClientMedia,
  ClientReadArgs,
  ClientRequest,
  ClientUploadArgs,
  CmsClient,
  PluginExtensions,
} from "./types";

/**
 * The typed client.
 *
 * The public entry point picks up the project's registered CMS type, so
 * `heyoCmsClient()` is typed without importing server configuration into the
 * browser bundle. `heyoCmsClient<typeof cms>()` remains available for a
 * project with more than one CMS. The methods
 * mirror `cms.api` exactly, because the routes they call are three lines
 * around `cms.api`: code written against the local API moves to the client by
 * changing the object it is called on.
 *
 * What it is not: an ORM, a cache or a state manager. It is `fetch` with the
 * URL building, the error shape and the 204 convention taken care of, and it
 * is tiny on purpose — this ships to browsers.
 */

export interface CmsClientOptions<
  TPlugins extends readonly CmsPlugin<unknown>[] = [],
> {
  /**
   * Where the handler is mounted.
   *
   * Defaults to the same-origin `/api/heyo-cms` mount in a browser. Set this
   * for a custom mount or a CMS on another origin, e.g.
   * `https://cms.acme.dev/api/heyo-cms`.
   */
  baseUrl?: string;
  /**
   * A session token or an API key.
   *
   * A function is resolved per request, which is what makes a rotating key or
   * a token read out of a cookie store work without rebuilding the client.
   * Omit it in a browser: the session cookie is sent automatically.
   */
  token?: string | (() => string | null | undefined | Promise<string | null | undefined>); // prettier-ignore
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Injectable so a test, a Worker or a framework's own `fetch` can be used. */
  fetch?: typeof fetch;
  /** Defaults to `same-origin`, which is what a cookie session needs. */
  credentials?: RequestCredentials;
  /**
   * The plugins whose client extensions should be installed.
   *
   * Passed rather than discovered: the configuration lives on the server and
   * the client is a browser bundle, so the only way the extension types can
   * reach it is through this list.
   */
  plugins?: TPlugins;
}

export function heyoCmsClient<
  TCms = import("../types/instance").CmsInstance,
  const TPlugins extends readonly CmsPlugin<unknown>[] = [],
>(
  options: CmsClientOptions<TPlugins> = {},
): CmsClient<TCms> & PluginExtensions<TPlugins> {
  // This is deliberately relative: the no-options client is the same-origin
  // browser case. `requestUrl()` resolves it only when a request is made, so
  // importing the client from a server module stays safe.
  const baseUrl = trimTrailingSlashes(options.baseUrl ?? defaultBasePath);
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)); // prettier-ignore

  const request: ClientRequest = async (path, init = {}) => {
    const { query, headers, ...rest } = init as RequestInit & {
      query?: Record<string, unknown>;
    };
    const url = requestUrl(baseUrl, path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }

    const resolved = new Headers(headers);
    for (const [key, value] of Object.entries(await resolveHeaders(options))) {
      if (!resolved.has(key)) resolved.set(key, value);
    }
    const token = await resolveToken(options);
    if (token && !resolved.has("authorization")) {
      resolved.set("authorization", `Bearer ${token}`);
    }

    const response = await fetchImpl(url, {
      ...rest,
      headers: resolved,
      credentials: options.credentials ?? "same-origin",
    });

    if (response.status === 204) {
      // The documented way a write reports that a `before` hook stopped it.
      // Returning `null` keeps the client's contract identical to the local
      // API's, where that case is also `null` (section 5).
      return null;
    }
    const body = await readBody(response);
    if (!response.ok) throw toError(response, body);
    return body;
  };

  const core: ClientCore = {
    baseUrl,
    request,
    media: media(request, baseUrl),
    auth: {
      signIn: (args) =>
        request("/auth/sign-in", jsonInit(args)) as Promise<never>,
      claimFirstAccount: (args) =>
        request("/auth/setup", jsonInit(args)) as Promise<never>,
      signOut: async () => {
        await request("/auth/sign-out", { method: "POST" });
      },
      session: () => request("/auth/session") as Promise<never>,
      magicLink: (args) =>
        request("/auth/magic-link", jsonInit(args)) as Promise<never>,
      verifyMagicLink: (args) =>
        request("/auth/magic-link/verify", jsonInit(args)) as Promise<never>,
      forgotPassword: (args) =>
        request("/auth/password/forgot", jsonInit(args)) as Promise<never>,
      resetPassword: (args) =>
        request("/auth/password/reset", jsonInit(args)) as Promise<never>,
      acceptInvite: (args) =>
        request("/auth/invite/accept", jsonInit(args)) as Promise<never>,
      verifyTwoFactor: (args) =>
        request("/auth/2fa/verify", jsonInit(args)) as Promise<never>,
      beginTwoFactor: () =>
        request("/auth/2fa/begin", { method: "POST" }) as Promise<never>,
      enableTwoFactor: (args) =>
        request("/auth/2fa/enable", jsonInit(args)) as Promise<never>,
      disableTwoFactor: () =>
        request("/auth/2fa/disable", { method: "POST" }) as Promise<never>,
      apiKeys: {
        list: async () =>
          unwrap(await request("/auth/api-keys"), "keys") as never,
        create: (args) =>
          request("/auth/api-keys", jsonInit(args)) as Promise<never>,
        revoke: async (id) => {
          await request(`/auth/api-keys/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
        },
      },
      oauthUrl: (provider, redirectTo) => {
        const url = requestUrl(
          baseUrl,
          `/auth/oauth/${encodeURIComponent(provider)}`,
        );
        if (redirectTo) url.searchParams.set("redirectTo", redirectTo);
        return url.toString();
      },
    },
    users: {
      list: (args) => request("/users", { query: args as never }) as Promise<never>, // prettier-ignore
      get: async (id) =>
        unwrap(
          await request(`/users/${encodeURIComponent(id)}`),
          "user",
        ) as never,
      update: async (id, args) =>
        unwrap(
          await request(`/users/${encodeURIComponent(id)}`, jsonInit(args, "PATCH")), // prettier-ignore
          "user",
        ) as never,
      invite: (args) =>
        request("/users/invite", jsonInit(args)) as Promise<never>,
      remove: async (id) => {
        await request(`/users/${encodeURIComponent(id)}`, { method: "DELETE" });
      },
    },
    roles: {
      list: async () => unwrap(await request("/roles"), "roles") as never,
      create: async (args) =>
        unwrap(await request("/roles", jsonInit(args)), "role") as never,
      update: async (name, args) =>
        unwrap(
          await request(`/roles/${encodeURIComponent(name)}`, jsonInit(args, "PATCH")), // prettier-ignore
          "role",
        ) as never,
      remove: async (name) => {
        await request(`/roles/${encodeURIComponent(name)}`, { method: "DELETE" }); // prettier-ignore
      },
    },
    trash: {
      list: (args) => request("/trash", { query: args as never }) as Promise<never>, // prettier-ignore
      restore: (args) =>
        request(
          `/trash/${encodeURIComponent(args.collection)}/${encodeURIComponent(args.id)}/restore`,
          { method: "POST" },
        ) as Promise<never>,
      purge: (args) =>
        request(
          `/trash/${encodeURIComponent(args.collection)}/${encodeURIComponent(args.id)}`,
          { method: "DELETE" },
        ) as Promise<never>,
    },
    locales: {
      list: () => request("/locales") as Promise<never>,
    },
    activity: {
      list: (args) =>
        request("/activity", { query: args as never }) as Promise<never>,
    },
    jobs: {
      run: (args) =>
        request("/jobs/run", {
          method: "POST",
          query: {
            ...(args?.limit === undefined ? {} : { limit: args.limit }),
            ...(args?.only === undefined ? {} : { only: args.only.join(",") }),
          },
        }) as Promise<never>,
      failures: async (args) =>
        unwrap(
          await request("/jobs/failures", { query: args as never }),
          "failures",
        ) as never,
    },
    openapi: () => request("/openapi.json") as Promise<JsonObject>,
  };

  /**
   * Collections and globals are resolved on access rather than enumerated.
   *
   * The client cannot see the configuration — it only has its type — so there
   * is no list to iterate. A proxy is the honest implementation: it is also
   * why an unknown property produces a 404 from the server rather than a
   * confusing `undefined is not a function`.
   */
  const target = core as unknown as Record<string, unknown>;
  const collections = new Map<string, unknown>();

  const client = new Proxy(target, {
    get(receiver, property) {
      if (typeof property !== "string" || property in receiver) {
        return receiver[property as keyof typeof receiver];
      }
      const existing = collections.get(property);
      if (existing) return existing;
      const built = collection(request, property);
      collections.set(property, built);
      return built;
    },
    // Consistent with `get`: any name resolves to a collection accessor, so
    // `"posts" in client` must not disagree with `client.posts` working.
    has(receiver, property) {
      return typeof property === "string"
        ? true
        : Reflect.has(receiver, property);
    },
  });

  // The same lazy accessors behind one property, so a singleton reads as
  // `client.globals.settings.get()` — a namespace rather than a flat merge,
  // because a global and a collection may legitimately share a name.
  const globals = new Map<string, unknown>();
  target.globals = new Proxy(
    {},
    {
      get(_receiver, property) {
        if (typeof property !== "string") return undefined;
        const existing = globals.get(property);
        if (existing) return existing;
        const built = globalApi(request, property);
        globals.set(property, built);
        return built;
      },
    },
  );

  for (const plugin of options.plugins ?? []) {
    const extension = plugin.client?.({ baseUrl, request });
    if (!extension) continue;
    for (const [key, value] of Object.entries(extension)) {
      if (key in target) {
        throw new CmsError(
          `The "${plugin.id}" plugin's client extension would overwrite "${key}".`,
          { status: 500, code: "client_extension_conflict" },
        );
      }
      target[key] = value;
    }
  }

  return client as CmsClient<TCms> & PluginExtensions<TPlugins>;
}

function collection(
  request: ClientRequest,
  slug: string,
): ClientCollection<JsonObject> {
  const base = `/${slug}`;
  const id = (value: string) => `${base}/${encodeURIComponent(value)}`;

  return {
    find: (args = {}) =>
      request(base, {
        query: findQuery(args),
        ...headerInit(args),
      }) as Promise<never>,
    findById: (value, args = {}) =>
      request(id(value), {
        query: readQuery(args),
        ...headerInit(args),
      }) as Promise<never>,
    create: ({ data, ...args }) =>
      request(base, {
        ...jsonInit({ data }),
        query: readQuery(args),
        ...headerInit(args),
      }) as Promise<never>,
    update: ({ id: value, data, ...args }) =>
      request(id(value), {
        ...jsonInit({ data }, "PATCH"),
        query: readQuery(args),
        ...headerInit(args),
      }) as Promise<never>,
    delete: ({ id: value, permanent, ...args }) =>
      request(id(value), {
        method: "DELETE",
        query: {
          ...readQuery(args),
          ...(permanent === true ? { permanent: true } : {}),
        },
        ...headerInit(args),
      }) as Promise<never>,
    restore: ({ id: value, ...args }) =>
      request(`${id(value)}/restore`, {
        method: "POST",
        query: readQuery(args),
        ...headerInit(args),
      }) as Promise<never>,
    schedule: ({ id: value, at, data, ...args }) =>
      request(`${id(value)}/schedule`, {
        ...jsonInit({ at: at instanceof Date ? at.toISOString() : at, data }),
        query: readQuery(args),
        ...headerInit(args),
      }) as Promise<never>,
    unschedule: ({ id: value, ...args }) =>
      request(`${id(value)}/schedule`, {
        method: "DELETE",
        query: readQuery(args),
        ...headerInit(args),
      }) as Promise<never>,
    resolveSlug: async (slug, { field, ...args } = {}) => {
      try {
        return (await request(`${base}/resolve-slug`, {
          query: { ...readQuery(args), slug, field },
          ...headerInit(args),
        })) as never;
      } catch (error) {
        // "No such slug" is an answer, not a failure: the local API says
        // null, and so does this.
        if (error instanceof CmsError && error.status === 404) return null;
        throw error;
      }
    },
    previousSlugs: ({ id: value, field, locale, ...args }) =>
      request(`${id(value)}/previous-slugs`, {
        query: { field, locale },
        ...headerInit(args),
      }) as Promise<never>,
    addPreviousSlug: ({ id: value, slug, field, locale, ...args }) =>
      request(`${id(value)}/previous-slugs`, {
        ...jsonInit({ slug, field, locale }),
        ...headerInit(args),
      }) as Promise<never>,
    removePreviousSlug: ({ id: value, slug, field, locale, ...args }) =>
      request(`${id(value)}/previous-slugs`, {
        method: "DELETE",
        query: { slug, field, locale },
        ...headerInit(args),
      }) as Promise<never>,
  };
}

function globalApi(
  request: ClientRequest,
  slug: string,
): ClientGlobal<JsonObject> {
  const base = `/globals/${slug}`;
  return {
    get: (args = {}) =>
      request(base, { query: readQuery(args), ...headerInit(args) }) as Promise<never>, // prettier-ignore
    update: ({ data, ...args }) =>
      request(base, {
        ...jsonInit({ data }, "PATCH"),
        query: readQuery(args),
      }) as Promise<never>,
    schedule: ({ at, data, ...args }) =>
      request(`${base}/schedule`, {
        ...jsonInit({ at: at instanceof Date ? at.toISOString() : at, data }),
        query: readQuery(args),
      }) as Promise<never>,
    unschedule: (args = {}) =>
      request(`${base}/schedule`, {
        method: "DELETE",
        query: readQuery(args),
      }) as Promise<never>,
  };
}

function media(request: ClientRequest, baseUrl: string): ClientMedia {
  return {
    async upload(args) {
      const form = new FormData();
      if (typeof File !== "undefined" && args instanceof File) {
        form.set("file", args);
      } else {
        const upload = args as ClientUploadArgs;
        const blob =
          upload.file instanceof Blob
            ? upload.file
            : new Blob([upload.file as BlobPart], {
                ...(upload.contentType ? { type: upload.contentType } : {}),
              });
        form.set("file", blob, upload.filename ?? "upload");
        if (upload.filename) form.set("filename", upload.filename);
        if (upload.alt !== undefined) form.set("alt", upload.alt);
        if (upload.locale !== undefined) form.set("locale", upload.locale);
        if (upload.metadata !== undefined) {
          form.set("metadata", JSON.stringify(upload.metadata));
        }
      }
      // No `content-type`: the boundary is part of it, and setting the header
      // by hand is the classic way to make a multipart upload unparseable.
      return request("/media/upload", {
        method: "POST",
        body: form,
      }) as Promise<never>;
    },
    list: (args) =>
      request("/media", { query: args as never }) as Promise<never>,
    get: (id) => request(`/media/${encodeURIComponent(id)}`) as Promise<never>,
    update: ({ id, ...patch }) =>
      request(`/media/${encodeURIComponent(id)}`, jsonInit(patch, "PATCH")) as Promise<never>, // prettier-ignore
    delete: ({ id, force }) =>
      request(`/media/${encodeURIComponent(id)}`, {
        method: "DELETE",
        ...(force === true ? { query: { force: true } } : {}),
      }) as Promise<never>,
    keep: ({ id }) =>
      request(`/media/${encodeURIComponent(id)}/keep`, {
        method: "POST",
      }) as Promise<never>,
    usages: async (id) =>
      unwrap(
        await request(`/media/${encodeURIComponent(id)}/usages`),
        "usages",
      ) as never,
    url: (id, variant = "original") =>
      `${baseUrl}/media/${encodeURIComponent(id)}/${encodeURIComponent(variant)}`,
  };
}

function jsonInit(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
}

function headerInit(args: ClientReadArgs): RequestInit {
  return {
    ...(args.headers === undefined ? {} : { headers: args.headers }),
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };
}

function readQuery(args: ClientReadArgs): Record<string, unknown> {
  return {
    ...(args.locale === undefined ? {} : { locale: args.locale }),
    ...(args.fallbackLocale === undefined
      ? {}
      : { fallbackLocale: String(args.fallbackLocale) }),
    ...(args.depth === undefined ? {} : { depth: args.depth }),
    ...(args.includeTrashed === undefined
      ? {}
      : { includeTrashed: args.includeTrashed }),
  };
}

/**
 * The filter travels as the AST, not as a flattened query string.
 *
 * Which is the whole reason `?where=` exists on the server: `and(eq(...),
 * or(...))` composed in application code has to arrive intact, and no
 * bracket-notation encoding survives an `or` with two branches.
 */
function findQuery(args: ClientFindArgs): Record<string, unknown> {
  return {
    ...readQuery(args),
    ...(args.where === undefined ? {} : { where: JSON.stringify(serialiseWhere(args.where)) }), // prettier-ignore
    ...(args.orderBy === undefined
      ? {}
      : { sort: serialiseSort(args.orderBy) }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    ...(args.count === undefined ? {} : { count: args.count }),
  };
}

/** `Date` has no JSON form; the server parses an ISO string back. */
function serialiseWhere(where: Where): unknown {
  if (where.kind === "and" || where.kind === "or") {
    return { kind: where.kind, conditions: where.conditions.map(serialiseWhere) }; // prettier-ignore
  }
  if (where.kind === "not") {
    return { kind: "not", condition: serialiseWhere(where.condition) };
  }
  const value = Array.isArray(where.value)
    ? where.value.map(serialiseValue)
    : serialiseValue(where.value);
  return { kind: "compare", path: where.path, operator: where.operator, value };
}

function serialiseValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function serialiseSort(orderBy: OrderBy[]): string {
  return orderBy
    .map((entry) =>
      entry.direction === "desc" ? `-${entry.path}` : entry.path,
    )
    .join(",");
}

/** Turns the default relative mount into a request URL in a browser. */
function requestUrl(baseUrl: string, path: string): URL {
  const value = `${baseUrl}${path}`;
  try {
    return new URL(value);
  } catch {
    const origin = globalThis.location?.origin;
    if (origin) return new URL(value, origin);
    throw new CmsError('heyoCmsClient() needs "baseUrl" outside a browser.', {
      status: 500,
      code: "client_base_url_required",
    });
  }
}

async function resolveHeaders(
  options: CmsClientOptions<readonly CmsPlugin<unknown>[]>,
): Promise<Record<string, string>> {
  const headers = options.headers;
  if (!headers) return {};
  return typeof headers === "function" ? headers() : headers;
}

async function resolveToken(
  options: CmsClientOptions<readonly CmsPlugin<unknown>[]>,
): Promise<string | null> {
  const token = options.token;
  if (!token) return null;
  const resolved = typeof token === "function" ? await token() : token;
  return resolved ?? null;
}

async function readBody(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    return (await response.json()) as unknown;
  }
  const body = await response.text();
  return body.length === 0 ? null : body;
}

/**
 * The server's error shape, turned back into the error the engine threw.
 *
 * A `CmsError` on both sides means a caller writes one `catch` whether it is
 * talking to `cms.api` in a server component or to the client in a browser,
 * and `error.code` is the same string in both.
 */
function toError(response: Response, body: unknown): CmsError {
  const envelope =
    typeof body === "object" && body !== null
      ? ((body as { error?: Record<string, unknown> }).error ?? {})
      : {};
  const message =
    typeof envelope.message === "string"
      ? envelope.message
      : `The CMS answered ${response.status}.`;

  return new CmsError(message, {
    status: response.status,
    code: typeof envelope.code === "string" ? envelope.code : "request_failed",
    ...(envelope.details === undefined ? {} : { details: envelope.details }),
  });
}

/** Routes that answer `{ users: [...] }` so a later field can be added. */
function unwrap(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null) return body;
  return (body as Record<string, unknown>)[key];
}

export type * from "./types";
