import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the Node CMS runtime external as well as its drivers: otherwise
  // Turbopack resolves optional peers even when no feature uses them. The
  // Cloudflare overlay instead bundles the runtime and aliases Node features.
  serverExternalPackages: [
    "@heyo-sh/heyo-cms",
    "@heyo-sh/heyo-cms-admin",
    "pg",
    "mongodb",
    "sharp",
    "@mariozechner/pi-ai",
  ],
};

export default nextConfig;
