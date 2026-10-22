/**
 * Bundler alias for optional Node-only features, not used by this template.
 * Workers have neither a native image codec nor the Node AI provider runtime.
 * Use an image CDN and `ai.complete` with a Worker-compatible transport.
 * Remove the relevant alias if you supply a Worker-compatible replacement.
 */
function unavailable(): never {
  throw new Error(
    "This optional Node-only module is disabled in the Cloudflare template. Use an image CDN or configure ai.complete with a Worker-compatible transport.",
  );
}

export default unavailable;
export const complete = unavailable;
export const stream = unavailable;
export const getModel = unavailable;
export const getModels = unavailable;
export const getProviders = unavailable;

export const Database = unavailable;
