import { CmsError } from "../../errors";
import type { CmsUserStatus } from "../../types/auth";
import type { CmsInstance } from "../../types/instance";
import { requirePermission } from "../guard";
import { integer } from "../params";
import {
  json,
  noContent,
  optionalString,
  optionalStringArray,
  readJsonObject,
  requireString,
} from "../respond";
import type { RouteRecord } from "../router";
import { jsonBody, okJson, pathParam, queryParam, ref } from "../spec";

/**
 * Who may edit, and what each role means.
 *
 * These are the endpoints with no collection behind them, so the permission
 * check is explicit — `users:read`, `roles:create` — and an authenticated
 * caller is required even when `rbac` is absent (see `guard.ts`). Everything
 * else is `cms.auth`, unchanged: the panel and a provisioning script get the
 * same invitations, the same hashed secrets and the same events.
 */
export function accessRoutes(cms: CmsInstance): RouteRecord[] {
  const config = cms._config;
  if (!config.admin.auth) return [];

  const tags = ["access"];
  const routes: RouteRecord[] = [
    {
      method: "GET",
      path: "/users",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "users:read");
        const status = context.query.get("status");
        const search = context.query.get("search");
        const limit = integer(context.query.get("limit"), "limit", 1, 200);
        const offset = integer(context.query.get("offset"), "offset", 0, 100_000); // prettier-ignore

        const [users, total] = await Promise.all([
          cms.auth.users.list({
            ...(status === null ? {} : { status: userStatus(status) }),
            ...(search === null ? {} : { search }),
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
          }),
          cms.auth.users.count(),
        ]);
        return json({ users, totalUsers: total });
      },
      openapi: {
        summary: "List editors",
        tags,
        parameters: [
          queryParam("status", "string", "active, invited or disabled.", {
            enum: ["active", "invited", "disabled"],
          }),
          queryParam("search", "string", "Matches the email or the name."),
          queryParam("limit", "integer", "Page size. Defaults to 50."),
          queryParam("offset", "integer", "Rows to skip."),
        ],
        responses: {
          "200": okJson(
            {
              type: "object",
              properties: {
                users: { type: "array", items: ref("User") },
                totalUsers: { type: "integer" },
              },
            },
            "The editors of this CMS.",
          ),
        },
      },
    },
    {
      method: "GET",
      path: "/users/:id",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "users:read");
        const user = await cms.auth.users.get(context.params.id as string);
        if (!user) throw CmsError.notFound("No such user.");
        return json({ user });
      },
      openapi: {
        summary: "Read one editor",
        tags,
        parameters: [pathParam("id", "User id.")],
        responses: {
          "200": okJson({ type: "object", properties: { user: ref("User") } }, "The user."), // prettier-ignore
          "404": okJson(ref("Error"), "No such user."),
        },
      },
    },
    {
      method: "PATCH",
      path: "/users/:id",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "users:update");
        const body = await readJsonObject(context.request);
        const roles = optionalStringArray(body, "roles");
        const name = optionalString(body, "name");
        const locale = optionalString(body, "locale");
        const status = optionalString(body, "status");

        const user = await cms.auth.users.update(context.params.id as string, {
          actor,
          ...(name === undefined ? {} : { name }),
          ...(roles === undefined ? {} : { roles }),
          ...(locale === undefined ? {} : { locale }),
          ...(status === undefined ? {} : { status: userStatus(status) }),
        });
        return json({ user });
      },
      openapi: {
        summary: "Update an editor",
        description:
          "A role change emits `role.changed` and takes effect on the user's next request, because permissions are resolved per request rather than frozen into the session.",
        tags,
        parameters: [pathParam("id", "User id.")],
        requestBody: jsonBody({
          type: "object",
          properties: {
            name: { type: ["string", "null"] },
            roles: { type: "array", items: { type: "string" } },
            status: { type: "string", enum: ["active", "invited", "disabled"] },
            locale: { type: ["string", "null"] },
          },
        }),
        responses: {
          "200": okJson({ type: "object", properties: { user: ref("User") } }, "The user."), // prettier-ignore
        },
      },
    },
    {
      method: "POST",
      path: "/users/invite",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "users:invite");
        const body = await readJsonObject(context.request);
        const roles = optionalStringArray(body, "roles");
        const name = optionalString(body, "name");

        const invite = await cms.auth.users.invite({
          email: requireString(body, "email"),
          actor,
          ...(roles === undefined ? {} : { roles }),
          ...(name === undefined ? {} : { name }),
        });
        // The token is returned here, unlike on the magic-link route, and the
        // difference is who is asking: an administrator who may already
        // create accounts is being handed a link to send, not a way to become
        // somebody else.
        return json(invite, 201);
      },
      openapi: {
        summary: "Invite an editor",
        description:
          "Creates the account in `invited` state and returns the single-use token, because the CMS does not send email. `user.invited` carries who was invited and never the token.",
        tags,
        requestBody: jsonBody({
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
            name: { type: "string" },
            roles: { type: "array", items: { type: "string" } },
          },
        }),
        responses: {
          "201": okJson(ref("Invite"), "The invitation and its token."),
          "409": okJson(ref("Error"), "That address already has an account."),
        },
      },
    },
    {
      method: "DELETE",
      path: "/users/:id",
      source: "core",
      handler: async (context) => {
        const actor = requirePermission(config, context.actor, "users:delete");
        const id = context.params.id as string;
        if (id === actor.id) {
          // Removing yourself is how a one-administrator deployment locks
          // everybody out of the panel for good.
          throw CmsError.conflict("You cannot remove your own account.");
        }
        await cms.auth.users.remove(id, { actor });
        return noContent();
      },
      openapi: {
        summary: "Remove an editor",
        description:
          "Their sessions, accounts, tokens and API keys go with them. Documents they wrote do not.",
        tags,
        parameters: [pathParam("id", "User id.")],
        responses: {
          "204": { description: "Removed." },
          "409": okJson(ref("Error"), "You cannot remove your own account."),
        },
      },
    },
    {
      method: "GET",
      path: "/roles",
      source: "core",
      handler: async (context) => {
        requirePermission(config, context.actor, "roles:read");
        const roles = await cms.auth.roles.list();
        return json({ roles });
      },
      openapi: {
        summary: "List roles",
        description:
          "Both kinds: the ones declared in `rbac.roles`, which are code, and the ones created in the panel, which are rows. `source` says which is which.",
        tags,
        responses: {
          "200": okJson(
            { type: "object", properties: { roles: { type: "array", items: ref("Role") } } }, // prettier-ignore
            "The roles.",
          ),
        },
      },
    },
  ];

  // Managing roles at runtime only exists where the configuration said so:
  // without `customRoles` the roles are a list in a file, and an endpoint
  // that wrote rows nothing reads would be a trap.
  if (config.rbac?.customRoles === true) {
    routes.push(
      {
        method: "POST",
        path: "/roles",
        source: "core",
        handler: async (context) => {
          requirePermission(config, context.actor, "roles:create");
          const body = await readJsonObject(context.request);
          const permissions = optionalStringArray(body, "permissions") ?? [];
          const label = optionalString(body, "label");
          const role = await cms.auth.roles.create({
            name: requireString(body, "name"),
            permissions,
            ...(label === undefined ? {} : { label }),
          });
          return json({ role }, 201);
        },
        openapi: {
          summary: "Create a role",
          tags,
          requestBody: jsonBody({
            type: "object",
            required: ["name", "permissions"],
            properties: {
              name: { type: "string" },
              label: { type: "string" },
              permissions: {
                type: "array",
                items: { type: "string" },
                description: '`collection:action`, with `*` allowed on either side.', // prettier-ignore
              },
            },
          }),
          responses: {
            "201": okJson({ type: "object", properties: { role: ref("Role") } }, "The role."), // prettier-ignore
            "409": okJson(ref("Error"), "A role with that name exists, or the name is declared in the configuration."), // prettier-ignore
          },
        },
      },
      {
        method: "PATCH",
        path: "/roles/:name",
        source: "core",
        handler: async (context) => {
          requirePermission(config, context.actor, "roles:update");
          const body = await readJsonObject(context.request);
          const permissions = optionalStringArray(body, "permissions");
          const label = optionalString(body, "label");
          const role = await cms.auth.roles.update(
            context.params.name as string,
            {
              ...(permissions === undefined ? {} : { permissions }),
              ...(label === undefined ? {} : { label }),
            },
          );
          return json({ role });
        },
        openapi: {
          summary: "Update a role",
          tags,
          parameters: [pathParam("name", "Role name.")],
          requestBody: jsonBody({
            type: "object",
            properties: {
              label: { type: ["string", "null"] },
              permissions: { type: "array", items: { type: "string" } },
            },
          }),
          responses: {
            "200": okJson({ type: "object", properties: { role: ref("Role") } }, "The role."), // prettier-ignore
            "404": okJson(ref("Error"), "No such role, or it is declared in the configuration."), // prettier-ignore
          },
        },
      },
      {
        method: "DELETE",
        path: "/roles/:name",
        source: "core",
        handler: async (context) => {
          requirePermission(config, context.actor, "roles:delete");
          const removed = await cms.auth.roles.remove(
            context.params.name as string,
          );
          if (!removed) throw CmsError.notFound("No such role.");
          return noContent();
        },
        openapi: {
          summary: "Delete a role",
          description:
            "A user still holding it keeps the name and loses the grants, because the safe reading of a grant that no longer exists is no grant.",
          tags,
          parameters: [pathParam("name", "Role name.")],
          responses: {
            "204": { description: "Removed." },
            "404": okJson(ref("Error"), "No such role."),
          },
        },
      },
    );
  }

  return routes;
}

function userStatus(value: string): CmsUserStatus {
  if (value === "active" || value === "invited" || value === "disabled") {
    return value;
  }
  throw CmsError.validation(
    `"${value}" is not a status; use active, invited or disabled.`,
  );
}
