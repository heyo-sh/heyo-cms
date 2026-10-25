import { systemActor } from "../config";
import type { Actor } from "../types/actor";
import type { CollectionApi, GlobalApi } from "../types/api";
import type { ResolvedCollection } from "../types/config";
import type { CmsInstance } from "../types/instance";
import type { JsonObject, JsonValue } from "../types/json";
import {
  exportFormat,
  exportVersion,
  type ContentRecord,
  type DocumentRecord,
  type GlobalRecord,
} from "./records";

export interface ImportOptions {
  /**
   * What to do with a document whose id is already there.
   *
   * `skip` is the default because an import is usually a restore into an
   * empty deployment, and the destructive reading of "merge these two
   * environments" should have to be asked for by name.
   */
  onConflict?: "skip" | "update" | "fail";
  /** Who the writes are attributed to. Defaults to the system actor. */
  actor?: Actor | null;
  /** Parses and reports without writing anything. */
  dryRun?: boolean;
}

export interface ImportReport {
  documents: { created: number; updated: number; skipped: number };
  globals: { updated: number; skipped: number };
  /** Everything that was refused, with the reason, in the order it happened. */
  errors: string[];
}

/**
 * Writes an export back, through the ordinary API.
 *
 * Every document goes through `create`/`update`, which means access control,
 * validation, hooks, the activity log and the outbox all run — an import is
 * an ordinary set of writes performed quickly, not a second way into the
 * database. The cost is that `createdAt` and `updatedAt` are the import's own
 * timestamps; a publication date that matters belongs in a field, where a
 * reader can see it.
 *
 * Ids are preserved. That is what keeps a relation pointing at the document
 * it pointed at, and a rich-text image pointing at the file it was, without
 * a rewriting pass that would have to understand every field type a plugin
 * ever adds.
 */
export async function importContent(
  cms: CmsInstance,
  records: AsyncIterable<ContentRecord> | Iterable<ContentRecord>,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const report: ImportReport = {
    documents: { created: 0, updated: 0, skipped: 0 },
    globals: { updated: 0, skipped: 0 },
    errors: [],
  };
  const actor = options.actor === undefined ? systemActor() : options.actor;
  const onConflict = options.onConflict ?? "skip";
  let sawHeader = false;

  for await (const record of records) {
    if (record.kind === "header") {
      assertReadable(record.format, record.version);
      sawHeader = true;
      continue;
    }
    if (!sawHeader) {
      throw new Error(
        "The file does not start with an export header. Was it produced by `heyo-cms export`?",
      );
    }

    try {
      if (record.kind === "document") {
        await importDocument(cms, record, { actor, onConflict, ...options }, report); // prettier-ignore
      } else {
        await importGlobal(cms, record, { actor, ...options }, report);
      }
    } catch (error) {
      const where =
        record.kind === "document"
          ? `${record.collection}/${record.id}`
          : `globals/${record.global}`;
      report.errors.push(`${where}: ${message(error)}`);
      if (record.kind === "document") report.documents.skipped += 1;
      else report.globals.skipped += 1;
    }
  }

  if (!sawHeader) throw new Error("The file is empty.");
  // An import is a burst of writes, and every one of them queued an event.
  // Draining here means the command does not exit while a webhook subscriber
  // is still being told about the first document.
  if (!options.dryRun) await cms.drainEvents();
  return report;
}

async function importDocument(
  cms: CmsInstance,
  record: DocumentRecord,
  options: Required<Pick<ImportOptions, "onConflict">> &
    Pick<ImportOptions, "actor" | "dryRun">,
  report: ImportReport,
): Promise<void> {
  const collection = cms._config.collections[record.collection];
  if (!collection) {
    throw new Error(`no collection named "${record.collection}" is declared`);
  }
  // A trashed document is content on its way out. Recreating it as a live
  // document would resurrect it; recreating it as trashed would need a write
  // the API deliberately does not have. Saying so is better than either.
  if (record.deletedAt) {
    report.documents.skipped += 1;
    return;
  }

  const api = collectionApi(cms, record.collection);
  const existing = await api.findById(record.id, {
    actor: options.actor ?? null,
    includeTrashed: true,
  });
  if (existing && options.onConflict === "fail") {
    throw new Error("a document with this id is already here");
  }
  if (existing && options.onConflict === "skip") {
    report.documents.skipped += 1;
    return;
  }
  if (options.dryRun) {
    if (existing) report.documents.updated += 1;
    else report.documents.created += 1;
    return;
  }

  const locales = splitLocales(collection, record.data, cms._config.i18n.defaultLocale); // prettier-ignore

  if (existing) {
    const updated = await api.update({
      id: record.id,
      data: locales.base,
      actor: options.actor ?? null,
      source: "cli",
    });
    if (updated === null) {
      report.documents.skipped += 1;
      return;
    }
    report.documents.updated += 1;
  } else {
    const created = await api.create({
      id: record.id,
      data: locales.base,
      actor: options.actor ?? null,
      source: "cli",
    });
    // A `before` hook may refuse a write by returning `false`. That is the
    // documented way to stop an operation, so it is a skip and not an error.
    if (created === null) {
      report.documents.skipped += 1;
      return;
    }
    report.documents.created += 1;
  }

  for (const [locale, data] of Object.entries(locales.translations)) {
    await api.update({
      id: record.id,
      data,
      locale,
      actor: options.actor ?? null,
      source: "cli",
    });
  }

  if (record.scheduledAt && isObject(record.scheduledPatch)) {
    await api.schedule({
      id: record.id,
      at: record.scheduledAt,
      data: record.scheduledPatch,
      actor: options.actor ?? null,
      source: "cli",
    });
  }
}

async function importGlobal(
  cms: CmsInstance,
  record: GlobalRecord,
  options: Pick<ImportOptions, "actor" | "dryRun">,
  report: ImportReport,
): Promise<void> {
  const global = cms._config.globals[record.global];
  if (!global)
    throw new Error(`no global named "${record.global}" is declared`);

  if (options.dryRun) {
    report.globals.updated += 1;
    return;
  }

  const api = globalApi(cms, record.global);
  const locales = splitLocales(global, record.data, cms._config.i18n.defaultLocale); // prettier-ignore
  await api.update({
    data: locales.base,
    actor: options.actor ?? null,
    source: "cli",
  });
  for (const [locale, data] of Object.entries(locales.translations)) {
    await api.update({
      data,
      locale,
      actor: options.actor ?? null,
      source: "cli",
    });
  }
  report.globals.updated += 1;
}

interface SplitData {
  /** Everything that can be written in one call, in the default locale. */
  base: JsonObject;
  /** One patch per further locale, written after the document exists. */
  translations: Record<string, JsonObject>;
}

/**
 * Turns the storage shape back into a sequence of ordinary writes.
 *
 * A localized field is stored as `{ en: ..., pl: ... }` and written one
 * language at a time, because that is what the API offers and inventing a
 * multi-locale write for the importer alone would be a second write path with
 * its own hooks problem.
 */
export function splitLocales(
  collection: ResolvedCollection,
  data: JsonObject,
  defaultLocale: string,
): SplitData {
  const base: JsonObject = Object.create(null) as JsonObject;
  // Locale keys come from an external file. In particular, __proto__ must
  // be an own key, never a path to Object.prototype.
  const translations: Record<string, JsonObject> = Object.create(
    null,
  ) as Record<string, JsonObject>;

  for (const [name, field] of Object.entries(collection.fields)) {
    const value = data[name];
    if (value === undefined) continue;
    if (!field.localized) {
      base[name] = value;
      continue;
    }
    if (!isObject(value)) {
      throw new Error(
        `${name} is localized, but the file holds one value instead of one per language`,
      );
    }
    for (const [locale, translated] of Object.entries(value)) {
      if (translated === undefined) continue;
      if (locale === defaultLocale) {
        base[name] = translated;
        continue;
      }
      (translations[locale] ??= Object.create(null) as JsonObject)[name] =
        translated;
    }
  }

  return { base, translations };
}

function assertReadable(format: string, version: number): void {
  if (format !== exportFormat) {
    throw new Error(`Unknown export format: ${format}.`);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Invalid export version: ${version}.`);
  }
  if (version > exportVersion) {
    throw new Error(
      `This file is version ${version}; this CMS reads up to ${exportVersion}. Upgrade @heyo-sh/heyo-cms.`,
    );
  }
}

function collectionApi(
  cms: CmsInstance,
  name: string,
): CollectionApi<JsonObject> {
  return (cms.api as unknown as Record<string, CollectionApi<JsonObject>>)[
    name
  ] as CollectionApi<JsonObject>;
}

function globalApi(cms: CmsInstance, name: string): GlobalApi<JsonObject> {
  return (cms.globals as unknown as Record<string, GlobalApi<JsonObject>>)[
    name
  ] as GlobalApi<JsonObject>;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
