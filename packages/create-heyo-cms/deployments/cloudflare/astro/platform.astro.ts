import cloudflare from "@astrojs/cloudflare";

/**
 * Cloudflare Workers, in development as well as in production.
 *
 * The adapter runs `astro dev` inside workerd with the bindings from
 * `wrangler.json`, so `cloudflare:workers` resolves there too and the
 * database and storage modules find the local D1 and R2 without a second
 * code path. (`Astro.locals.runtime.env` is gone as of Astro 7; that import
 * is the replacement.)
 */
export const platformAdapter = cloudflare();

/**
 * Nothing is external in a Worker: there is no `node_modules` to require from
 * at runtime. None of the Node-only drivers is reachable here anyway — this
 * deployment talks to D1 through its binding.
 */
export const platformVite = {
  resolve: {
    alias: {
      sharp: new URL("./heyo-cms.node-only.ts", import.meta.url).pathname,
      "@mariozechner/pi-ai": new URL("./heyo-cms.node-only.ts", import.meta.url)
        .pathname,
    },
  },
};
