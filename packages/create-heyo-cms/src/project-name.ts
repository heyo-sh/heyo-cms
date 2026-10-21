const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * The name becomes a directory, an npm package name and — on Cloudflare — the
 * Worker's name, which is a hostname. The intersection of what all three
 * accept is narrower than any one of them, so the rule is stated once here.
 */
export function projectNameError(
  value: string | undefined,
): string | undefined {
  if (!value?.trim()) return "Enter a project name.";
  if (!PROJECT_NAME_PATTERN.test(value))
    return "Use letters, numbers and hyphens only.";
  return undefined;
}

export function assertProjectName(value: string): string {
  const error = projectNameError(value);
  if (error) throw new Error(error);
  return value.trim();
}
