import { addCacheTag, invalidateByTag } from "@vercel/functions";

/**
 * What the `posts` views are cached under, and what empties it — on Vercel.
 *
 * The CDN holds the rendered page and Vercel's purge API empties it by tag,
 * so this deployment gets the same arrangement a Next.js project gets
 * without a framework cache being involved at all: a view declares the tags
 * it read, a write purges them, and the time-to-live is only the floor under
 * a purge that never arrives.
 *
 * Both functions below are no-ops when the code is not running on Vercel —
 * `vercel dev` aside, that means your laptop — because the platform supplies
 * them through the request context. Nothing breaks locally; nothing is
 * cached locally either.
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
 * How long the CDN may answer without asking this function again.
 *
 * An hour is not how fresh the site is — a purge makes an edit visible in
 * seconds. It is the floor under a purge that never arrives: a post written
 * by the CLI on a laptop, or a project on a plan without tag purging.
 * Caching for a year and trusting the purge is how a typo outlives the
 * person who made it.
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
  // Vercel reads tags from the function's context rather than from a
  // response header, so this is a call and not a `headers.set`.
  await addCacheTag([...new Set(tags)]);
}

/**
 * Empties what a write made wrong.
 *
 * `invalidateByTag` marks the content stale rather than deleting it: the
 * next reader is served the old page immediately while the new one renders
 * behind them. For a CMS that is the right trade — nobody waits for a
 * database round trip because somebody else pressed save.
 */
export async function revalidatePosts(tags: readonly string[]): Promise<void> {
  await invalidateByTag([...new Set(tags)]);
}
