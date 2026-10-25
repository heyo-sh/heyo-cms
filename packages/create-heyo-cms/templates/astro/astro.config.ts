import { existsSync } from "node:fs";

import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

import { platformAdapter, platformVite } from "./platform.astro.ts";

/**
 * `.env` into `process.env`, where `heyo-cms.config.ts` reads its connection
 * strings. Astro hands `.env` to `import.meta.env` only, so without this
 * `astro dev` never sees `DATABASE_URL`. Same files and order as the
 * `heyo-cms` CLI: what the shell set wins, then `.env`, then `.env.local`.
 */
for (const file of [".env", ".env.local"]) {
  const path = new URL(file, import.meta.url);
  if (existsSync(path)) process.loadEnvFile(path);
}

/**
 * Server output, because the CMS answers requests.
 *
 * `platform.astro.ts` is the one file a deployment replaces: Node here,
 * Vercel or Cloudflare when the generator was asked for one of those.
 */
export default defineConfig({
  adapter: platformAdapter,
  output: "server",
  integrations: [react()],
  vite: { ...platformVite, plugins: [tailwindcss()] },
  security: {
    /**
     * Astro refuses any form-encoded POST whose `origin` does not match,
     * which also refuses every API client that is not a browser — `curl -F
     * file=@photo.jpg` sends no origin at all, so uploads would be
     * browser-only.
     *
     * CMS sessions use SameSite=Lax, which blocks cross-site POST cookies,
     * and API clients can use bearer tokens. SameSite does not protect
     * against untrusted same-site sibling origins: deploy on a trusted site
     * and add explicit origin checks if the application needs that boundary.
     *
     * Turn it back on if this project grows its own cookie-authenticated
     * form endpoints.
     */
    checkOrigin: false,
  },
});
