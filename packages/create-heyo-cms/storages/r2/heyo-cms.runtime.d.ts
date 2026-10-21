// Only the structural runtime boundary used by the database/storage modules.
// No Workers or Bun SDK is needed to type-check a project running on Node.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}

declare module "bun:sqlite" {
  export const Database: new (path: string) => unknown;
}
