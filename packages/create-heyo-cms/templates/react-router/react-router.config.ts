import type { Config } from "@react-router/dev/config";

/**
 * Server rendering, because the CMS answers requests.
 *
 * Nothing is prerendered: a page that showed yesterday's content would make
 * the panel look broken.
 */
export default { ssr: true } satisfies Config;
