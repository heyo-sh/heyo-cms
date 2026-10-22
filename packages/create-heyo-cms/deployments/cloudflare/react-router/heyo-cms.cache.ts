/**
 * What the `posts` views are cached under, and what empties it — on
 * Cloudflare.
 *
 * Workers are not behind the cache, they are in front of it: a response a
 * Worker generates is never stored by the edge unless the Worker puts it
 * there. So this file has one more part than the other deployments do —
 * `serveFromEdgeCache`, which the Worker entry wraps the whole application
 * in. A view still only declares its tags; the storing and the purging are
 * the platform's half, and they live here.
 *
 *   view            cachePage()          "this may be held, under these tags"
 *   worker entry    serveFromEdgeCache() look it up, and store what was tagged
 *   write hook      revalidatePosts()    purge those tags across every colo
 *
 * Two things are worth knowing before you trust it. The Cache API does
 * nothing on a `workers.dev` subdomain — a custom domain on a zone is what
 * gives this Worker a cache at all. And purging reaches every data centre
 * only through the API below; `cache.delete()` would empty the one colo that
 * happened to run the write, which is the sort of half-measure that teaches
 * people not to trust caches.
 */

/** Every list of posts. A write to any post empties them. */
export const postsTag = "posts";

/** One post, named by the handle its URL is made of. */
export function postTag(handle: string): string {
  return `posts:${handle}`;
}

/**
 * The tags a document sits behind.
 *
 * Both of them, always: a changed post is a changed post page *and* a
 * changed list. The handle is read defensively because a hook sees whatever
 * the document holds, including a draft saved before anyone typed one.
 */
export function postTags(doc: { handle?: unknown }): string[] {
  const handle = typeof doc.handle === "string" ? doc.handle : null;
  return handle === null ? [postsTag] : [postsTag, postTag(handle)];
}

/**
 * How long the edge may answer without running this Worker again.
 *
 * An hour is not how fresh the site is — a purge makes an edit visible in
 * seconds. It is the floor under a purge that never arrives: a post written
 * by the CLI on a laptop, or a deployment whose purge token was never set.
 */
const sharedMaxAge = 3600;

/** Declares a view cacheable, and says what empties it. */
export async function cachePage(
  headers: Headers,
  tags: readonly string[],
): Promise<void> {
  headers.set(
    "cache-control",
    `public, s-maxage=${sharedMaxAge}, stale-while-revalidate=86400`,
  );
  // Cloudflare strips `Cache-Tag` before the response reaches the reader; it
  // exists so the purge below can name what it is emptying.
  headers.set("cache-tag", [...new Set(tags)].join(","));
}

/**
 * The edge cache, as much of it as this file uses.
 *
 * Typed here rather than imported: `@cloudflare/workers-types` is not a
 * dependency of this project, and three methods is a smaller price than a
 * types package in the dependency list of an application that otherwise has
 * none.
 */
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function edgeCache(): EdgeCache | null {
  const store = (globalThis as { caches?: { default?: EdgeCache } }).caches;
  return store?.default ?? null;
}

/**
 * Answers from the edge when it can, and fills the edge when it cannot.
 *
 * Only responses that went through `cachePage` are stored: the presence of
 * `cache-tag` is how a view says "this one". That keeps the API, the panel
 * and every signed-in page out of a shared cache by construction rather than
 * by a path list somebody has to maintain — a mistake there is a session
 * cookie served to the wrong person.
 */
export async function serveFromEdgeCache(
  request: Request,
  render: () => Promise<Response>,
): Promise<Response> {
  const cache = edgeCache();
  if (cache === null || request.method !== "GET") return render();

  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await render();
  const cacheable =
    response.ok &&
    response.headers.has("cache-tag") &&
    !response.headers.has("set-cookie");
  // Awaited rather than handed to `waitUntil`: the entry is small, the write
  // is local to the colo, and a cache that is populated only when the
  // platform feels generous is a cache nobody can reason about.
  if (cacheable) await cache.put(request, response.clone());
  return response;
}

/**
 * Empties what a write made wrong, in every data centre.
 *
 * Purging by tag is available on every Cloudflare plan and needs a token
 * with the `Cache Purge` permission on the zone. Without one this is a
 * no-op and the pages expire on their own an hour later, which is the
 * behaviour a project that has not set the secret yet should get: slower,
 * never wrong for longer than the TTL, and never a failed save.
 */
export async function revalidatePosts(tags: readonly string[]): Promise<void> {
  const { zone, token } = await purgeCredentials();
  if (!zone || !token) return;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone)}/purge_cache`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tags: [...new Set(tags)] }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    // Logged, not thrown. The document is already written; failing the save
    // because a CDN did not answer would be the wrong half to undo.
    console.warn(
      `[cache] Cloudflare refused the purge (HTTP ${response.status}).`,
    );
  }
}

/**
 * The zone and the token, from whichever half of the runtime has them.
 *
 * Inside a Worker they are secrets on the deployment; on a laptop running
 * the CLI they are environment variables. The same two sources the database
 * and the bucket read, for the same reason: one configuration, two runtimes.
 */
async function purgeCredentials(): Promise<{
  zone: string | undefined;
  token: string | undefined;
}> {
  const injected =
    (globalThis as { __heyoCloudflareEnv?: Record<string, unknown> }) // prettier-ignore
    .__heyoCloudflareEnv;
  let env: Record<string, unknown> = injected ?? {};

  if (!env.CLOUDFLARE_ZONE_ID) {
    try {
      const module = (await import(
        /* @vite-ignore */ "cloudflare:workers"
      )) as {
        env?: Record<string, unknown>;
      };
      env = { ...module.env, ...env };
    } catch {
      // Not in a Worker. The environment below is the only source.
    }
  }

  const read = (name: string): string | undefined => {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) return value;
    const fallback = process.env[name];
    return fallback && fallback.length > 0 ? fallback : undefined;
  };
  return {
    zone: read("CLOUDFLARE_ZONE_ID"),
    token: read("CLOUDFLARE_PURGE_TOKEN"),
  };
}
