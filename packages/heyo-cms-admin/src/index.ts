import type { AdminAssets } from "@heyo-sh/heyo-cms/types";

import { createAdminAssets, type AdminAssetsOptions } from "./assets";
import { bundle } from "./bundle";

/**
 * `@heyo-sh/heyo-cms-admin`: the panel.
 *
 * ```ts
 * import { adminAssets } from "@heyo-sh/heyo-cms-admin";
 *
 * heyoCms({
 *   admin: { path: "/admin", assets: adminAssets() },
 *   // …
 * });
 * ```
 *
 * One function, because there is one decision to make: whether the panel is
 * installed. Everything else it needs — the collections, the fields, the
 * languages, what the caller may press — it asks the API for at runtime
 * through `GET /panel`, so the bundle is the same bytes in every deployment
 * and a field added to a collection is visible on the next page load rather
 * than after a rebuild.
 *
 * The package has no runtime dependencies. React, TipTap and the rest are
 * compiled into the bundle, which is the only honest way to ship a panel that
 * has to run inside a Worker.
 */
export function adminAssets(options: AdminAssetsOptions = {}): AdminAssets {
  return createAdminAssets(bundle, options);
}

export { createAdminAssets } from "./assets";
export type {
  AdminAssetsOptions,
  PanelBundle,
  PanelBundleFile,
} from "./assets";
