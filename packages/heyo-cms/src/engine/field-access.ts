import { CmsError } from "../errors";
import type { Actor } from "../types/actor";
import type { ResolvedCollection } from "../types/config";
import type { JsonObject } from "../types/json";

/**
 * Field-level access.
 *
 * This is where "who may publish" is actually decided. The engine has no
 * publish operation and `access` covers CRUD only, so the question becomes
 * "who may write the `status` field" — which is this file, and nothing else
 * (section 11).
 *
 * Two rules, two moments:
 *
 * - `read` is applied to what leaves the engine. A field the actor may not
 *   read is **absent** from the document rather than `null`: absent is a fact
 *   about permission, `null` is a fact about content, and conflating them
 *   makes a panel show an empty input over a value that exists.
 * - `update` is applied to what the caller sent, before any hook runs. Hooks
 *   are server code — the same reason `ctx.db` bypasses access control by
 *   name — so a hook filling in a slug is never refused on the actor's
 *   behalf.
 */

interface FieldRules {
  read: string[];
  update: string[];
}

/**
 * Which fields of a collection carry rules at all.
 *
 * Cached per collection object: almost every collection has none, and walking
 * the field map on every document of every page would be work done to
 * discover there is no work.
 */
const cache = new WeakMap<ResolvedCollection, FieldRules>();

function rulesFor(collection: ResolvedCollection): FieldRules {
  const existing = cache.get(collection);
  if (existing) return existing;

  const rules: FieldRules = { read: [], update: [] };
  for (const [name, field] of Object.entries(collection.fields)) {
    if (field.access?.read) rules.read.push(name);
    if (field.access?.update) rules.update.push(name);
  }
  cache.set(collection, rules);
  return rules;
}

export function hasFieldAccessRules(collection: ResolvedCollection): boolean {
  const rules = rulesFor(collection);
  return rules.read.length > 0 || rules.update.length > 0;
}

/**
 * Removes the fields this actor may not read, in place.
 *
 * In place because the caller owns the document: it was just built from a
 * row, and copying every document of every page to delete a key from one of
 * them would be the wrong trade.
 */
export function applyFieldReadAccess(
  document: JsonObject,
  collection: ResolvedCollection,
  actor: Actor | null,
  locale: string | null,
): JsonObject {
  const denied = rulesFor(collection).read.filter((name) => {
    const rule = collection.fields[name]?.access?.read;
    return rule && !rule({ actor, record: document, locale });
  });
  // Evaluate every rule against the same unmodified record. Metadata is also
  // an output channel: scheduled values and fallback markers must not reveal
  // a field hidden in the document body.
  for (const key of ["scheduledPatch", "_fallback"]) {
    const value = document[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const redacted = { ...value };
      for (const name of denied) delete redacted[name];
      document[key] = redacted;
    }
  }
  if (Array.isArray(document._localeFields)) {
    document._localeFields = document._localeFields.filter(
      (name) => typeof name === "string" && !denied.includes(name),
    );
  }
  for (const name of denied) delete document[name];
  return document;
}

/**
 * Refuses a write that touches a field the actor may not write.
 *
 * Refuses rather than drops: silently ignoring half a form is how an editor
 * ends up believing they published something. The error names the fields, so
 * a panel can mark them.
 */
export function assertFieldWriteAccess(
  collection: ResolvedCollection,
  input: JsonObject,
  actor: Actor | null,
  locale: string | null,
  record?: JsonObject,
): void {
  const refused: string[] = [];

  for (const name of rulesFor(collection).update) {
    if (!(name in input)) continue;
    const rule = collection.fields[name]?.access?.update;
    if (!rule) continue;
    const allowed = rule({
      actor,
      locale,
      ...(record === undefined ? {} : { record }),
    });
    if (!allowed) refused.push(name);
  }

  if (refused.length === 0) return;
  throw CmsError.forbidden(
    `Not allowed to write ${refused.map((name) => `"${name}"`).join(", ")} on ${collection.name}`,
  );
}
