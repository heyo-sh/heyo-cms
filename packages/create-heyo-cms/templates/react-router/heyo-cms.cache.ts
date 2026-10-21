/**
 * What the `posts` views are cached under, and what empties it.
 *
 * Four names in one file, because a cache that works is a cache where the
 * thing that fills it and the thing that empties it agree on a spelling. A
 * view calls `cachePage` with the tags it read; `heyo-cms.config.ts` purges
 * the same tags from a write hook. There is no webhook to point at yourself
 * and no second place to keep in step.
 *
 * This is the version for `node ./dist/server/entry.mjs`: one process, and
 * nothing in front of it that holds a copy. The headers are still written,
 * because they are still true — a proxy, a CDN or a browser that honours
 * them is free to act on them — and the purge is the only honest
 * implementation available here: there is nothing to purge.
 *
 * Deploying replaces this file. `create-heyo-cms --deployment vercel` writes
 * the Vercel CDN version, `--deployment cloudflare` the Cloudflare one, and
 * neither the views nor the configuration change by a character.
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
 * How long a shared cache may answer without asking the CMS again.
 *
 * An hour is not how fresh the site is — a purge makes an edit visible in
 * seconds. It is the floor under a purge that never arrives: a post written
 * by the CLI on a laptop, a credential that expired, a plan without tag
 * purging. Caching for a year and trusting the purge is how a typo outlives
 * the person who made it.
 */
const sharedMaxAge = 3600;

/**
 * Declares a view cacheable, and says what empties it.
 *
 * Returns nothing and mutates the response headers, which is the shape every
 * framework here can use: Astro hands out `Astro.response.headers`, React
 * Router takes a `Headers` on its loader data.
 */
export async function cachePage(
  headers: Headers,
  tags: readonly string[],
): Promise<void> {
  headers.set(
    "cache-control",
    `public, s-maxage=${sharedMaxAge}, stale-while-revalidate=86400`,
  );
  // `Cache-Tag` is Cloudflare's spelling and harmless everywhere else. It is
  // written even here so that putting any CDN in front of this process is a
  // configuration change rather than a code change.
  headers.set("cache-tag", [...new Set(tags)].join(","));
}

/**
 * Empties what a write made wrong.
 *
 * Nothing to do on a single Node process: the page was rendered for the
 * request that asked for it and no copy outlived it. The signature is the
 * contract the deployment layers implement, and keeping it here means a
 * project can move to Vercel or Cloudflare without touching a hook.
 */
export async function revalidatePosts(tags: readonly string[]): Promise<void> {
  void tags;
}
