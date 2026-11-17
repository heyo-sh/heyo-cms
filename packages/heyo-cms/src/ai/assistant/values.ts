import { richTextFromMarkdown, richTextToMarkdown } from "../../editor/index";
import { CmsError } from "../../errors";
import type { ResolvedCollection } from "../../types/config";
import type { FieldDefinition } from "../../types/fields";
import type { JsonObject, JsonValue } from "../../types/json";

/** How much of one field's text the model may see before it is cut. */
const maxFieldChars = 8_000;
/** How much of a whole record it may see. */
const maxRecordChars = 24_000;

/**
 * The record, rendered for a model.
 *
 * Rich text becomes Markdown, because a ProseMirror document costs three times
 * the tokens to say the same thing and no model writes one back correctly.
 * Everything is length-capped, with the truncation stated in the text rather
 * than hidden: a model that cannot tell it was given half a document will
 * confidently rewrite the half it saw and delete the rest.
 */
export function renderRecord(
  collection: ResolvedCollection,
  document: JsonObject,
  visible: string[],
  /**
   * The name a related record is known by, when the read resolved it
   * (`depth: 1`). Without it a relation is a bare id, and the model either
   * shows the editor "Folder: doc_0mwe7…" or spends a call looking it up.
   */
  titleOf?: RelationTitle,
): string {
  const parts: string[] = [];
  const empty: string[] = [];
  let budget = maxRecordChars;
  const fallbacks = fallbackFields(document);

  for (const name of visible) {
    const field = collection.fields[name];
    if (!field) continue;
    const rendered = renderFieldValue(field, document[name], titleOf);
    // Listed once, at the end, rather than as a heading each. A dozen
    // "(empty)" sections read as content, and the model repeated every one
    // of them back to an editor who had asked to see the article.
    if (rendered.length === 0 && fallbacks[name] === undefined) {
      empty.push(name);
      continue;
    }
    const allowance = Math.min(maxFieldChars, Math.max(budget, 0));
    const { text, truncated } = cut(rendered, allowance);
    budget -= text.length;
    const label = fieldLabel(field);
    // Said in the heading of the field it applies to. Without it a read in
    // Polish of a post that only exists in English comes back as English
    // text under a Polish request, and the model reports it as translated.
    const fallback = fallbacks[name];
    const notes = [
      field.type,
      ...(label === undefined || label === name ? [] : [`label "${label}"`]),
      ...(field.localized ? ["localized"] : []),
      ...(fallback === undefined
        ? []
        : [`NOT TRANSLATED: no value in this language, showing the ${fallback} text`]), // prettier-ignore
    ];
    parts.push(
      `### ${name} (${notes.join(", ")})\n${
        text.length === 0 ? "(empty)" : text
      }${truncated ? "\n…[truncated]" : ""}`,
    );
    if (budget <= 0) {
      parts.push("…[remaining fields omitted: the record is too long]");
      break;
    }
  }

  if (empty.length > 0) parts.push(`Empty fields: ${empty.join(", ")}`);
  return parts.join("\n\n");
}

/** A resolved related record's display name, or `null` to show its id. */
export type RelationTitle = (
  target: string,
  document: JsonObject,
) => string | null;

/** Which fields a localized read answered from another language, and which. */
export function fallbackFields(document: JsonObject): Record<string, string> {
  const raw = document._fallback;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  for (const [name, locale] of Object.entries(raw)) {
    if (typeof locale === "string") result[name] = locale;
  }
  return result;
}

function fieldLabel(field: FieldDefinition): string | undefined {
  const label = (field.options as { label?: unknown } | undefined)?.label;
  return typeof label === "string" && label.trim().length > 0
    ? label.trim()
    : undefined;
}

function renderFieldValue(
  field: FieldDefinition,
  value: JsonValue | undefined,
  titleOf?: RelationTitle,
): string {
  if (value === null || value === undefined) return "";
  const target = field.relationTo ?? (field.type === "media" ? "media" : null);
  if (target !== null) return renderRelation(target, value, titleOf);
  if (field.type === "richText" && typeof value === "object") {
    try {
      return richTextToMarkdown(value as never);
    } catch {
      return "";
    }
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * A relation as `"Title" [id]`, one per related record.
 *
 * The id stays: it is what a write has to send back. The title is what the
 * editor knows the record by, and what the model is told to use.
 */
function renderRelation(
  target: string,
  value: JsonValue,
  titleOf: RelationTitle | undefined,
): string {
  const one = (entry: JsonValue): string => {
    if (typeof entry === "string") return entry;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return "";
    }
    const id = typeof entry.id === "string" ? entry.id : String(entry.id ?? "");
    const title = titleOf?.(target, entry) ?? null;
    return title && title !== id ? `"${title}" [${id}]` : id;
  };
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map(one)
    .filter((text) => text.length > 0)
    .join(", ");
}

function cut(
  text: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, Math.max(limit, 0)), truncated: true };
}

/**
 * One field of a patch, in the shape the field stores.
 *
 * Exactly one conversion happens here — Markdown to a ProseMirror document for
 * `richText` — and nothing else is "helpfully" coerced. A model that answered
 * `"42"` for a number field has misunderstood the schema, and silently
 * parsing it would hide the misunderstanding until the day it answers
 * `"forty-two"`. The validation error is the useful outcome: the agent reads
 * it, re-reads the schema and corrects itself.
 */
export function shapeFieldValue(
  collection: ResolvedCollection,
  name: string,
  value: JsonValue,
): JsonValue {
  const field = collection.fields[name];
  if (!field) {
    throw CmsError.validation(
      `"${name}" is not a field of ${collection.name}.`,
    );
  }
  if (field.type !== "richText") return value;
  if (typeof value === "string") {
    return richTextFromMarkdown(value) as unknown as JsonValue;
  }
  return value;
}

/**
 * The title a human would recognise the record by.
 *
 * Falls back to the id, which is always true and occasionally useful. A search
 * result labelled `undefined` is worse than one labelled `doc_8sKq…`.
 */
export function recordTitle(
  document: JsonObject,
  titleField: string | null,
): string {
  const raw = titleField === null ? null : document[titleField];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (typeof raw === "number") return String(raw);
  return String(document.id ?? "untitled");
}

/**
 * A few fields of a search result, each cut to a line: enough to tell empty
 * from filled, draft from published, short from long — not enough to stand
 * in for reading the record.
 */
export function fieldExcerpts(
  collection: ResolvedCollection,
  document: JsonObject,
  names: string[],
  limit = 200,
): JsonObject {
  const result: JsonObject = {};
  for (const name of names) {
    const field = collection.fields[name];
    if (!field) continue;
    const text = renderFieldValue(field, document[name])
      .replace(/\s+/g, " ")
      .trim();
    result[name] =
      text.length === 0
        ? null
        : text.length > limit
          ? `${text.slice(0, limit)}… (${text.length} characters)`
          : text;
  }
  return result;
}

/** A one-line gist of a record, for a search result that must stay short. */
export function recordSummary(
  collection: ResolvedCollection,
  document: JsonObject,
  skip: string[],
  limit = 160,
): string {
  for (const [name, field] of Object.entries(collection.fields)) {
    if (skip.includes(name)) continue;
    if (!["text", "textarea", "richText", "markdown"].includes(field.type)) {
      continue;
    }
    const text = renderFieldValue(field, document[name])
      .replace(/\s+/g, " ")
      .trim();
    if (text.length === 0) continue;
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }
  return "";
}
