/**
 * The admin panel.
 *
 * Built in stage 8 (shadcn + TipTap v3) and served from `/admin/*` of the same
 * handler as the API, so a project never deploys it separately. The package
 * exists now because the plugin contract already refers to it: a plugin
 * declares `admin` extensions in stage 1 and they have to have somewhere to
 * land.
 *
 * Kept private until it does something.
 */

export const adminPanelStage = 8 as const;
