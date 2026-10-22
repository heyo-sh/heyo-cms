import { permits } from "../access/permissions";
import { CmsError } from "../errors";
import type { Actor, OperationSource } from "../types/actor";
import type { ResolvedCmsConfig } from "../types/config";

/**
 * Who may call the administrative endpoints.
 *
 * Document and media routes need nothing from this file: the engine already
 * answers "may this actor do this" for them, including the anonymous case —
 * a collection with `read: () => true` is a public API and that is the point.
 *
 * The endpoints that manage the CMS itself are different. `GET /users` has no
 * collection to carry an `access` rule, so the rule is here, and it has two
 * parts:
 *
 * 1. **Always an authenticated caller.** Without `rbac` a collection defaults
 *    to open, which is a sensible default for content and a catastrophic one
 *    for user management.
 * 2. **With `rbac`, also the permission.** Declaring roles is the statement
 *    that this deployment distinguishes between editors, so the distinction
 *    is applied here too.
 *
 * The permission names follow the same `resource:action` grammar as
 * everything else — `users:invite`, `roles:create`, `webhooks:create`,
 * `activity:read`, `jobs:run` — so an administrator writes them in `rbac`
 * without learning a second vocabulary.
 */
export function requireActor(actor: Actor | null): Actor {
  if (!actor) {
    throw CmsError.unauthorized("This endpoint needs a session or an API key.");
  }
  return actor;
}

export function requirePermission(
  config: ResolvedCmsConfig,
  actor: Actor | null,
  permission: string,
): Actor {
  const caller = requireActor(actor);
  if (!config.rbac) return caller;
  if (!permits(caller, permission)) {
    throw CmsError.forbidden(`This action needs "${permission}".`);
  }
  return caller;
}

/**
 * A session, specifically.
 *
 * Used by the endpoints that mint credentials: an API key that can create
 * another API key turns a leaked read-only key into a permanent foothold,
 * and the same argument applies to enrolling a second factor.
 */
export function requireSession(actor: Actor | null): Actor {
  const caller = requireActor(actor);
  if (caller.source !== "session") {
    throw CmsError.forbidden(
      "This endpoint needs a signed-in user; an API key cannot issue credentials.",
    );
  }
  return caller;
}

/**
 * Where the call came from, for hooks, events and the activity log.
 *
 * Everything over HTTP is `rest` unless the panel says otherwise with a
 * header. Trusting a client header is fine precisely because it grants
 * nothing: it is a label on a log line, and the panel is the only thing that
 * sends it.
 */
export function requestSource(request: Request): OperationSource {
  return request.headers.get("x-heyo-cms-client") === "admin"
    ? "admin"
    : "rest";
}
