import { richTextToHtml } from "@heyo-sh/heyo-cms";
import { unstable_cache } from "next/cache";
import Link from "next/link";
import { notFound } from "next/navigation";

import { postTag } from "../../../heyo-cms.cache.ts";
import { cms } from "../../../heyo-cms.config.ts";

/**
 * One post, cached under its own tag.
 *
 * Per handle rather than per collection: publishing a correction to one post
 * must not throw away every other post page a CDN or a data cache is holding.
 * `heyo-cms.config.ts` purges `posts:<handle>` and `posts` together, so this
 * page and the list both empty on a save and nothing else does.
 */
interface Post {
  title: string;
  html: string;
}

async function findPost(handle: string): Promise<Post | null> {
  const post = await cms.api.posts.findOne({
    where: {
      kind: "and",
      conditions: [
        { kind: "compare", path: "handle", operator: "eq", value: handle },
        { kind: "compare", path: "status", operator: "eq", value: "published" }, // prettier-ignore
      ],
    },
  });
  if (!post) return null;
  return {
    title: post.title,
    // Rendered inside the cache entry: the HTML is the expensive part and it
    // changes exactly when the document does.
    html: richTextToHtml(post.body),
  };
}

async function readPost(handle: string): Promise<Post | null> {
  const cached = await unstable_cache(
    () => findPost(handle),
    ["posts", "one", handle],
    { tags: [postTag(handle)], revalidate: 3600 },
  )();
  // A cached "there is no such post" is re-checked rather than believed.
  // Purging marks an entry stale and serves it once more while the new value
  // renders, which is the right trade for a page that exists — and the wrong
  // one for a page that has just started existing: the first person to follow
  // the link an editor shared the second after publishing would get the 404.
  // A miss is rare and a lookup by an indexed handle is cheap.
  return cached ?? findPost(handle);
}

export default async function PostPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const post = await readPost(handle);
  // A draft and a handle nobody has used are the same answer to a reader:
  // the access rule publishes `status: "published"` and nothing else.
  if (!post) notFound();

  return (
    <main
      style={{
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        margin: "0 auto",
        maxWidth: "42rem",
        padding: "4rem 1.5rem",
        lineHeight: 1.6,
      }}
    >
      <p style={{ color: "#666" }}>
        <Link href="/">← All posts</Link>
      </p>
      <h1>{post.title}</h1>
      {/* The editor's rich text, serialised by the CMS rather than by a
          component tree: the same document renders identically in an RSS
          feed, an email and here. */}
      <article dangerouslySetInnerHTML={{ __html: post.html }} />
    </main>
  );
}

/** Dynamic for the same reason the front page is: no database at build time. */
export const dynamic = "force-dynamic";
