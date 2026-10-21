import vercel from "@astrojs/vercel";

/** Vercel Functions, with the static assets served from the edge. */
export const platformAdapter = vercel();

/**
 * Packages the server build must not try to bundle: they resolve drivers and
 * native bindings at runtime, and the AI peer is only imported when a
 * configuration has an `ai` section.
 */
export const platformVite = {
  ssr: { external: ["pg", "mongodb", "sharp", "@mariozechner/pi-ai"] },
};
