/**
 * What the `posts` views are cached under, and what empties it.
 *
 * Three names and one function, in one file, because a cache that works is a
 * cache where the thing that fills it and the thing that empties it agree on
 * a spelling. The views tag what they read; `heyo-cms.config.ts` purges the
 * same tags from a write hook. Nothing in between has to be configured, and
 * there is no webhook to point at yourself.
 *
 * On Next.js the cache is the framework's own, so this file is the same on
 * Vercel and on Cloudflare. The platform difference is where the cache lives
 * — see `open-next.config.ts` in a Cloudflare project — not what invalidates
 * it.
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
 * Empties what a write made wrong.
 *
 * `next/cache` is imported here rather than at the top of the file on
 * purpose: `heyo-cms.config.ts` imports this module, and the CLI
 * (`heyo-cms seed`, `migrate`, `import`) imports that configuration in plain
 * Node, where Next.js is not running and has no business being loaded.
 *
 * Failures are swallowed for the same reason. `revalidateTag` only works
 * inside a request; a write from the CLI has none, and a seed that failed
 * because it could not purge a cache would be a worse answer than a cache
 * that is purged by the next deploy.
 *
 * `"max"` is how long the old copy may still be served while the new one
 * renders behind it. A year sounds reckless and is the opposite: the entry
 * is already marked stale, so the first reader after a save triggers the
 * re-read and nobody waits for it. `{ expire: 0 }` would make that reader
 * wait for a database round trip because somebody else pressed save.
 */
export async function revalidatePosts(tags: readonly string[]): Promise<void> {
  try {
    const { revalidateTag } = await import("next/cache");
    for (const tag of new Set(tags)) revalidateTag(tag, "max");
  } catch {
    // No request scope: the CLI, a script, a test. Nothing to purge here.
  }
}
