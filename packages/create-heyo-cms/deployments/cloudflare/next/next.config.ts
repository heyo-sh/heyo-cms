import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "mongodb"],
  turbopack: {
    resolveAlias: {
      sharp: "./heyo-cms.node-only.ts",
      "bun:sqlite": "./heyo-cms.node-only.ts",
      "cloudflare:workers": "./heyo-cms.bindings.ts",
      "@mariozechner/pi-ai": "./heyo-cms.node-only.ts",
      // The assistant's agent runtime, for the same reason: it is an optional
      // peer the bundler would otherwise insist on resolving.
      "@mariozechner/pi-agent-core": "./heyo-cms.node-only.ts",
    },
  },
};

/**
 * Gives `next dev` the real local bindings — the D1 under `.wrangler`, the R2
 * bucket Miniflare emulates — so development talks to the same objects the
 * deployed Worker will.
 */
void initOpenNextCloudflareForDev();

export default nextConfig;
