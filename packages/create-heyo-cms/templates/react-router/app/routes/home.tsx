import { richTextToPlainText } from "@heyo-sh/heyo-cms";
import { Button } from "@heyo-sh/heyo-ui/components/button";
import { data, Link } from "react-router";

import { cachePage, postsTag } from "../../heyo-cms.cache.ts";
import { cms } from "../../heyo-cms.config.ts";

/**
 * The front page, reading the CMS directly.
 *
 * `cms.api` is the same engine the splat route uses — the same access
 * control, the same hooks, the same events — without HTTP or serialisation in
 * between. It is typed from your collections: rename a field in
 * `heyo-cms.config.ts` and this loader stops compiling.
 *
 * `cachePage` is the other half of the write hooks in
 * `heyo-cms.config.ts`: the response may be held by whatever is in front of
 * the server until a post changes, at which point the hook purges `posts`.
 * React Router has no cache of its own, so the caching happens where it
 * actually is — the CDN — and the only thing this loader owes it is the tag.
 */
interface HomeData {
  siteName: string;
  tagline: string;
  posts: { id: string; handle: string; title: string; excerpt: string }[];
}

export async function loader() {
  const settings = await cms.globals.settings.get();
  const { docs } = await cms.api.posts.find({
    where: {
      kind: "compare",
      path: "status",
      operator: "eq",
      value: "published",
    },
    orderBy: [{ path: "created_at", direction: "desc" }],
    limit: 10,
  });

  // Converted on the server: the browser only needs the rendered excerpt,
  // not the CMS runtime (or the full rich-text document).
  const payload: HomeData = {
    siteName: String(settings.siteName ?? ""),
    tagline: String(settings.tagline ?? ""),
    posts: docs.map((post) => ({
      id: String(post.id),
      handle: String(post.handle ?? ""),
      title: String(post.title ?? ""),
      excerpt: String(post.excerpt ?? richTextToPlainText(post.body)).slice(0, 180), // prettier-ignore
    })),
  };

  const headers = new Headers();
  await cachePage(headers, [postsTag]);
  return data(payload, { headers });
}

/** Without this the loader's headers never reach the response. */
export function headers({ loaderHeaders }: { loaderHeaders: Headers }) {
  return loaderHeaders;
}

export default function Home({ loaderData }: { loaderData: HomeData }) {
  const { siteName, tagline, posts } = loaderData;
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
          <h1 id="cms-title">{siteName}</h1>
          <p className="cms-description">
            A starter template powered by Heyo CMS.
          </p>
          {tagline && <p className="cms-tagline">{tagline}</p>}
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
                    <Link to={`/posts/${post.handle}`}>{post.title}</Link>
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
