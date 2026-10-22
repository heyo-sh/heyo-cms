import { getCloudflareContext } from "@opennextjs/cloudflare";

// OpenNext owns the Worker entry; access its request-scoped bindings rather
// than requiring cloudflare:workers from a Next.js server chunk.
export const env = getCloudflareContext().env;
