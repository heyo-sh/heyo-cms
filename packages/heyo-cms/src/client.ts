import { heyoCmsClient as createCmsClient } from "./client/index";
import type { CmsClientOptions } from "./client/index";
import type { CmsClient, PluginExtensions } from "./client/types";
import type { CmsInstance } from "./types/instance";
import type { CmsPlugin } from "./types/plugin";

/**
 * `@heyo-sh/heyo-cms/client`.
 *
 * The typed client. Separate from the main entry point because this is the
 * half that ships to a browser: importing it must not pull in the engine, the
 * field registry or a database adapter.
 *
 * A generated project registers its `typeof cms` here through declaration
 * merging. That is a type-only link — the server configuration is never
 * imported into a browser bundle — and lets the ordinary call stay small:
 *
 * ```ts
 * import { heyoCmsClient } from "@heyo-sh/heyo-cms/client";
 *
 * const client = heyoCmsClient();
 * await client.posts.find();
 * ```
 *
 * Registering one CMS is the normal application case. The explicit generic
 * remains the escape hatch for a library or a TypeScript program with more
 * than one CMS:
 *
 * ```ts
 * const client = heyoCmsClient<typeof cms>({ baseUrl: "https://cms.acme.dev/api/heyo-cms" });
 * ```
 */
export interface HeyoCmsClientRegistry {}

type RegisteredCms = HeyoCmsClientRegistry extends { cms: infer TCms }
  ? TCms
  : CmsInstance;

/**
 * Creates the browser client.
 *
 * With no options it calls the same-origin `/api/heyo-cms` mount. A generated
 * `heyo-cms.client.d.ts` supplies the document types; without one, the client
 * remains usable with the broad fallback types.
 */
export function heyoCmsClient<
  TCms = RegisteredCms,
  const TPlugins extends readonly CmsPlugin<unknown>[] = [],
>(
  options: CmsClientOptions<TPlugins> = {},
): CmsClient<TCms> & PluginExtensions<TPlugins> {
  return createCmsClient<TCms, TPlugins>(options);
}

export type { CmsClientOptions } from "./client/index";
export type * from "./client/types";
