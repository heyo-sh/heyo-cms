#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as p from "@clack/prompts";

import {
  detectPackageManager,
  packageManagerExecCommand,
  packageManagerRunCommand,
} from "./package-manager";
import { projectNameError } from "./project-name";
import { reportCreation, telemetryEnabled } from "./telemetry";
import { D1_NEEDS_CLOUDFLARE_MESSAGE, scaffoldProject } from "./scaffold";
import {
  databases,
  deployments,
  packageManagers,
  storages,
  templates,
  type CreateOptions,
  type Database,
  type Deployment,
  type PackageManager,
  type Storage,
  type Template,
} from "./types";

export { assertSupportedProjectOptions, scaffoldProject } from "./scaffold";
export {
  detectPackageManager,
  packageManagerField,
  packageManagerRunCommand,
} from "./package-manager";
export { mergePackageJson, replacePlaceholders } from "./utils";
export type * from "./types";

const USAGE = `Usage: create-heyo-cms [project-name]
  --template <next|astro|react-router>
  --deployment <vercel|cloudflare>
  --database <postgres|mongodb|d1>
  --storage <local|s3|r2>
  --package-manager <bun|pnpm|npm|yarn>
  --no-install`;

const TEMPLATE_OPTIONS = [
  { value: "next", label: "Next.js" },
  { value: "astro", label: "Astro" },
  { value: "react-router", label: "React Router" },
];
const DEPLOYMENT_OPTIONS = [
  { value: "vercel", label: "Vercel" },
  { value: "cloudflare", label: "Cloudflare Workers" },
];
const DATABASE_OPTIONS = [
  { value: "postgres", label: "Postgres", hint: "Neon, Supabase, RDS, your own" }, // prettier-ignore
  { value: "mongodb", label: "MongoDB", hint: "Atlas or your own" },
  { value: "d1", label: "D1", hint: "Cloudflare only" },
];
const STORAGE_OPTIONS = [
  { value: "local", label: "Local filesystem", hint: "development only" },
  { value: "s3", label: "S3", hint: "or anything that speaks it" },
  { value: "r2", label: "Cloudflare R2" },
];
const PACKAGE_MANAGER_OPTIONS = [
  { value: "bun", label: "bun" },
  { value: "pnpm", label: "pnpm" },
  { value: "npm", label: "npm" },
  { value: "yarn", label: "yarn" },
];

if (isMainModule()) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) return false;
  try {
    return realpathSync(entryPoint) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(argv);
  if (parsed.showHelp) {
    p.note(USAGE, "@heyo-sh/create-heyo-cms");
    return;
  }

  const options = parsed.interactive
    ? await askQuestions(parsed.options)
    : parsed.options;

  const spinner = p.spinner();
  spinner.start("Creating your Heyo CMS project");
  try {
    await scaffoldProject(options);
  } catch (error) {
    spinner.stop("Unable to create the project");
    throw error;
  }
  spinner.stop("Your CMS is ready");

  if (telemetryEnabled()) {
    p.log.info(
      "Anonymous generator choices are reported (never the project name). Opt out: HEYO_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1.",
    );
  }
  await reportCreation(options);
  p.note(nextSteps(options), "Next steps");
  p.outro("Happy editing.");
}

/**
 * What to type next, in the order it has to be typed.
 *
 * Spelled out rather than linked to, because the commands after `install` are
 * the ones nobody can guess: a migration has to be applied before the first
 * request, and the seed is what makes the first page not empty. The
 * administrator is no longer among them — the panel asks for it on first
 * open, which is one less command between a generated project and a screen
 * somebody can type into.
 */
export function nextSteps(options: CreateOptions): string {
  const run = (script: string): string =>
    packageManagerRunCommand(options.packageManager, script);
  const lines = [`cd ${options.projectName}`];
  if (!options.install) lines.push(`${options.packageManager} install`);

  lines.push(
    options.database === "d1"
      ? `${run("db:migrate")}            # applies the migration to local D1`
      : `cp .env.example .env       # then set ${options.database === "mongodb" ? "MONGODB_URL" : "DATABASE_URL"}`,
  );
  if (options.database !== "d1") lines.push(run("db:migrate"));
  lines.push(run("seed"), run("dev"));
  return lines.join("\n");
}

export function parseArguments(argv: string[]): {
  options: CreateOptions;
  interactive: boolean;
  showHelp: boolean;
} {
  const detected = detectPackageManager();
  const options: CreateOptions = {
    projectName: "",
    template: "next",
    deployment: "vercel",
    database: "postgres",
    storage: "local",
    packageManager: detected.name,
    install: true,
  };
  let explicit = false;
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] as string;
    if (!value.startsWith("-")) {
      options.projectName ||= value;
      continue;
    }
    explicit = true;
    if (value === "--template") {
      options.template = readEnum(argv[++index], templates, "template");
    } else if (value === "--deployment") {
      options.deployment = readEnum(argv[++index], deployments, "deployment");
    } else if (value === "--database") {
      options.database = readEnum(argv[++index], databases, "database");
    } else if (value === "--storage") {
      options.storage = readEnum(argv[++index], storages, "storage");
    } else if (value === "--package-manager") {
      options.packageManager = readEnum(
        argv[++index],
        packageManagers,
        "package manager",
      );
    } else if (value === "--no-install") {
      options.install = false;
    } else if (value === "--install") {
      options.install = true;
    } else if (value === "--help" || value === "-h") {
      showHelp = true;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }

  if (options.deployment === "cloudflare") {
    if (!argv.includes("--database")) options.database = "d1";
    if (!argv.includes("--storage")) options.storage = "r2";
  }
  return { options, interactive: !explicit && !options.projectName, showHelp };
}

async function askQuestions(defaults: CreateOptions): Promise<CreateOptions> {
  p.intro("Create Heyo CMS");

  const projectName = promptValue(
    await p.text({
      message: "Project name",
      placeholder: "my-cms",
      defaultValue: "my-cms",
      validate: projectNameError,
    }),
  );
  const template = await select<Template>("Framework", TEMPLATE_OPTIONS, "next"); // prettier-ignore
  const deployment = await select<Deployment>("Deployment", DEPLOYMENT_OPTIONS, "vercel"); // prettier-ignore
  const database = await selectDatabase(deployment);
  const storage = await select<Storage>(
    "Media storage",
    deployment === "cloudflare"
      ? STORAGE_OPTIONS.filter((option) => option.value !== "local")
      : STORAGE_OPTIONS,
    deployment === "cloudflare" ? "r2" : "s3",
  );
  const packageManager = await select<PackageManager>(
    "Package manager",
    PACKAGE_MANAGER_OPTIONS,
    defaults.packageManager,
  );
  const install = promptValue(
    await p.confirm({ message: "Install dependencies?", initialValue: true }),
  );

  return {
    projectName,
    template,
    deployment,
    database,
    storage,
    packageManager,
    install,
  };
}

/**
 * Asks again rather than failing, when the answer cannot work.
 *
 * D1 on Vercel is the one impossible pair, and somebody who picks it has
 * misunderstood what D1 is — so the message says what it is, and the prompt
 * comes back.
 */
async function selectDatabase(deployment: Deployment): Promise<Database> {
  for (;;) {
    const database = await select<Database>(
      "Database",
      DATABASE_OPTIONS,
      deployment === "cloudflare" ? "d1" : "postgres",
    );
    if (database !== "d1" || deployment === "cloudflare") return database;
    p.log.warn(D1_NEEDS_CLOUDFLARE_MESSAGE);
  }
}

async function select<T extends string>(
  message: string,
  options: { value: string; label: string; hint?: string }[],
  initialValue: T,
): Promise<T> {
  return promptValue(
    await p.select<string>({ message, options, initialValue }),
  ) as T;
}

function promptValue(value: string | symbol): string;
function promptValue(value: boolean | symbol): boolean;
function promptValue(value: string | boolean | symbol): string | boolean {
  if (typeof value !== "symbol") return value;
  if (p.isCancel(value)) {
    p.cancel("Creation cancelled.");
    process.exit(0);
  }
  throw new Error("Prompt did not return a value.");
}

function readEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
): T {
  if (value && allowed.includes(value as T)) return value as T;
  throw new Error(`Use one of ${allowed.join(", ")} for ${label}.`);
}
