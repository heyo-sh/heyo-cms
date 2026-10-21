import type { Actor } from "../types/actor";

/**
 * The permission grammar: `collection:action`, with `*` on either side.
 *
 * Deliberately tiny. A role is a list of patterns, an actor carries the
 * flattened result, and every check in the engine is one string match — which
 * is what lets an access rule be written as `permits(actor, "posts:publish")`
 * in a configuration file without importing anything that touches a database.
 *
 * `*` on its own is the administrator: it matches every collection and every
 * action, including the ones a plugin adds after this file was written.
 */

export const wildcard = "*";

/** `posts:create`. The only place the string is assembled. */
export function permissionFor(collection: string, action: string): string {
  return `${collection}:${action}`;
}

/** Splits `posts:*` into its two halves; a lone `*` widens to `*:*`. */
function parts(permission: string): [string, string] {
  if (permission === wildcard) return [wildcard, wildcard];
  const separator = permission.indexOf(":");
  if (separator === -1) return [permission, wildcard];
  return [permission.slice(0, separator), permission.slice(separator + 1)] as [
    string,
    string,
  ];
}

function covers(pattern: string, value: string): boolean {
  return pattern === wildcard || pattern === value;
}

/** Does one pattern grant one concrete `collection:action`? */
export function grants(pattern: string, required: string): boolean {
  const [patternCollection, patternAction] = parts(pattern);
  const [collection, action] = parts(required);
  return covers(patternCollection, collection) && covers(patternAction, action);
}

/**
 * Does this actor hold the permission?
 *
 * Takes the actor rather than the list so an access rule reads the way the
 * plan writes it, and so `null` — an anonymous caller — is answered here
 * instead of at every call site.
 */
export function permits(
  actor: Actor | null | undefined,
  required: string,
): boolean {
  if (!actor) return false;
  return actor.permissions.some((pattern) => grants(pattern, required));
}

/**
 * Flattens roles into the patterns they stand for.
 *
 * Unknown roles contribute nothing instead of throwing: a role can be deleted
 * in the panel while a user still references it, and the safe reading of a
 * grant that no longer exists is "no grant".
 */
export function expandRoles(
  roles: string[],
  definitions: Record<string, string[]>,
): string[] {
  const permissions = new Set<string>();
  for (const role of roles) {
    for (const permission of definitions[role] ?? []) {
      permissions.add(permission);
    }
  }
  return [...permissions].sort();
}

/**
 * The narrower of two pattern sets.
 *
 * An API key cannot grant more than the user it belongs to, so the key's
 * scopes and the user's permissions are intersected pattern by pattern:
 * `["*"]` ∩ `["*:read"]` is `["*:read"]`, and `["posts:*"]` ∩ `["*:read"]` is
 * `["posts:read"]`. Keeping this exact is what makes a read-only key on an
 * administrator's account actually read-only.
 */
export function intersectPermissions(
  left: string[],
  right: string[],
): string[] {
  const result = new Set<string>();

  for (const a of left) {
    const [aCollection, aAction] = parts(a);
    for (const b of right) {
      const [bCollection, bAction] = parts(b);
      const collection = narrow(aCollection, bCollection);
      const action = narrow(aAction, bAction);
      if (collection === null || action === null) continue;
      result.add(
        collection === wildcard && action === wildcard
          ? wildcard
          : `${collection}:${action}`,
      );
    }
  }
  return [...result].sort();
}

function narrow(left: string, right: string): string | null {
  if (left === wildcard) return right;
  if (right === wildcard) return left;
  return left === right ? left : null;
}

/**
 * What an API key scope means in the permission grammar.
 *
 * `read`, `write` and `delete` are the coarse scopes the plan names; anything
 * containing a colon is already a pattern and is taken literally, so a key can
 * be scoped to `posts:update` without inventing a second vocabulary.
 */
export function scopePermissions(scopes: string[]): string[] {
  const permissions = new Set<string>();

  for (const scope of scopes) {
    if (scope === wildcard || scope.includes(":")) {
      permissions.add(scope);
      continue;
    }
    switch (scope) {
      case "read":
        permissions.add("*:read");
        break;
      case "write":
        // Write implies read: a key that may change a document but may not
        // read it back cannot do anything useful, and every client it would
        // be used from reads before it writes.
        permissions.add("*:read");
        permissions.add("*:create");
        permissions.add("*:update");
        break;
      case "delete":
        permissions.add("*:delete");
        break;
      default:
        // An unknown coarse scope grants nothing rather than everything.
        break;
    }
  }
  return [...permissions].sort();
}

/** Is this a legal scope string? Used to reject typos at configuration time. */
export function isValidScope(scope: string): boolean {
  if (scope === wildcard) return true;
  if (["read", "write", "delete"].includes(scope)) return true;
  return /^[a-z0-9_*-]+:[a-z0-9_*-]+$/.test(scope);
}
