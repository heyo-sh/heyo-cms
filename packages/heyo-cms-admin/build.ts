#!/usr/bin/env bun
/**
 * Builds the panel and inlines it into the package.
 *
 * Three steps, in this order, because each needs the one before it:
 *
 * 1. **The application.** `src/app/main.tsx` and `src/app/styles.css` through
 *    Bun's bundler with the Tailwind plugin, hashed filenames, minified.
 * 2. **The server entry.** `src/index.ts`, with `src/bundle.ts` replaced on
 *    the fly by the files step 1 produced. The checked-in `bundle.ts` holds
 *    nothing; the published one holds the panel. That substitution is why
 *    `git status` stays clean after a build.
 * 3. **The types.** `tsc --emitDeclarationOnly`, so `adminAssets()` is typed
 *    for the configuration file that calls it.
 *
 * The size budget is checked at the end and the build fails over it. A panel
 * that quietly grew a megabyte is a panel somebody's editor waits for on a
 * hotel connection.
 */

import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

import tailwind from "bun-plugin-tailwind";

import type { PanelBundle, PanelBundleFile } from "./src/assets";

/** Raw bytes of the application bundle, gzip ignored. */
const sizeBudget = 2 * 1024 * 1024;

const root = import.meta.dirname;
const dist = join(root, "dist");
const staging = join(dist, ".app");

/*
 * `bun-plugin-tailwind` lowers `light-dark(a, b)` to two adjacent calls:
 *
 *   var(--buncss-light, a)var(--buncss-dark, b)
 *
 * The declarations below make one call yield its fallback and the other yield
 * nothing. Bun normally emits them with that lowering, but the Tailwind
 * plugin loses them for values brought in through heyo-ui's imported
 * `@theme`. Without them, all of those colour properties are invalid and the
 * panel loses its surfaces, ink and rings.
 *
 * This is output-only compatibility code: the application still imports the
 * unmodified heyo-ui theme, and the bridge disappears automatically once the
 * compiler stops producing its `--buncss-*` lowering.
 */
const bunColorModeBridge = `
@layer base {
  :root {
    --buncss-light: initial;
    --buncss-dark: ;
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-mode]) {
      --buncss-light: ;
      --buncss-dark: initial;
    }
  }

  [data-mode="light"] {
    --buncss-light: initial;
    --buncss-dark: ;
  }

  [data-mode="dark"] {
    --buncss-light: ;
    --buncss-dark: initial;
  }
}
`;

await rm(dist, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

// ---------------------------------------------------------------------------
// 1. The application
// ---------------------------------------------------------------------------

const app = await Bun.build({
  // One entry. The stylesheet is reached through `import "./styles.css"`,
  // so Tailwind sees the same module graph the application does and the
  // bundler emits exactly one of each.
  entrypoints: [join(root, "src/app/main.tsx")],
  outdir: staging,
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "none",
  // Hashed, so the handler can answer `immutable` for them and a deploy can
  // never serve last week's JavaScript against this week's CSS. Chunks are
  // named apart from entries so the entry can be identified by its name
  // rather than by guessing.
  naming: {
    entry: "assets/[name]-[hash].[ext]",
    chunk: "assets/chunk-[hash].[ext]",
    asset: "assets/[name]-[hash].[ext]",
  },
  // The emoji table is imported dynamically; without splitting it would be
  // inlined into the entry and the dynamic import would buy nothing.
  splitting: true,
  plugins: [tailwind],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!app.success) {
  for (const log of app.logs) console.error(log);
  throw new Error("The panel application failed to build.");
}

const files: PanelBundleFile[] = [];
let script = "";
let style = "";
let total = 0;

for (const output of app.outputs) {
  const outputPath = output.path
    .slice(staging.length + 1)
    .replaceAll("\\", "/");
  const sourceBytes = new Uint8Array(await output.arrayBuffer());
  const text = isText(outputPath);
  const source = text ? new TextDecoder().decode(sourceBytes) : "";
  const content = text
    ? withBunColorModeBridge(outputPath, source)
    : toBase64(sourceBytes);
  // The ETag and budget describe the bytes we serve, including the bridge.
  const bytes = text ? new TextEncoder().encode(content) : sourceBytes;
  const fingerprint = await digest(bytes);
  // Bun named this file before the bridge existed. Re-fingerprint it from the
  // served bytes, otherwise an immutable old CSS response would share the URL
  // of this fixed one and a browser would quite reasonably keep the old look.
  const path =
    content === source
      ? outputPath
      : fingerprintedPath(outputPath, fingerprint);
  total += bytes.byteLength;

  files.push({
    path,
    content,
    encoding: text ? "utf8" : "base64",
    contentType: contentType(path),
    etag: `"${fingerprint}"`,
  });

  if (/^assets\/main-[^/]+\.js$/.test(path)) script = path;
  if (path.endsWith(".css")) style = path;
}

if (!script || !style) {
  throw new Error(
    `The build produced ${app.outputs.length} files but not both entries (script: ${script || "none"}, style: ${style || "none"}).`,
  );
}

const bundle: PanelBundle = {
  id: `heyo-cms-admin@${await digest(new TextEncoder().encode(files.map((file) => file.etag).join("")))}`,
  entry: { script, style },
  files: files.sort((left, right) => left.path.localeCompare(right.path)),
  built: true,
};

// ---------------------------------------------------------------------------
// 2. The server entry, with the bundle substituted in
// ---------------------------------------------------------------------------

const server = await Bun.build({
  entrypoints: [join(root, "src/index.ts")],
  outdir: dist,
  target: "node",
  format: "esm",
  // Readable on purpose: this file is one data literal and a hundred lines of
  // logic, and a reader checking what the panel serves should be able to.
  minify: false,
  plugins: [
    {
      name: "heyo-cms-panel-bundle",
      setup(build) {
        build.onLoad({ filter: /src[\\/]bundle\.ts$/ }, () => ({
          contents: `export const bundle = ${JSON.stringify(bundle)};\n`,
          loader: "ts",
        }));
      },
    },
  ],
});

if (!server.success) {
  for (const log of server.logs) console.error(log);
  throw new Error("The server entry failed to build.");
}

await rm(staging, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 3. The types
// ---------------------------------------------------------------------------

const types = Bun.spawnSync({
  cmd: ["bunx", "tsc", "-p", "tsconfig.build.json"],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (types.exitCode !== 0) throw new Error("Type declarations failed to emit.");

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

const printable = `${(total / 1024).toFixed(0)} KiB`;
if (total > sizeBudget) {
  throw new Error(
    `The panel is ${printable}, over the ${(sizeBudget / 1024).toFixed(0)} KiB budget. Either the dependency is worth the wait or it is not; decide on purpose.`,
  );
}

console.log(`  panel ${bundle.id}`);
for (const file of bundle.files) console.log(`    ${file.path}`);
console.log(`  ${printable} of ${(sizeBudget / 1024).toFixed(0)} KiB budget`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withBunColorModeBridge(path: string, css: string): string {
  if (!path.endsWith(".css") || !css.includes("var(--buncss-light,")) {
    return css;
  }
  return `${css}\n${bunColorModeBridge}`;
}

function fingerprintedPath(path: string, fingerprint: string): string {
  const extension = path.lastIndexOf(".");
  const beforeExtension = extension === -1 ? path : path.slice(0, extension);
  const suffix = extension === -1 ? "" : path.slice(extension);
  const separator = beforeExtension.lastIndexOf("-");
  const stem =
    separator === -1 ? beforeExtension : beforeExtension.slice(0, separator);
  return `${stem}-${fingerprint}${suffix}`;
}

function isText(path: string): boolean {
  return /\.(js|mjs|css|html|json|svg|map|txt)$/.test(path);
}

function contentType(path: string): string {
  const extension = path.split(".").at(-1) ?? "";
  const types: Record<string, string> = {
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    html: "text/html; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    map: "application/json; charset=utf-8",
    woff2: "font/woff2",
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp",
    ico: "image/x-icon",
  };
  return types[extension] ?? "application/octet-stream";
}

async function digest(bytes: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(buffer)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
