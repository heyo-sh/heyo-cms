/**
 * The frozen contracts: every type the engine, the adapters and the plugins
 * agree on. Implementations live elsewhere; this entry point is importable
 * from anywhere, including a Worker that only needs the shapes.
 */
export type * from "./types/index";
export { CmsError, CmsConfigError } from "./errors";
