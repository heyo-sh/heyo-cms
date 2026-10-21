import { richTextToHtml } from "@heyo-sh/heyo-cms";
import { data, Link } from "react-router";

import { cachePage, postTag } from "../../heyo-cms.cache.ts";
import { cms } from "../../heyo-cms.config.ts";

/**
 * One post, cached under its own tag.
 *
 * Per handle rather than per collection: publishing a correction to one post
 * must not throw away every other post page the CDN is holding.
 * `heyo-cms.config.ts` purges `posts:<handle>` and `posts` together, so this
 * page and the front page both empty on a save and nothing else does.
 */
interface PostData {
  title: string;
  html: string;
}

export async function loader({ params }: { params: { handle?: string } }) {
  const handle = params.handle ?? "";
  const post = await cms.api.posts.findOne({
    where: {
      kind: "and",
      conditions: [
        { kind: "compare", path: "handle", operator: "eq", value: handle },
        { kind: "compare", path: "status", operator: "eq", value: "published" },
      ],
    },
  });

  // A draft and a handle nobody has used are the same answer to a reader.
  // The 404 carries no cache headers: it would otherwise outlive the moment
  // somebody presses publish, which is the one case where a reader is
  // watching.
  if (!post) throw data("Not found", { status: 404 });

  const payload: PostData = {
    title: String(post.title ?? ""),
    // Serialised by the CMS rather than by a component tree: the same
    // document renders identically in an RSS feed, an email and here.
    html: richTextToHtml(post.body),
  };

  const headers = new Headers();
  await cachePage(headers, [postTag(handle)]);
  return data(payload, { headers });
}

export function headers({ loaderHeaders }: { loaderHeaders: Headers }) {
  return loaderHeaders;
}

export default function Post({ loaderData }: { loaderData: PostData }) {
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
        <Link to="/">← All posts</Link>
      </p>
      <h1>{loaderData.title}</h1>
      <article dangerouslySetInnerHTML={{ __html: loaderData.html }} />
    </main>
  );
}
