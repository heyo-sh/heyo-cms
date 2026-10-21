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
): string {
  const parts: string[] = [];
  let budget = maxRecordChars;

  for (const name of visible) {
    const field = collection.fields[name];
    if (!field) continue;
    const rendered = renderFieldValue(field, document[name]);
    const allowance = Math.min(maxFieldChars, Math.max(budget, 0));
    const { text, truncated } = cut(rendered, allowance);
    budget -= text.length;
    parts.push(
      `### ${name} (${field.type}${field.localized ? ", localized" : ""})\n${
        text.length === 0 ? "(empty)" : text
      }${truncated ? "\n…[truncated]" : ""}`,
    );
    if (budget <= 0) {
      parts.push("…[remaining fields omitted: the record is too long]");
      break;
    }
  }

  return parts.join("\n\n");
}

function renderFieldValue(
  field: FieldDefinition,
  value: JsonValue | undefined,
): string {
  if (value === null || value === undefined) return "";
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
