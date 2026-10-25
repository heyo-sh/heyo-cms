import { CmsConfigError } from "../errors";
import type { CmsEvent, CmsEventListener } from "../types/events";
import type { JsonObject } from "../types/json";
import type { CmsPlugin } from "../types/plugin";

/**
 * IndexNow: tells Bing, Yandex, Seznam, Naver and the other engines that
 * share the protocol that a page changed, so they recrawl it now rather than
 * whenever they next pass by. Google does not take part; it reads the
 * sitemap.
 *
 * ```ts
 * plugins: [
 *   indexNow({
 *     key: () => env.INDEXNOW_KEY,
 *     url: (post, { collection, locale }) =>
 *       post.status === "published" ? `https://example.com/${locale}/blog/${post.slug}` : null,
 *     enabled: import.meta.env.PROD,
 *   }),
 * ]
 * ```
 *
 * Two halves, both of which have to live in the CMS rather than in a hook of
 * the site:
 *
 * - **After the commit.** The ping is an event listener, delivered from the
 *   outbox once the write has committed — a rolled back save announces
 *   nothing, and a ping is never sent from inside a transaction that may
 *   still fail. On a serverless runtime the framework adapter hands the
 *   delivery to `waitUntil`, so it is not lost when the request ends.
 * - **The key file.** The protocol checks a submission by fetching
 *   `https://<host>/<key>.txt`, and only a file at the root covers every URL
 *   of the host. The plugin serves it as a root route: mount the CMS handler
 *   on `/[key].txt` as well (`src/pages/[key].txt.ts` in Astro).
 *
 * For an update, both the address the page has now and the one it had are
 * sent — a changed slug, or a page that stopped being public, is a URL the
 * engines should look at again. A trashed or purged page sends its last
 * address, which now answers 404. A failed ping is logged and dropped: the
 * document is saved, and a search engine that did not answer is no reason
 * to replay the event to every other listener.
 */

export interface IndexNowContext {
  /** The collection's name, as in `collections`. */
  collection: string;
  /** The language the write was made in. */
  locale: string;
}

export interface IndexNowOptions {
  /**
   * The key: 8 to 128 letters, digits and dashes. Not a secret — the
   * protocol publishes it at `/<key>.txt` — but usually a deployment
   * setting, hence the function form, read when it is needed.
   */
  key:
    | string
    | (() => string | null | undefined | Promise<string | null | undefined>);
  /**
   * The public address of a document in one language, or null when it has
   * none there: a draft, a `noindex` page, a collection with no pages.
   */
  url: (
    document: JsonObject,
    context: IndexNowContext,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /** Only these collections. Every one by default; `url` decides the rest. */
  collections?: string[];
  /**
   * Whether to send anything. A development server and a preview deployment
   * must not tell search engines about pages that do not exist publicly.
   */
  enabled?: boolean | (() => boolean | Promise<boolean>);
  /** `https://api.indexnow.org/indexnow`, which shares with every member engine. */
  endpoint?: string;
  fetch?: IndexNowFetch;
}

/** `fetch`, as much of it as a submission uses. */
export type IndexNowFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

const keyFormat = /^[A-Za-z0-9-]{8,128}$/;

/** The events that can change what a public URL shows, or whether it exists. */
const relevant = [
  "document.created",
  "document.updated",
  "document.trashed",
  "document.restored",
  "document.purged",
] as const;

export function indexNow(options: IndexNowOptions): CmsPlugin<unknown> {
  if (typeof options.key === "string" && !keyFormat.test(options.key)) {
    throw new CmsConfigError(
      "plugins.indexnow.key",
      "must be 8 to 128 letters, digits or dashes",
    );
  }
  if (typeof options.url !== "function") {
    throw new CmsConfigError(
      "plugins.indexnow.url",
      "must be a function returning a document's public URL",
    );
  }
  const endpoint = options.endpoint ?? "https://api.indexnow.org/indexnow";
  const send: IndexNowFetch =
    options.fetch ?? ((input, init) => fetch(input, init));
  const only = options.collections ? new Set(options.collections) : null;

  const key = async (): Promise<string | null> => {
    const value =
      typeof options.key === "function" ? await options.key() : options.key;
    const trimmed = typeof value === "string" ? value.trim() : "";
    return keyFormat.test(trimmed) ? trimmed : null;
  };
  const enabled = async (): Promise<boolean> =>
    typeof options.enabled === "function"
      ? await options.enabled()
      : options.enabled !== false;

  const urlOf = async (
    document: unknown,
    context: IndexNowContext,
  ): Promise<string | null> => {
    if (typeof document !== "object" || document === null) return null;
    const value = await options.url(document as JsonObject, context);
    if (typeof value !== "string") return null;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:"
        ? parsed.href
        : null;
    } catch {
      return null;
    }
  };

  const listener: CmsEventListener = async (event: CmsEvent) => {
    const collection = String(event.data.collection ?? "");
    if (!collection || (only && !only.has(collection))) return;
    if (!(await enabled())) return;
    const context: IndexNowContext = {
      collection,
      locale: String(event.data.locale ?? ""),
    };

    const urls = new Set<string>();
    const now = await urlOf(event.data.document, context);
    if (now) urls.add(now);
    const before = await urlOf(event.previous?.document, context);
    if (before) urls.add(before);
    if (urls.size === 0) return;

    const secret = await key();
    if (!secret) {
      console.warn("[indexnow] no valid key; nothing was sent.");
      return;
    }
    await submitIndexNow({ endpoint, key: secret, urls: [...urls], fetch: send }); // prettier-ignore
  };

  return {
    id: "indexnow",
    events: Object.fromEntries(relevant.map((type) => [type, listener])),
    routes: [
      {
        method: "GET",
        path: "/:file",
        root: true,
        handler: async ({ params }) => {
          const secret = await key();
          if (!secret || params.file !== `${secret}.txt`) {
            return new Response("Not found", {
              status: 404,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          return new Response(secret, {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "public, max-age=86400",
            },
          });
        },
      },
    ],
  };
}

/**
 * One submission per host: the protocol takes a single `host` per request,
 * with a key file on that host.
 */
export async function submitIndexNow(args: {
  key: string;
  urls: string[];
  endpoint?: string;
  fetch?: IndexNowFetch;
}): Promise<void> {
  const send: IndexNowFetch =
    args.fetch ?? ((input, init) => fetch(input, init));
  const byHost = new Map<string, { origin: string; urls: string[] }>();
  for (const url of args.urls) {
    const parsed = new URL(url);
    const entry = byHost.get(parsed.host) ?? { origin: parsed.origin, urls: [] }; // prettier-ignore
    entry.urls.push(parsed.href);
    byHost.set(parsed.host, entry);
  }

  for (const [host, { origin, urls }] of byHost) {
    try {
      const response = await send(
        args.endpoint ?? "https://api.indexnow.org/indexnow",
        {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            host,
            key: args.key,
            keyLocation: `${origin}/${args.key}.txt`,
            urlList: urls,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      // 200 and 202 are both success; 202 means "key not checked yet".
      if (!response.ok) {
        console.warn(`[indexnow] ${host}: HTTP ${response.status} for ${urls.length} URL(s).`); // prettier-ignore
      }
      await response.body?.cancel();
    } catch (error) {
      console.warn(
        `[indexnow] ${host}: not delivered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
