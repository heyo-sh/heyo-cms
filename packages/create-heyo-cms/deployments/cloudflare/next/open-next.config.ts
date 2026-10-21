import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";
import doShardedTagCache from "@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache";

/**
 * Where Next.js keeps its cache on Workers, and what can empty it.
 *
 * Without these three lines `revalidateTag` is a function that returns
 * successfully and does nothing: on Cloudflare there is no default cache
 * behind `unstable_cache`, so the views in `app/` would read the database on
 * every request and the write hooks in `heyo-cms.config.ts` would purge a
 * cache that was never there.
 *
 * - **KV holds the entries.** Eventually consistent, which is the right
 *   trade for a document that is already a copy: a reader in Frankfurt
 *   sees a new post a moment after a reader in Ohio does.
 * - **A Durable Object holds the tags.** Strongly consistent, which is the
 *   half that cannot be eventual — "has `posts:hello-world` been purged?"
 *   has to be answered correctly or a purge is a suggestion. It needs no id
 *   to paste: the binding in `wrangler.json` names a class, and the
 *   generated Worker exports it.
 * - **`direct` revalidates inline** rather than through a queue, because a
 *   CMS purges a handful of tags when somebody presses save, not a wave of
 *   them on a deploy.
 *
 * See DEPLOYMENT.md for the one namespace this needs created.
 */
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  tagCache: doShardedTagCache({ baseShardSize: 4 }),
  queue: "direct",
});
