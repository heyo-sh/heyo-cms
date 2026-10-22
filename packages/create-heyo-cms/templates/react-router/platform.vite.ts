import type { PluginOption, SSROptions } from "vite";

/** The generic target: no platform plugin, a Node server you run yourself. */
export const platformPlugins: PluginOption[] = [];

/**
 * `pg`, `mongodb` and `sharp` resolve drivers and native bindings at runtime,
 * so a Node server requires them rather than bundling them. A Worker cannot —
 * and must not — do either, which is why this lives next to the plugin that
 * knows which runtime this is.
 */
export const platformSsr: SSROptions = {
  external: ["pg", "mongodb", "sharp", "@mariozechner/pi-ai"],
};
