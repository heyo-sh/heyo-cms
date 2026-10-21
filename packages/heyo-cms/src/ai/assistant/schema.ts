import { assertFieldWriteAccess } from "../../engine/field-access";
import type { Actor } from "../../types/actor";
import type { ResolvedCmsConfig, ResolvedCollection } from "../../types/config";
import type { FieldDefinition } from "../../types/fields";
import type { JsonValue } from "../../types/json";

/**
 * The project, as the model may know it.
 *
 * This is the whole answer to "how does the agent know the format of the
 * database". Not a dump of the configuration — the configuration is full of
 * closures, secrets and hook bodies — but a serialisable projection of it,
 * rebuilt per actor, containing only what that actor can already see by
 * opening the panel.
 *
 * Fetched on demand through `describe_cms` rather than pasted into the system
 * prompt. A project with sixty collections would otherwise cost its entire
 * schema in tokens on every turn of every conversation, including the ones
 * that only asked what time it is.
 */

export interface AssistantFieldDescription {
  name: string;
  type: string;
  label: string;
  required: boolean;
  localized: boolean;
  /** Present for `select`/`multiselect`: the values that are legal. */
  options?: string[];
  /** Present for `relation`: the collection an id has to come from. */
  relationTo?: string;
  /** `false` means the actor may read it but not write it. */
  writable: boolean;
}

export interface AssistantCollectionDescription {
  name: string;
  slug: string;
  label: string;
  kind: "collection" | "global";
  titleField: string | null;
  fields: AssistantFieldDescription[];
  can: { read: boolean; create: boolean; update: boolean; delete: boolean };
}

export interface AssistantSchema {
  collections: AssistantCollectionDescription[];
  globals: AssistantCollectionDescription[];
  defaultLocale: string;
  locales: string[];
  media: boolean;
  trash: boolean;
  /**
   * Changes when the shape does.
   *
   * The cache key for one run. A schema the agent looked at two tool calls ago
   * is still the schema it is writing against, and re-deriving it per call
   * would be the one part of this file that costs anything.
   */
  fingerprint: string;
}

export function describeCmsFor(
  config: ResolvedCmsConfig,
  actor: Actor | null,
  locales: string[],
): AssistantSchema {
  const locale = config.i18n.defaultLocale;
  const collections = Object.values(config.collections)
    .map((collection) => describeCollection(collection, actor, locale))
    .filter((entry): entry is AssistantCollectionDescription => entry !== null);
  const globals = Object.values(config.globals)
    .map((global) => describeCollection(global, actor, locale))
    .filter((entry): entry is AssistantCollectionDescription => entry !== null);

  const schema: Omit<AssistantSchema, "fingerprint"> = {
    collections,
    globals,
    defaultLocale: locale,
    locales,
    media: config.uploads !== undefined,
    trash: config.trash.enabled,
  };
  return { ...schema, fingerprint: fingerprint(schema) };
}

/**
 * One collection, or `null` when the actor may not read it at all.
 *
 * A collection the actor cannot read does not appear as "forbidden"; it does
 * not appear. Telling a model that `salaries` exists but is off limits is
 * telling the person reading the conversation the same thing.
 */
function describeCollection(
  collection: ResolvedCollection,
  actor: Actor | null,
  locale: string,
): AssistantCollectionDescription | null {
  if (!mayOperate(collection, "read", actor, locale)) return null;

  const fields: AssistantFieldDescription[] = [];
  for (const [name, field] of Object.entries(collection.fields)) {
    // A field the actor may not read is omitted entirely — name, type and
    // all. A name is a fact about the data model, and "there is a field
    // called `internalRating`" is exactly the fact a read rule was written
    // to withhold.
    const readRule = field.access?.read;
    if (readRule && !readRule({ actor, locale })) continue;
    fields.push(describeField(name, field, collection, actor, locale));
  }

  return {
    name: collection.name,
    slug: collection.slug,
    label: collection.label,
    kind: collection.kind,
    titleField: titleField(collection),
    fields,
    can: {
      read: true,
      create:
        collection.kind === "collection" &&
        mayOperate(collection, "create", actor, locale),
      update: mayOperate(collection, "update", actor, locale),
      delete:
        collection.kind === "collection" &&
        mayOperate(collection, "delete", actor, locale),
    },
  };
}

function describeField(
  name: string,
  field: FieldDefinition,
  collection: ResolvedCollection,
  actor: Actor | null,
  locale: string,
): AssistantFieldDescription {
  const options = field.options as { label?: unknown; options?: unknown };
  const choices = Array.isArray(options.options)
    ? options.options
        .map((entry) =>
          typeof entry === "string"
            ? entry
            : typeof entry === "object" && entry !== null
              ? String((entry as { value?: unknown }).value ?? "")
              : "",
        )
        .filter((entry) => entry.length > 0)
    : undefined;

  return {
    name,
    type: field.type,
    label: typeof options.label === "string" ? options.label : name,
    required: field.required,
    localized: field.localized === true,
    ...(choices && choices.length > 0 ? { options: choices } : {}),
    ...(field.relationTo === undefined ? {} : { relationTo: field.relationTo }),
    writable: mayWriteField(collection, name, actor, locale),
  };
}

/** Whether a field could be written at all by this actor, right now. */
export function mayWriteField(
  collection: ResolvedCollection,
  name: string,
  actor: Actor | null,
  locale: string,
): boolean {
  const field = collection.fields[name];
  if (!field) return false;
  if (field.options.readOnly === true) return false;
  try {
    assertFieldWriteAccess(collection, { [name]: null }, actor, locale);
    return true;
  } catch {
    return false;
  }
}

/** Whether a field's value may be read by this actor. */
export function mayReadField(
  collection: ResolvedCollection,
  name: string,
  actor: Actor | null,
  locale: string,
): boolean {
  const rule = collection.fields[name]?.access?.read;
  return rule ? rule({ actor, locale }) === true : true;
}

/**
 * The optimistic answer to a collection rule, without a record.
 *
 * A rule that returns a `Where` means "some rows", which for the purpose of
 * describing the project means yes: the engine will apply the filter properly
 * when the agent actually reads something. An async rule cannot be awaited in
 * a synchronous description, and the optimistic answer is the honest one for
 * the same reason.
 */
function mayOperate(
  collection: ResolvedCollection,
  operation: "read" | "create" | "update" | "delete",
  actor: Actor | null,
  locale: string,
): boolean {
  const rule = collection.access[operation];
  if (!rule) return true;
  try {
    const result = rule({ actor, operation, locale });
    if (result instanceof Promise) return true;
    return result !== false;
  } catch {
    return true;
  }
}

export function titleField(collection: ResolvedCollection): string | null {
  const configured = collection.admin?.useAsTitle;
  if (configured !== undefined && collection.fields[configured]) {
    return configured;
  }
  for (const candidate of ["title", "name", "label"]) {
    if (collection.fields[candidate]) return candidate;
  }
  const textual = Object.entries(collection.fields).find(
    ([, field]) => field.type === "text",
  );
  return textual?.[0] ?? null;
}

/**
 * A short, stable identity for one shape of one project.
 *
 * Deliberately not a cryptographic hash: nothing depends on it being hard to
 * forge, only on it changing when the schema does, so a cheap rolling hash is
 * the right amount of machinery.
 */
function fingerprint(schema: Omit<AssistantSchema, "fingerprint">): string {
  const source = JSON.stringify(schema as unknown as JsonValue);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
