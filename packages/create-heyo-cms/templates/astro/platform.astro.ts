import node from "@astrojs/node";

/** The generic target: a Node server you run yourself. */
export const platformAdapter = node({ mode: "standalone" });

/**
 * Packages the server build must not try to bundle.
 *
 * `pg`, `mongodb` and `sharp` resolve drivers and native bindings at runtime,
 * and `@mariozechner/pi-ai` is an optional peer the CMS imports only when a
 * configuration has an `ai` section. Bundling any of them would replace a
 * runtime decision with a build-time guess — and for the optional peer, would
 * fail the build of a project that correctly does not have it installed.
 */
export const platformVite = {
  ssr: { external: ["pg", "mongodb", "sharp", "@mariozechner/pi-ai"] },
};
