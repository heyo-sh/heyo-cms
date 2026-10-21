import type { Config } from "@react-router/dev/config";

/**
 * Server rendering inside workerd, in development as well as in production.
 *
 * `v8_viteEnvironmentApi` is not optional here. Without it React Router
 * pre-bundles its server dependencies for a Node environment, and the Worker
 * then evaluates a module that expects CommonJS — which fails at the first
 * request with `module is not defined`. With it, the Cloudflare plugin owns
 * the `ssr` environment and the same code runs in dev and on the edge.
 */
export default {
  ssr: true,
  future: { v8_viteEnvironmentApi: true },
} satisfies Config;
