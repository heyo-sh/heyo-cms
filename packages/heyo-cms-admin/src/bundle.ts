import type { PanelBundle } from "./assets";

/**
 * The built panel, inlined — in `dist`.
 *
 * What is checked in is the empty bundle. `build.ts` replaces this module's
 * contents while it compiles `src/index.ts`, so the published package carries
 * the files and the repository carries none of them: a generated megabyte in
 * `git diff` is a megabyte nobody reviews.
 *
 * `built: false` is therefore the honest state of a source checkout, and the
 * shell says so rather than rendering a blank page.
 */
export const bundle: PanelBundle = {
  id: "heyo-cms-admin@unbuilt",
  entry: { script: "assets/app.js", style: "assets/app.css" },
  files: [],
  built: false,
};
