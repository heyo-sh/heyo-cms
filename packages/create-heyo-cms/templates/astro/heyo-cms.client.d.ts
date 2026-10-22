import type { cms } from "./heyo-cms.config.ts";

/**
 * Generated once by create-heyo-cms.
 *
 * This connects the browser client's types to the server CMS configuration
 * without importing that configuration into the browser bundle.
 */
declare module "@heyo-sh/heyo-cms/client" {
  interface HeyoCmsClientRegistry {
    cms: typeof cms;
  }
}
