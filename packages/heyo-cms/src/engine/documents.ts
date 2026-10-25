import { CmsError } from "../errors";
import type { Actor } from "../types/actor";
import type { ResolvedCollection } from "../types/config";
import type { FieldDefinition } from "../types/fields";
import type { ColumnValue, Row } from "../types/query";
import type { JsonObject, JsonValue } from "../types/json";
import {
  resolveLocalized,
  writeLocalized,
  type LocaleContext,
} from "./locales";

/**
 * The columns the engine owns on every document.
 *
 * They are accepted in an input object and ignored rather than rejected, so
 * `update({ id, data: doc })` — reading a document, editing one field and
 * writing the whole thing back — works without the caller having to strip
 * them first.
 */
export const systemDocumentFields = [
  "id",
  "revision",
  "createdAt",
  "updatedAt",
  "updatedBy",
  "deletedAt",
  "purgeAfter",
  "scheduledAt",
  "scheduledPatch",
  "_fallback",
  "_localeFields",
] as const;

const systemFieldSet = new Set<string>(systemDocumentFields);

/**
 * Turns a stored row into the document a caller sees.
 *
 * One locale is resolved here, once, so nothing downstream — hook, event,
 * REST response, template — ever has to know which fields are translated
 * (section 9).
 */
export function rowToDocument(
  row: Row,
  collection: ResolvedCollection,
  locale: LocaleContext,
): JsonObject {
  const stored = asObject(row.data);
  const document: JsonObject = {};
  const fallbacks: JsonObject = {};
  const localeFields: string[] = [];

  for (const [name, field] of Object.entries(collection.fields)) {
    if (field.localized) {
      const values = stored[name];
      if (
        values &&
        typeof values === "object" &&
        !Array.isArray(values) &&
        Object.hasOwn(values, locale.locale)
      )
        localeFields.push(name);
      const resolved = resolveLocalized(values, locale);
      document[name] = resolved.value ?? declaredDefault(field);
      if (resolved.from !== null && resolved.from !== locale.locale) {
        fallbacks[name] = resolved.from;
      }
      continue;
    }
    const value = stored[name];
    document[name] = value === undefined ? declaredDefault(field) : value;
  }

  // Unlike resolved values, this presence marker distinguishes a translation
  // from a field default (or a fallback). The panel uses it before offering
  // to create a new language version, including when the value is null.
  if (Object.values(collection.fields).some((field) => field.localized)) {
    document._localeFields = localeFields;
  }
  document.id = String(row.id);
  // On every read, because a caller that cannot see the revision cannot send
  // it back as a precondition — and a precondition nobody can supply is a
  // feature nobody uses.
  document.revision = toRevision(row.revision);
  document.createdAt = toIso(row.created_at);
  document.updatedAt = toIso(row.updated_at);
  document.updatedBy = row.updated_by === undefined ? null : (row.updated_by as JsonValue); // prettier-ignore
  document.deletedAt = toIso(row.deleted_at);
  // Shown next to `deletedAt` for the same reason a recycle bin shows both:
  // "deleted" is not a decision an editor has to act on, "gone on the 12th"
  // is.
  document.purgeAfter = toIso(row.purge_after);
  document.scheduledAt = toIso(row.scheduled_at);
  // The patch, never the authority it carries: `scheduled_patch` also stores
  // the actor whose permissions the change will be applied with, and that is
  // the engine's business alone.
  document.scheduledPatch = scheduledPatch(row)?.data ?? null;

  if (Object.keys(fallbacks).length > 0) {
    // Named in the response rather than inferred by the client: the panel
    // lists what is missing and offers the field's `translate` action for it.
    document._fallback = fallbacks;
  }

  return document;
}

export interface StoredData {
  /** The full document body as it will be written to the `data` column. */
  data: JsonObject;
  /** Field names the caller actually wrote, in declaration order. */
  touched: string[];
}

/**
 * Folds a caller's input into the stored body.
 *
 * The caller speaks one locale and the storage speaks all of them, so this is
 * where a flat `{ title: "Hello" }` becomes `{ title: { en: "Hello" } }`
 * without disturbing the other translations.
 */
export function toStoredData(
  collection: ResolvedCollection,
  input: JsonObject,
  locale: LocaleContext,
  previous?: JsonObject,
): StoredData {
  assertKnownFields(collection, input);

  const creating = previous === undefined;
  const data: JsonObject = { ...(previous ?? {}) };
  const touched: string[] = [];

  for (const [name, field] of Object.entries(collection.fields)) {
    const given = input[name];

    if (given !== undefined) {
      data[name] = field.localized
        ? writeLocalized(data[name], locale.locale, given)
        : given;
      touched.push(name);
      continue;
    }
    if (!creating) continue;

    // A create fills in the shape of the document, so a field added to the
    // configuration today and a document written yesterday read the same.
    const fallbackValue = declaredDefault(field);
    data[name] = field.localized
      ? fallbackValue === null
        ? {}
        : { [locale.locale]: fallbackValue }
      : fallbackValue;
    if (fallbackValue !== null) touched.push(name);
  }

  return { data, touched };
}

/**
 * Validates the fields a write touched, with the field's own zod schema.
 *
 * Only the touched ones: a localized field is required per locale, and
 * demanding every translation before a German draft can be saved would make
 * partial translations impossible — which section 9 says are the norm. A
 * create touches everything, so `required` is still enforced where it matters.
 */
export function validateFields(
  collection: ResolvedCollection,
  data: JsonObject,
  locale: LocaleContext,
  fields: string[],
): void {
  const errors: Record<string, string> = {};

  for (const name of fields) {
    const field = collection.fields[name];
    if (!field) continue;

    const value = field.localized
      ? (asObject(data[name])[locale.locale] ?? null)
      : (data[name] ?? null);

    if (value === null && field.required) {
      errors[name] = "is required";
      continue;
    }
    const result = field.schema.safeParse(value);
    if (!result.success) errors[name] = issueMessage(result.error.issues[0]);
  }

  if (Object.keys(errors).length > 0) {
    throw CmsError.validation(
      `${collection.name}: ${Object.entries(errors)
        .map(([name, message]) => `${name} ${message}`)
        .join(", ")}`,
      { fields: errors },
    );
  }
}

/**
 * One validation problem, said where it is: a list's row is counted from one,
 * the way an editor counts them (`#2 answer: Invalid input: …`). A scalar
 * field has no path, and keeps the bare message.
 */
function issueMessage(
  issue:
    { code: string; message: string; path: readonly PropertyKey[] } | undefined,
): string {
  if (!issue) return "is invalid";
  const where = issue.path
    .map((part) => (typeof part === "number" ? `#${part + 1}` : String(part)))
    .join(" ");
  if (!where) return issue.message;
  // A required field of a row left empty: said the way a document's own
  // required field is, not as a type error about `null`.
  const missing =
    issue.code === "invalid_type" &&
    /received (null|undefined)$/.test(issue.message);
  return `${where}: ${missing ? "is required" : issue.message}`;
}

/** Field names whose resolved value differs between two documents. */
export function changedFields(
  collection: ResolvedCollection,
  previous: JsonObject,
  next: JsonObject,
): string[] {
  return Object.keys(collection.fields).filter(
    (name) => !sameValue(previous[name], next[name]),
  );
}

/**
 * A system table row as JSON.
 *
 * System tables use real columns and therefore snake_case, which is a storage
 * detail. A `depth` expansion that handed a template `storage_key` would be
 * leaking it (a `media` relation is resolved through this).
 */
export function systemRowToJson(row: Row): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(row)) {
    result[camelCase(key)] =
      value instanceof Date
        ? value.toISOString()
        : value instanceof Uint8Array
          ? null
          : value;
  }
  return result;
}

/**
 * A scheduled change as it is stored.
 *
 * The locale travels with the patch because a patch is written in one
 * language: applying `{ title: "Hallo" }` next Friday has to write the German
 * title, not the default one (section 9). The actor travels with it because
 * the change is applied as an ordinary update and therefore has to pass the
 * same access control a human write would.
 */
export interface ScheduledPatch {
  data: JsonObject;
  locale: string;
  actor: Actor | null;
}

export function scheduledPatch(row: Row): ScheduledPatch | null {
  const stored = row.scheduled_patch;
  if (stored === null || stored === undefined) return null;
  const object = asObject(stored);
  const data = asObject(object.data);
  const locale = typeof object.locale === "string" ? object.locale : null;
  if (locale === null) return null;
  return { data, locale, actor: toActor(object.actor) };
}

function toActor(value: JsonValue | undefined): Actor | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as JsonObject;
  if (typeof record.id !== "string") return null;
  return {
    id: record.id,
    source: record.source === "api-key" ? "api-key" : "session",
    roles: toStringArray(record.roles),
    permissions: toStringArray(record.permissions),
  };
}

function toStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * The stored revision, defaulting to 1.
 *
 * A row written before the column existed reads as revision 1 rather than as
 * `null`: the number means "how many times this has changed", and a document
 * that has never changed since the column arrived has changed once.
 */
export function toRevision(value: ColumnValue | undefined): number {
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1;
}

export function toIso(value: ColumnValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function asObject(
  value: ColumnValue | JsonValue | undefined,
): JsonObject {
  // prettier-ignore
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function declaredDefault(field: FieldDefinition): JsonValue {
  const value = field.defaultValue ?? field.column.default;
  return value === undefined ? null : (value as JsonValue);
}

/**
 * An unknown key is a typo, and a typo that is silently dropped is a bug
 * report three weeks later. System fields are the one exception, because
 * round-tripping a document has to work.
 */
function assertKnownFields(
  collection: ResolvedCollection,
  input: JsonObject,
): void {
  const unknown = Object.keys(input).filter(
    (key) => !(key in collection.fields) && !systemFieldSet.has(key),
  );
  if (unknown.length > 0) {
    throw CmsError.validation(
      `${collection.name} has no field ${unknown.map((key) => `"${key}"`).join(", ")}`,
      { unknown },
    );
  }
}

function sameValue(
  a: JsonValue | undefined,
  b: JsonValue | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function camelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_, character: string) =>
    character.toUpperCase(),
  );
}
