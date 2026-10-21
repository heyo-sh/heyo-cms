import { cloudflare } from "@cloudflare/vite-plugin";
import type { PluginOption, SSROptions } from "vite";

/**
 * Cloudflare Workers, in development as well as in production.
 *
 * The plugin runs the dev server inside workerd with the bindings from
 * `wrangler.json`, so the local D1 is the same object the deployed Worker
 * gets — no second code path, no mock.
 */
export const platformPlugins: PluginOption[] = [
  {
    name: "heyo-worker-optional-modules",
    config: () => ({
      resolve: {
        alias: {
          sharp: new URL("./heyo-cms.node-only.ts", import.meta.url).pathname,
          "@mariozechner/pi-ai": new URL(
            "./heyo-cms.node-only.ts",
            import.meta.url,
          ).pathname,
        },
      },
    }),
  },
  cloudflare({ viteEnvironment: { name: "ssr" } }),
];

/**
 * Nothing is external here, and the plugin refuses it if you try: a Worker
 * has no `node_modules` to require from at runtime. The Node-only drivers are
 * never reached, because this deployment talks to D1 through its binding.
 */
export const platformSsr: SSROptions = {};
