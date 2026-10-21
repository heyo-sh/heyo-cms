import { permissionFor, permits } from "../access/permissions";
import { CmsError } from "../errors";
import type { Actor } from "../types/actor";
import type {
  AccessOperation,
  CollectionAccess,
  RbacConfig,
  ResolvedCollection,
} from "../types/config";
import type { JsonObject } from "../types/json";
import type { Where } from "../types/query";

/**
 * Which CRUD rule answers for which operation.
 *
 * `access` covers CRUD and nothing else in v1 (section 3), but the engine has
 * two operations outside it. Both are a document leaving — one temporarily,
 * one for good — so both ask the `delete` rule. The permission they require
 * is still their own name, which is how section 4 keeps `restore` and `purge`
 * grantable separately without widening the rule type.
 */
const ruleFor: Record<AccessOperation, keyof CollectionAccess> = {
  read: "read",
  create: "create",
  update: "update",
  delete: "delete",
  restore: "delete",
  purge: "delete",
};

export interface AccessRequest {
  actor: Actor | null;
  operation: AccessOperation;
  locale: string | null;
  record?: JsonObject;
  /**
   * Present when the configuration declares roles.
   *
   * It changes the default for a collection with no rule from "open" to
   * "needs `collection:action`" — the only safe reading once roles exist, and
   * the reason declaring `rbac` is a decision rather than a formality.
   */
  rbac?: RbacConfig | undefined;
}

/**
 * Evaluates a collection's access rule for one operation.
 *
 * `false` throws here; a `Where` is returned so the caller can add it to the
 * query with `and(requestWhere, accessWhere)`. Filtering after fetching would
 * leak through counts, pagination and `hasNextPage` — the rule has to reach
 * the database, not the serialiser (stage 4).
 *
 * An explicit rule is the final word: RBAC is not consulted for an operation
 * the collection decided for itself, because a rule that said `true` and was
 * then overruled by a permission the developer forgot to grant would be
 * indistinguishable from a bug.
 */
export async function accessFilter(
  collection: ResolvedCollection,
  request: AccessRequest,
): Promise<Where | undefined> {
  const rule = collection.access[ruleFor[request.operation]];
  if (!rule) {
    requirePermission(collection, request);
    return undefined;
  }

  const result = await rule({
    actor: request.actor,
    operation: request.operation,
    locale: request.locale,
    ...(request.record === undefined ? {} : { record: request.record }),
  });

  if (result === true) return undefined;
  if (result === false) throw refuse(collection, request);
  return result;
}

/**
 * The RBAC default, used when a collection declares no rule for an operation.
 *
 * Without `rbac` in the configuration there is nothing to check and the
 * collection stays open, which is what makes the engine usable before anyone
 * has thought about roles.
 */
function requirePermission(
  collection: ResolvedCollection,
  request: AccessRequest,
): void {
  if (!request.rbac) return;
  const required = permissionFor(collection.name, request.operation);
  if (permits(request.actor, required)) return;
  throw refuse(collection, request, required);
}

function refuse(
  collection: ResolvedCollection,
  request: AccessRequest,
  permission?: string,
): CmsError {
  const what = `${request.operation} ${collection.name}`;
  // Anonymous gets 401 — "sign in and try again" — and an authenticated actor
  // gets 403, because retrying will not help them.
  return request.actor === null
    ? CmsError.unauthorized(`Not allowed to ${what}`)
    : CmsError.forbidden(
        permission
          ? `Not allowed to ${what}; the "${permission}" permission is required`
          : `Not allowed to ${what}`,
      );
}
