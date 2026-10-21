import { richTextToPlainText } from "@heyo-sh/heyo-cms";
import { Button } from "@heyo-sh/heyo-ui/components/button";
import { unstable_cache } from "next/cache";
import Link from "next/link";

import { postsTag } from "../heyo-cms.cache.ts";
import { cms } from "../heyo-cms.config.ts";

/**
 * The published posts, read once and kept until a post changes.
 *
 * `cms.api` is the same engine the REST route uses — the same access
 * control, the same hooks, the same events — without HTTP or serialisation
 * in between, and it is typed from the collection: rename a field in
 * `heyo-cms.config.ts` and this file stops compiling.
 *
 * The cache is the framework's, keyed by the function and emptied by
 * `postsTag`. The write hooks in `heyo-cms.config.ts` purge that tag, so the
 * list is stale for exactly as long as it takes to save, rather than until
 * `revalidate` runs out. The hour is only the floor under a purge that never
 * arrives — a deployment where the CLI, not the panel, did the writing.
 */
const readPublishedPosts = unstable_cache(
  async () => {
    const { docs } = await cms.api.posts.find({
      where: { kind: "compare", path: "status", operator: "eq", value: "published" }, // prettier-ignore
      orderBy: [{ path: "created_at", direction: "desc" }],
      limit: 10,
    });
    // Serialised here rather than in the component: what is cached should be
    // what is rendered, not a rich-text document that has to be walked again
    // on every hit.
    return docs.map((post) => ({
      id: post.id,
      handle: post.handle,
      title: post.title,
      excerpt: post.excerpt ?? richTextToPlainText(post.body).slice(0, 180),
    }));
  },
  ["posts", "published"],
  { tags: [postsTag], revalidate: 3600 },
);

export default async function Home() {
  // Not cached: the page has to render for the settings anyway, and a
  // singleton that is wrong is a different bug from a list that is stale.
  const settings = await cms.globals.settings.get();
  const posts = await readPublishedPosts();

  return (
    <main className="cms-home">
      <div className="cms-home-shell">
        <header className="cms-home-header">
          <button
            className="cms-theme-toggle"
            type="button"
            data-theme-toggle
            aria-label="Switch color theme"
            title="Switch color theme"
          >
            <svg className="cms-moon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5 8.5 8.5 0 1 0 20.5 14.1Z" />
            </svg>
            <svg className="cms-sun" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          </button>
        </header>

        <section className="cms-hero" aria-labelledby="cms-title">
          <img
            className="cms-mark"
            src="/logo.svg"
            alt=""
            width="39"
            height="39"
          />
          <h1 id="cms-title">{settings.siteName}</h1>
          <p className="cms-description">
            A starter template powered by Heyo CMS.
          </p>
          {settings.tagline && (
            <p className="cms-tagline">{settings.tagline}</p>
          )}
          <div className="cms-actions">
            <Button
              render={<a href="/api/heyo-cms/admin" />}
              variant="primary"
              size="lg"
            >
              Admin Panel
            </Button>
          </div>
        </section>

        <footer className="cms-home-footer">
          {posts.length === 0 ? (
            <>
              Nothing published yet. Run <code>heyo-cms seed</code> or create a
              post in the <a href="/api/heyo-cms/admin">panel</a>.
            </>
          ) : (
            <>Scroll to see published posts</>
          )}
        </footer>
      </div>

      {posts.length > 0 && (
        <section className="cms-posts" aria-labelledby="cms-posts-title">
          <h2 id="cms-posts-title">Latest posts</h2>
          <ul>
            {posts.map((post) => (
              <li key={post.id}>
                <h3>
                  {post.handle ? (
                    <Link href={`/posts/${post.handle}`}>{post.title}</Link>
                  ) : (
                    post.title
                  )}
                </h3>
                <p>{post.excerpt}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/**
 * The page renders per request; the query above does not run per request.
 *
 * Prerendering this at build time would mean reading the database during
 * `next build`, which a deployment pipeline does not owe you — the branch
 * that builds a preview may have no connection string at all. So the shell
 * is dynamic and the expensive half is cached and tagged, which is the same
 * win without the requirement.
 */
export const dynamic = "force-dynamic";
