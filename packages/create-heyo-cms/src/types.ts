export type Template = "next" | "astro" | "react-router";
export type Deployment = "vercel" | "cloudflare";
export type Database = "postgres" | "mongodb" | "d1";
export type Storage = "local" | "s3" | "r2";
export type PackageManager = "bun" | "pnpm" | "npm" | "yarn";

export const templates: readonly Template[] = ["next", "astro", "react-router"];
export const deployments: readonly Deployment[] = ["vercel", "cloudflare"];
export const databases: readonly Database[] = ["postgres", "mongodb", "d1"];
export const storages: readonly Storage[] = ["local", "s3", "r2"];
export const packageManagers: readonly PackageManager[] = [
  "bun",
  "pnpm",
  "npm",
  "yarn",
];

export interface CreateOptions {
  projectName: string;
  template: Template;
  deployment: Deployment;
  database: Database;
  storage: Storage;
  packageManager: PackageManager;
  install: boolean;
  /** Where the project directory is created. Defaults to the shell's. */
  cwd?: string;
  /**
   * The version range written into `package.json`.
   *
   * `latest` in a real run; the repository's own harness passes
   * `workspace:*` so a generated example is checked against the code in the
   * branch rather than against the last release.
   */
  heyoCmsVersion?: string;
}

export interface DetectedPackageManager {
  name: PackageManager;
  version?: string;
}
