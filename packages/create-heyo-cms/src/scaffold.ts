import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"; // prettier-ignore
import { join, resolve } from "node:path";

import {
  packageManagerExecCommand,
  packageManagerField,
  packageManagerInstallCommand,
  packageManagerRunCommand,
} from "./package-manager";
import { assertProjectName } from "./project-name";
import type { CreateOptions, Database, Deployment, Storage } from "./types";
import {
  copyTemplate,
  mergePackageJson,
  readJson,
  replacePlaceholders as replace,
  writeJson,
} from "./utils";

const packageRoot = resolve(import.meta.dirname, "..");

/** Files a later layer adds to rather than replaces. */
const mergedFiles = ["package.json", "wrangler.json"];

/**
 * The configuration is one file, and this is how the layers get into it.
 *
 * A generated project has exactly one `heyo-cms.config.ts`: the database, the
 * bucket and the image processor live in it alongside the collections, not in
 * three sibling modules it imports. That is not tidiness — it is the claim
 * the product makes ("one file, and the only one that describes your CMS"),
 * and a reader who opens the config and finds `import { database } from
 * "./heyo-cms.database"` has been told something false on line six.
 *
 * So each layer ships fragments instead of modules: `config.imports.fragment`
 * (import lines, concatenated in layer order) and one of
 * `config.database` / `config.storage` / `config.images` (a declaration
 * block). They are `.fragment` rather than `.ts` because none of them is a
 * valid module on its own — which is the honest way to say "this is a piece
 * of a file" to a type checker, a formatter and a reader alike.
 */
const configFile = "heyo-cms.config.ts";

const configSlots = {
  "config.database.fragment": "DATABASE_CONFIG",
  "config.storage.fragment": "STORAGE_CONFIG",
  "config.images.fragment": "IMAGES_CONFIG",
} as const;

const importsFragment = "config.imports.fragment";

/**
 * Files that belong to one platform.
 *
 * The D1 and R2 layers carry a binding each, and a binding is a sentence in
 * `wrangler.json`. On Vercel that file would be a puzzle — so it is dropped,
 * along with the layer's claim on it, rather than written and explained.
 */
const cloudflareOnly = new Set(["wrangler.json"]);

export const D1_NEEDS_CLOUDFLARE_MESSAGE =
  "D1 is a Cloudflare database and only exists on Cloudflare. Choose Postgres or MongoDB for Vercel, or deploy to Cloudflare.";

/**
 * Combinations the generator refuses, with the reason.
 *
 * D1 requires Workers; local filesystem storage cannot persist in Workers.
 * The six smoke-tested variants use Postgres/local on Vercel in development
 * and D1/R2 on Cloudflare. Other generated database/storage choices require
 * their own credentials and deployment validation.
 */
export function assertSupportedProjectOptions(options: {
  deployment: Deployment;
  database: Database;
  storage?: Storage;
}): void {
  if (options.deployment === "cloudflare" && options.storage === "local") {
    throw new Error(
      "Local filesystem storage is unavailable on Cloudflare Workers. Choose R2 or S3.",
    );
  }
  if (options.database === "d1" && options.deployment !== "cloudflare") {
    throw new Error(D1_NEEDS_CLOUDFLARE_MESSAGE);
  }
}

/**
 * Writes the project.
 *
 * Four layers, each one a directory in this package and each one applied in
 * full: the template (a framework and the single file that mounts the CMS),
 * the deployment (a platform's configuration and its cron), the database and
 * the storage (fragments assembled into the configuration, plus the migrations
 * that come with a database).
 *
 * The layering is what makes this package small. In `create-heyo-docs` a
 * deployment overlay has to patch every endpoint file, because every endpoint
 * is a file; here the endpoints are one catch-all route. An overlay changes
 * the platform configuration and, where needed, binding injection at that mount.
 */
export async function scaffoldProject(
  options: CreateOptions,
): Promise<{ projectPath: string }> {
  const cwd = options.cwd ?? process.cwd();
  const projectName = assertProjectName(options.projectName);
  assertSupportedProjectOptions(options);

  const projectPath = resolve(cwd, projectName);
  if (existsSync(projectPath)) {
    throw new Error(`Directory already exists: ${projectPath}`);
  }

  const placeholders = {
    PROJECT_NAME: projectName,
    HEYO_CMS_VERSION: options.heyoCmsVersion ?? "latest",
    PACKAGE_MANAGER: packageManagerField(options.packageManager),
    // Documentation that is wrong for the reader's package manager is
    // documentation they have to translate, so the README is written in
    // theirs.
    PACKAGE_MANAGER_RUN: packageManagerRunCommand(options.packageManager, "").trim(), // prettier-ignore
    PACKAGE_MANAGER_EXEC: packageManagerExecCommand(options.packageManager, "").trim(), // prettier-ignore
    DATABASE: options.database,
    DEPLOYMENT: options.deployment,
    STORAGE: options.storage,
  };

  const layers = [
    join(packageRoot, "templates", options.template),
    join(packageRoot, "deployments", options.deployment, options.template),
    join(packageRoot, "databases", options.database),
    join(packageRoot, "storages", options.storage),
  ];

  // The name is one directory segment; an atomic mkdir also refuses a path
  // created between the earlier existence check and this write.
  await mkdir(projectPath);

  // `package.json` and `wrangler.json` are merged rather than overwritten: a
  // deployment adds a script without restating the framework's, and the D1
  // layer adds a binding without knowing what else is in the Worker's
  // configuration. Every other file belongs to the last layer that wrote it,
  // which is the point of a database layer contributing only its own concern.
  const merged = new Map<string, Record<string, unknown>>();
  const fragments: string[] = [];
  const configImports: string[] = [];
  const configBlocks = new Map<string, string>();

  const skip = (name: string): boolean =>
    options.deployment !== "cloudflare" && cloudflareOnly.has(name);

  for (const layer of layers) {
    if (!existsSync(layer)) continue;
    for (const name of mergedFiles) {
      if (skip(name) || !existsSync(join(layer, name))) continue;
      const overlay = await readJson<Record<string, unknown>>(
        join(layer, name),
      );
      const base = merged.get(name);
      merged.set(name, base ? mergePackageJson(base, overlay) : overlay);
    }
    const fragment = join(layer, "env.fragment");
    if (existsSync(fragment)) fragments.push(await readFile(fragment, "utf8"));

    const imports = join(layer, importsFragment);
    if (existsSync(imports)) {
      configImports.push((await readFile(imports, "utf8")).trim());
    }
    for (const [name, slot] of Object.entries(configSlots)) {
      const path = join(layer, name);
      if (!existsSync(path)) continue;
      configBlocks.set(slot, (await readFile(path, "utf8")).trim());
    }

    await copyLayer(layer, projectPath, placeholders, skip);
  }

  await assembleConfig(projectPath, configImports, configBlocks, placeholders);

  for (const [name, contents] of merged) {
    await writeJson(
      join(projectPath, name),
      JSON.parse(replace(JSON.stringify(contents), placeholders)) as unknown,
    );
  }

  // One `.env.example`, assembled from the layers that need a variable. A
  // single checked-in file would list secrets for databases this project does
  // not use, which is how a reader ends up setting the wrong one.
  await writeFile(
    join(projectPath, ".env.example"),
    `${fragments.map((fragment) => replace(fragment, placeholders).trim()).join("\n\n")}\n`,
  );

  // npm refuses to publish a file called `.gitignore`, and every generator
  // hits this: it ships as `gitignore` and is renamed on the way out.
  const shipped = join(projectPath, "gitignore");
  if (existsSync(shipped)) {
    await rename(shipped, join(projectPath, ".gitignore"));
  }
  if (options.packageManager === "yarn") {
    await writeFile(
      join(projectPath, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );
  }

  if (options.install) {
    await installDependencies(projectPath, options.packageManager);
  }
  return { projectPath };
}

/**
 * Writes the one configuration file, with the layers' pieces in it.
 *
 * The template carries the content — the collections, the globals, the roles
 * — and four placeholders: the imports the layers need, and one block each
 * for the database, the bucket and the image processor. Substituting them
 * here rather than importing three modules is what keeps a generated project
 * at one configuration file whatever it was generated with.
 */
async function assembleConfig(
  projectPath: string,
  imports: string[],
  blocks: Map<string, string>,
  placeholders: Record<string, string>,
): Promise<void> {
  const path = join(projectPath, configFile);
  if (!existsSync(path)) return;

  const source = await readFile(path, "utf8");
  const values: Record<string, string> = {
    ...placeholders,
    CONFIG_IMPORTS: mergeImports(imports),
  };
  for (const slot of Object.values(configSlots)) {
    values[slot] = blocks.get(slot) ?? "";
  }

  // A slot a layer did not fill would leave `{{DATABASE_CONFIG}}` in the file
  // the reader is told to open first, so the generator refuses instead.
  const written = replace(source, values);
  const unfilled = /\{\{([A-Z0-9_]+)\}\}/.exec(written);
  if (unfilled) {
    throw new Error(
      `heyo-cms.config.ts still has an unfilled ${unfilled[0]} placeholder; a layer is missing its fragment.`,
    );
  }

  await writeFile(path, written);
}

/**
 * Three layers' import lines, as few statements as they can honestly be.
 *
 * Every layer needs something from `@heyo-sh/heyo-cms/types`, and three
 * consecutive imports of the same module is the sort of thing a reader
 * assumes is a mistake in the tool that wrote it. Merged per module, with
 * type-only imports kept apart from value imports because they are not the
 * same statement — one is erased at build time and the other is not.
 */
function mergeImports(lines: string[]): string {
  const simple = /^import (type )?\{([^}]+)\} from "([^"]+)";$/;
  const groups = new Map<string, { typeOnly: boolean; module: string; names: string[] }>(); // prettier-ignore
  const verbatim: string[] = [];

  for (const line of lines.flatMap((entry) => entry.split("\n"))) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const match = simple.exec(trimmed);
    if (!match) {
      verbatim.push(trimmed);
      continue;
    }

    const typeOnly = match[1] !== undefined;
    const module = match[3] as string;
    const key = `${typeOnly ? "type " : ""}${module}`;
    const group = groups.get(key) ?? { typeOnly, module, names: [] };
    for (const name of (match[2] as string).split(",")) {
      const trimmedName = name.trim();
      if (trimmedName !== "" && !group.names.includes(trimmedName)) {
        group.names.push(trimmedName);
      }
    }
    groups.set(key, group);
  }

  const merged = [...groups.values()].map(
    (group) =>
      `import ${group.typeOnly ? "type " : ""}{ ${group.names.join(", ")} } from "${group.module}";`,
  );
  return [...verbatim, ...merged].join("\n");
}

/**
 * Copies one layer, minus its `package.json` and its fragments.
 *
 * The manifest is merged separately — a later layer must add to the earlier
 * one rather than overwrite it — and `*.fragment` files are pieces of other
 * files rather than files (`env.fragment` becomes `.env.example`, the
 * `config.*` ones become parts of `heyo-cms.config.ts`). Everything else is
 * copied as it is, including files that replace one the template already
 * wrote.
 */
async function copyLayer(
  source: string,
  destination: string,
  placeholders: Record<string, string>,
  skip: (name: string) => boolean,
): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          !mergedFiles.includes(entry.name) &&
          !entry.name.endsWith(".fragment") &&
          !skip(entry.name),
      )
      .map((entry) =>
        copyTemplate(
          join(source, entry.name),
          join(destination, entry.name),
          placeholders,
        ),
      ),
  );
}

async function installDependencies(
  projectPath: string,
  packageManager: CreateOptions["packageManager"],
): Promise<void> {
  const command = packageManagerInstallCommand(packageManager);
  const [executable, ...rest] = command as [string, ...string[]];
  await new Promise<void>((resolveInstall, rejectInstall) => {
    const child = spawn(executable, rest, {
      cwd: projectPath,
      stdio: "inherit",
    });
    child.once("error", rejectInstall);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolveInstall();
        return;
      }
      rejectInstall(
        new Error(`Dependency installation failed with ${command.join(" ")}.`),
      );
    });
  });
}
