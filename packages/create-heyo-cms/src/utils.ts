import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export function replacePlaceholders(
  source: string,
  values: Record<string, string>,
): string {
  return source.replace(/\{\{([A-Z0-9_]+)\}\}/g, (placeholder, key: string) =>
    key in values ? (values[key] as string) : placeholder,
  );
}

/**
 * Merges an overlay's `package.json` into the template's.
 *
 * Deep, so `scripts` and `dependencies` from a deployment join the template's
 * rather than replacing them; shallow at the leaves, so an overlay can pin a
 * version the template also names.
 */
export function mergePackageJson(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    if (isRecord(current) && isRecord(value))
      merged[key] = mergePackageJson(current, value);
    else merged[key] = value;
  }
  return merged;
}

/**
 * Copies a tree and fills in its placeholders.
 *
 * Files are read as bytes first: a template carries favicons, and decoding
 * one as UTF-8 to look for `{{` and writing it back would corrupt it.
 */
export async function copyTemplate(
  source: string,
  destination: string,
  placeholders: Record<string, string>,
): Promise<void> {
  await cp(source, destination, { recursive: true, force: true });
  await replacePlaceholdersAtPath(destination, placeholders);
}

async function replacePlaceholdersAtPath(
  path: string,
  values: Record<string, string>,
): Promise<void> {
  if (!(await stat(path)).isDirectory()) {
    const contents = await readFile(path);
    if (!isTextFile(contents)) return;
    const source = contents.toString("utf8");
    if (!source.includes("{{")) return;
    await writeFile(path, replacePlaceholders(source, values));
    return;
  }

  const entries = await readdir(path, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      replacePlaceholdersAtPath(join(path, entry.name), values),
    ),
  );
}

function isTextFile(contents: Buffer): boolean {
  if (contents.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return true;
  } catch {
    return false;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
