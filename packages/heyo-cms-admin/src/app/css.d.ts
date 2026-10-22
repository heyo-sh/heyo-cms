/**
 * `import "./styles.css"` is a bundler instruction, not a module.
 *
 * Bun resolves it to the emitted stylesheet; TypeScript needs to be told it
 * exists at all, and that it exports nothing worth importing.
 */
declare module "*.css";
