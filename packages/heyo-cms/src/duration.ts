import { CmsConfigError } from "./errors";

const durationUnits: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parses `30d` into milliseconds.
 *
 * Durations are strings in the configuration because `2592000000` in a diff
 * tells a reviewer nothing. They are parsed once, while the configuration is
 * being built, so a typo is a start-up error rather than a job that silently
 * never runs.
 */
export function parseDuration(value: string, path = ""): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value.trim());
  if (!match) {
    throw new CmsConfigError(
      path,
      `"${value}" is not a duration; use 30d, 10s, 1h`,
    );
  }
  return Number(match[1]) * (durationUnits[match[2] as string] as number);
}

const sizeUnits: Record<string, number> = {
  b: 1,
  kb: 1_024,
  mb: 1_048_576,
  gb: 1_073_741_824,
};

/** Parses `25mb` into bytes, for the same reason `parseDuration` exists. */
export function parseByteSize(value: string, path = ""): number {
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/i.exec(value.trim());
  if (!match) {
    throw new CmsConfigError(path, `"${value}" is not a size; use 25mb, 512kb`);
  }
  return Math.floor(
    Number(match[1]) *
      (sizeUnits[(match[2] as string).toLowerCase()] as number),
  );
}
