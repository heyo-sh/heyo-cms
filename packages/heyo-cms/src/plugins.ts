/**
 * `@heyo-sh/heyo-cms/plugins` — plugins that ship with the package.
 *
 * Built with nothing but the public plugin API (`CmsPlugin`): root routes and
 * post-commit event listeners. A plugin here has no access a third-party one
 * would not have.
 */
export {
  indexNow,
  submitIndexNow,
  type IndexNowFetch,
  type IndexNowContext,
  type IndexNowOptions,
} from "./plugins/indexnow";
