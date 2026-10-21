/**
 * String helpers shared across modules.
 */

/**
 * Remove trailing slashes without a regex.
 *
 * The obvious `replace(/\/+$/, "")` backtracks quadratically on a string
 * built out of slashes (CodeQL `js/polynomial-redos`). The values trimmed
 * here are configuration most of the time, but a loop from the end is linear
 * no matter what arrives, so every caller uses it.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return end === value.length ? value : value.slice(0, end);
}
