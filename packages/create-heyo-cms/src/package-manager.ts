import { spawnSync } from "node:child_process";

import type { DetectedPackageManager, PackageManager } from "./types";

const FALLBACK_VERSIONS: Record<PackageManager, string> = {
  bun: "1.3.1",
  pnpm: "10.17.0",
  npm: "11.6.0",
  yarn: "4.9.4",
};

/**
 * Which package manager invoked the generator.
 *
 * `npm_config_user_agent` is set by all four, and it is the only signal that
 * is right without asking: somebody who typed `pnpm create` wants pnpm, and a
 * prompt whose default is npm would be a prompt they have to correct.
 */
export function detectPackageManager(
  userAgent = process.env.npm_config_user_agent ?? "",
): DetectedPackageManager {
  const match = /(?:^|\s)(bun|pnpm|npm|yarn)\/([^\s]+)/.exec(userAgent);
  if (!match) return { name: "npm" };
  return { name: match[1] as PackageManager, version: match[2] as string };
}

/** The `packageManager` field, pinned to the version actually in use. */
export function packageManagerField(
  manager: PackageManager,
  detected = detectPackageManager(),
): string {
  if (manager === detected.name && detected.version)
    return `${manager}@${detected.version}`;
  try {
    const result = spawnSync(manager, ["--version"], { encoding: "utf8" });
    const version = result.stdout?.trim();
    if (result.status === 0 && version && /^\d+(?:\.\d+)+/.test(version))
      return `${manager}@${version}`;
  } catch {
    // The chosen package manager need not be installed on this machine.
  }
  return `${manager}@${FALLBACK_VERSIONS[manager]}`;
}

export function packageManagerInstallCommand(
  manager: PackageManager,
): string[] {
  return manager === "yarn" ? ["yarn"] : [manager, "install"];
}

export function packageManagerRunCommand(
  manager: PackageManager,
  script: string,
): string {
  if (manager === "npm") return `npm run ${script}`;
  if (manager === "yarn") return `yarn ${script}`;
  return `${manager} run ${script}`;
}

/** How this manager spells "run a binary from node_modules". */
export function packageManagerExecCommand(
  manager: PackageManager,
  command: string,
): string {
  if (manager === "npm") return `npx ${command}`;
  if (manager === "yarn") return `yarn ${command}`;
  if (manager === "pnpm") return `pnpm ${command}`;
  return `bunx ${command}`;
}
