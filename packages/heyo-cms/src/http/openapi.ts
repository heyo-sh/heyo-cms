import { z } from "zod";

import { sessionCookieName } from "../auth/service";
import type { ResolvedCollection } from "../types/config";
import type { FieldDefinition } from "../types/fields";
import type { CmsInstance } from "../types/instance";
import type { JsonObject } from "../types/json";
import type { RouteRecord } from "./router";
import { inputName, schemaName } from "./routes/documents";

/**
 * The OpenAPI document, generated from the configuration and the router.
 *
 * This is what stops the auto-router from being magic (section 10). The
 * endpoints come from the collections, so the only way to know what a
 * deployment answers is to ask the deployment — and the answer has to be
 * machine-readable, or the first thing anybody does is read the source of the
 * CMS to find out what the URL is.
 *
 * Generated from the same `RouteRecord` list the handler matches against, so
 * a route that exists is in here and a route that is in here exists. The
 * field schemas come from the zod schemas the field types already carry:
 * validation and documentation cannot disagree if they are the same object.
 */

const systemDocumentProperties: JsonObject = {
  id: { type: "string" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
  updatedBy: { type: ["string", "null"] },
  deletedAt: {
    type: ["string", "null"],
    format: "date-time",
    description: "Set while the document is in the trash.",
  },
  purgeAfter: { type: ["string", "null"], format: "date-time" },
  scheduledAt: { type: ["string", "null"], format: "date-time" },
  scheduledPatch: {
    type: ["object", "null"],
    description: "The field values a scheduled change will write.",
  },
  _localeFields: {
    type: "array",
    items: { type: "string" },
    description:
      "Localized fields with a stored value (including null) in the requested locale, independent of defaults and fallback.",
  },
  _fallback: {
    type: "object",
    additionalProperties: { type: "string" },
    description:
      "Which fields were answered from i18n.defaultLocale. Absent when the requested locale had every value.",
  },
};

export function buildOpenApi(
  cms: CmsInstance,
  routes: RouteRecord[],
): JsonObject {
  const config = cms._config;

  // A null prototype: the keys are route paths, and although every one
  // starts with "/", an object that cannot be prototype-polluted costs
  // nothing (CodeQL js/prototype-polluting-assignment).
  const paths: JsonObject = Object.create(null) as JsonObject;
  for (const route of routes) {
    const path = openApiPath(route.path);
    const entry = (paths[path] as JsonObject | undefined) ?? {};
    entry[route.method.toLowerCase()] = operation(route);
    paths[path] = entry;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${config.admin.title ?? "Heyo CMS"} — content API`,
      // The configuration's fingerprint rather than the package's version:
      // these endpoints are generated from the collections, so what a client
      // needs to notice is the configuration changing under it. The package
      // version is in `x-heyo-cms`.
      version: fingerprint(paths),
      description: [
        "Generated from the Heyo CMS configuration. Every endpoint below is served by `cms.handler`.",
        "",
        "Filters accept two syntaxes: `?status=draft` / `?views[gte]=10` for the simple cases, and `?where=` carrying the JSON filter AST for composed ones.",
        "A `204` on a write means a `before` hook stopped the operation; it is not an error.",
      ].join("\n"),
    },
    servers: [{ url: config.basePath }],
    tags: tags(cms),
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "A session token or an API key. The key prefix tells them apart, so one header serves both.",
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: sessionCookieName,
          description: "Set by the sign-in routes; what the panel uses.",
        },
      },
      schemas: schemas(cms),
    },
    paths,
    "x-heyo-cms": {
      basePath: config.basePath,
      adminPath: `${config.basePath}${config.admin.path}`,
      collections: Object.values(config.collections).map((collection) => ({
        name: collection.name,
        slug: collection.slug,
      })),
      globals: Object.values(config.globals).map((global) => ({
        name: global.name,
        slug: global.slug,
      })),
      plugins: config.plugins.map((plugin) => plugin.id),
    },
  };
}

function operation(route: RouteRecord): JsonObject {
  const spec = route.openapi;
  const parameters = [...(spec?.parameters ?? [])];
  // A path parameter that the route declares but the fragment forgot would
  // produce a document a generated client cannot call.
  for (const name of pathParams(route.path)) {
    if (
      !parameters.some((parameter) => (parameter as JsonObject).name === name)
    ) {
      // prettier-ignore
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    }
  }

  return {
    operationId: operationId(route),
    summary:
      spec?.summary ??
      (route.source === "core"
        ? `${route.method} ${route.path}`
        : `${route.method} ${route.path} (plugin: ${route.source})`),
    ...(spec?.description === undefined
      ? {}
      : { description: spec.description }),
    tags: spec?.tags ?? [route.source === "core" ? "other" : route.source],
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(spec?.requestBody === undefined
      ? {}
      : { requestBody: spec.requestBody }),
    responses: {
      ...(spec?.responses ?? { "200": { description: "Success." } }),
      "400": {
        description: "The request could not be read.",
        content: { "application/json": { schema: errorRef() } },
      },
      "401": {
        description: "No session, no API key, or a spent credential.",
        content: { "application/json": { schema: errorRef() } },
      },
    },
    // `security: false` on the fragment marks a door that has to work for a
    // stranger — a sign-in, a public read, the panel's own HTML.
    ...(spec?.security === false ? { security: [] } : {}),
    ...(route.source === "core" ? {} : { "x-heyo-cms-plugin": route.source }),
  };
}

function errorRef(): JsonObject {
  return { $ref: "#/components/schemas/Error" };
}

function schemas(cms: CmsInstance): JsonObject {
  const config = cms._config;
  const result: JsonObject = {
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["message", "code", "status"],
          properties: {
            message: { type: "string" },
            code: {
              type: "string",
              description:
                "Machine-readable: not_found, forbidden, validation_failed, conflict, invalid_cursor, …",
            },
            status: { type: "integer" },
            details: {},
          },
        },
      },
    },
    Actor: {
      type: "object",
      properties: {
        id: { type: "string" },
        source: { type: "string", enum: ["session", "api-key"] },
        roles: { type: "array", items: { type: "string" } },
        permissions: {
          type: "array",
          items: { type: "string" },
          description: "Flattened `collection:action` grants.",
        },
      },
    },
    User: {
      type: "object",
      properties: {
        id: { type: "string" },
        email: { type: "string", format: "email" },
        name: { type: ["string", "null"] },
        status: { type: "string", enum: ["active", "invited", "disabled"] },
        roles: { type: "array", items: { type: "string" } },
        avatarUrl: { type: ["string", "null"] },
        locale: { type: ["string", "null"] },
        twoFactorEnabled: { type: "boolean" },
        lastLoginAt: { type: ["string", "null"], format: "date-time" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
    },
    Invite: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Single-use. The CMS does not send email; you deliver it.", // prettier-ignore
        },
        expiresAt: { type: "string", format: "date-time" },
        email: { type: "string", format: "email" },
        userId: { type: "string" },
        user: { $ref: "#/components/schemas/User" },
      },
    },
    Role: {
      type: "object",
      properties: {
        name: { type: "string" },
        label: { type: ["string", "null"] },
        permissions: { type: "array", items: { type: "string" } },
        source: {
          type: "string",
          enum: ["config", "database"],
          description: "`config` roles are code and cannot be edited here.",
        },
      },
    },
    ApiKey: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        prefix: { type: "string" },
        userId: { type: ["string", "null"] },
        scopes: { type: "array", items: { type: "string" } },
        lastUsedAt: { type: ["string", "null"], format: "date-time" },
        expiresAt: { type: ["string", "null"], format: "date-time" },
        revokedAt: { type: ["string", "null"], format: "date-time" },
        createdAt: { type: "string", format: "date-time" },
      },
    },
    IssuedApiKey: {
      allOf: [
        { $ref: "#/components/schemas/ApiKey" },
        {
          type: "object",
          properties: {
            key: { type: "string", description: "Shown once, never again." },
          },
        },
      ],
    },
    SignInResult: {
      oneOf: [
        {
          type: "object",
          required: ["status", "token"],
          properties: {
            status: { type: "string", const: "signed-in" },
            token: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
            user: { $ref: "#/components/schemas/User" },
            actor: { $ref: "#/components/schemas/Actor" },
          },
        },
        {
          type: "object",
          required: ["status", "challenge"],
          properties: {
            status: { type: "string", const: "two-factor-required" },
            challenge: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
          },
          description:
            "A correct password on an account with a second factor. Worth nothing without a code.",
        },
      ],
    },
    Locale: {
      type: "object",
      properties: {
        code: { type: "string" },
        name: { type: "string", description: 'The English name: "Polish".' },
        rtl: { type: "boolean" },
        isDefault: { type: "boolean" },
      },
    },
    ActivityEntry: {
      type: "object",
      properties: {
        id: { type: "string" },
        action: { type: "string" },
        actorId: { type: ["string", "null"] },
        actorSource: { type: ["string", "null"] },
        collection: { type: ["string", "null"] },
        documentId: { type: ["string", "null"] },
        locale: { type: ["string", "null"] },
        changes: { type: ["object", "null"] },
        ip: { type: ["string", "null"] },
        createdAt: { type: ["string", "null"], format: "date-time" },
      },
    },
    AiProvider: {
      type: "object",
      description: "Whether a provider has credentials. Never the credentials.",
      properties: {
        provider: { type: "string" },
        configured: { type: "boolean" },
        source: { type: ["string", "null"], enum: ["config", "database", null] }, // prettier-ignore
        type: { type: ["string", "null"] },
        hint: {
          type: ["string", "null"],
          description: "Last four characters of a stored key.",
        },
        updatedAt: { type: ["string", "null"], format: "date-time" },
      },
    },
    AiUsage: {
      type: "object",
      properties: {
        input: { type: "integer" },
        output: { type: "integer" },
        total: { type: "integer" },
        cost: { type: "number", description: "US dollars, as priced by the catalogue." }, // prettier-ignore
      },
    },
    AiResult: {
      type: "object",
      description:
        "A suggestion. The document is unchanged until somebody saves it.",
      properties: {
        collection: { type: "string" },
        field: { type: "string" },
        action: { type: "string" },
        value: {
          description:
            "Shaped for the field: a string for text, a ProseMirror document for richText, an array for multiselect.",
        },
        preview: { type: "string", description: "The same thing as text." },
        model: { type: "object" },
        usage: { $ref: "#/components/schemas/AiUsage" },
      },
    },
    AiAssistantEvent: {
      type: "object",
      description:
        "One server-sent event from `POST /ai/assistant`. The panel is written against this union; pi's own event vocabulary is never exposed.",
      properties: {
        type: {
          type: "string",
          enum: [
            "text-delta",
            "tool-start",
            "tool-end",
            "mutation-applied",
            "approval-required",
            "done",
            "error",
          ],
        },
        text: { type: "string", description: "`text-delta` only." },
        id: { type: "string", description: "Tool call id." },
        label: { type: "string", description: "`tool-start` only." },
        summary: {
          type: "string",
          description:
            "`tool-end` only. Written by the server from the tool name, never the tool's raw result.",
        },
        runId: { type: "string" },
        target: { $ref: "#/components/schemas/AiMutationTarget" },
        fields: { type: "array", items: { type: "string" } },
        plan: { $ref: "#/components/schemas/AiPlan" },
        usage: { $ref: "#/components/schemas/AiUsage" },
        code: { type: "string", description: "`error` only." },
        message: { type: "string", description: "`error` only." },
      },
    },
    AiMutationTarget: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["document", "global", "media"] },
        collection: { type: "string" },
        collectionSlug: { type: "string" },
        id: { type: "string" },
        locale: { type: ["string", "null"] },
        revision: { type: "integer" },
      },
    },
    AiPlan: {
      type: "object",
      description:
        "A change waiting for a human. Field names and labels only: an approval dialog nobody reads is the failure this step exists to prevent.",
      properties: {
        id: { type: "string" },
        runId: { type: "string" },
        summary: { type: "string" },
        expiresAt: { type: "string", format: "date-time" },
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              target: { $ref: "#/components/schemas/AiMutationTarget" },
              label: { type: "string" },
              fields: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    Webhook: {
      type: "object",
      properties: {
        id: { type: "string" },
        url: { type: "string", format: "uri" },
        events: { type: "array", items: { type: "string" } },
        filters: { type: ["object", "null"] },
        headers: { type: ["object", "null"] },
        hasSecret: {
          type: "boolean",
          description: "Whether this subscription signs with its own secret.",
        },
        active: { type: "boolean" },
        createdAt: { type: ["string", "null"], format: "date-time" },
        updatedAt: { type: ["string", "null"], format: "date-time" },
      },
    },
    WebhookDelivery: {
      type: "object",
      properties: {
        id: { type: "string" },
        webhookId: { type: "string" },
        eventId: { type: "string" },
        eventType: { type: "string" },
        status: { type: "string", enum: ["pending", "delivered", "failed"] },
        attempt: { type: "integer" },
        responseStatus: { type: ["integer", "null"] },
        responseBody: { type: ["string", "null"] },
        error: { type: ["string", "null"] },
        nextAttemptAt: { type: ["string", "null"], format: "date-time" },
        deliveredAt: { type: ["string", "null"], format: "date-time" },
        createdAt: { type: ["string", "null"], format: "date-time" },
        requestBody: {
          type: ["object", "null"],
          description: "The exact body that was signed. Only when asked for.",
        },
      },
    },
    TrashedEntry: {
      type: "object",
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
        deletedAt: { type: ["string", "null"], format: "date-time" },
        purgeAfter: { type: ["string", "null"], format: "date-time" },
        document: { type: "object" },
      },
    },
    JobRunReport: {
      type: "object",
      properties: {
        ranAt: { type: "string", format: "date-time" },
        processed: { type: "integer" },
        failed: { type: "integer" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              job: { type: "string" },
              processed: { type: "integer" },
              failed: { type: "integer" },
              more: {
                type: "boolean",
                description: "More was waiting than `limit` allowed.",
              },
            },
          },
        },
      },
    },
    JobFailure: {
      type: "object",
      properties: {
        id: { type: "string" },
        type: { type: "string" },
        payload: { type: ["object", "null"] },
        error: { type: ["string", "null"] },
        attempts: { type: "integer" },
        createdAt: { type: ["string", "null"], format: "date-time" },
      },
    },
  };

  if (config.uploads) {
    result.Media = {
      type: "object",
      properties: {
        id: { type: "string" },
        filename: { type: "string" },
        mimeType: { type: "string" },
        size: { type: "integer" },
        width: { type: ["integer", "null"] },
        height: { type: ["integer", "null"] },
        storageKey: { type: "string" },
        checksum: { type: ["string", "null"] },
        alt: { type: "object", additionalProperties: { type: "string" } },
        focalPoint: { type: ["object", "null"] },
        crop: { type: ["object", "null"] },
        status: { type: "string", enum: ["active", "orphaned", "purging"] },
        orphanedAt: { type: ["string", "null"], format: "date-time" },
        purgeAfter: {
          type: ["string", "null"],
          format: "date-time",
          description: "When the collector will delete it. `null` means never.",
        },
        purgeError: { type: ["string", "null"] },
        metadata: { type: "object" },
        variants: { type: "array", items: { type: "string" } },
        createdBy: { type: ["string", "null"] },
        createdAt: { type: ["string", "null"], format: "date-time" },
        updatedAt: { type: ["string", "null"], format: "date-time" },
        url: { type: "string" },
      },
    };
    result.MediaUsage = {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        collection: { type: "string" },
        documentId: { type: "string" },
        field: { type: "string" },
        locale: { type: "string" },
        createdAt: { type: ["string", "null"], format: "date-time" },
      },
    };
  }

  for (const collection of [
    ...Object.values(config.collections),
    ...Object.values(config.globals),
  ]) {
    result[schemaName(collection)] = documentSchema(collection);
    result[inputName(collection)] = inputSchema(collection);
  }

  return result;
}

function documentSchema(collection: ResolvedCollection): JsonObject {
  const properties: JsonObject = {};
  for (const [name, field] of Object.entries(collection.fields)) {
    properties[name] = fieldSchema(field);
  }

  return {
    type: "object",
    title: collection.label,
    ...(collection.kind === "global"
      ? {
          description:
            "A singleton. The timestamps are null until it is first saved.",
        }
      : {}),
    properties: { ...properties, ...systemDocumentProperties },
  };
}

/**
 * What a caller may write.
 *
 * Every field is optional, which is not laziness: a `before` hook is allowed
 * to fill a required field — the slug example in section 5 — so a required
 * field is required after the hooks have run, not in the request body.
 */
function inputSchema(collection: ResolvedCollection): JsonObject {
  const properties: JsonObject = {};
  for (const [name, field] of Object.entries(collection.fields)) {
    properties[name] = fieldSchema(field);
  }
  return {
    type: "object",
    title: `${collection.label} (input)`,
    description:
      "A patch. Absent fields are left alone; a field the actor may not write is refused rather than dropped.",
    properties,
  };
}

/**
 * One field, described by the zod schema it validates with.
 *
 * A localized field is described as its single-locale value, because that is
 * what a read returns and what a write takes: the `{ locale: value }` map is
 * storage, and nothing outside the engine sees it (section 9).
 */
function fieldSchema(field: FieldDefinition): JsonObject {
  let schema: JsonObject;
  try {
    const generated = z.toJSONSchema(field.schema, {
      io: "input",
      // A field type may validate with a refinement JSON Schema cannot
      // express. Describing the rest of it is better than describing none of
      // it, and far better than failing to serve the document.
      unrepresentable: "any",
    }) as JsonObject;
    delete generated.$schema;
    schema = flattenNullable(generated);
  } catch {
    schema = fallbackSchema(field);
  }

  const options = field.options;
  return {
    ...schema,
    ...(options.label === undefined ? {} : { title: options.label }),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(field.defaultValue === undefined
      ? {}
      : { default: field.defaultValue }),
    ...(options.readOnly === true ? { readOnly: true } : {}),
    "x-heyo-cms-field": field.type,
    ...(field.localized ? { "x-heyo-cms-localized": true } : {}),
    ...(field.required ? { "x-heyo-cms-required": true } : {}),
    ...(field.relationTo === undefined
      ? {}
      : { "x-heyo-cms-relation": field.relationTo }),
  };
}

/**
 * `anyOf: [T, null]` written as `type: [t, "null"]`.
 *
 * Almost every field is nullable — an optional field reads as `null`, not as
 * absent — so without this the document would describe the common case as a
 * union and bury the actual type one level down, where a code generator turns
 * it into `Draft | Published | null` wrappers nobody wants.
 */
function flattenNullable(schema: JsonObject): JsonObject {
  const branches = schema.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2) return schema;

  const nullBranch = branches.find(
    (branch) =>
      typeof branch === "object" &&
      branch !== null &&
      (branch as JsonObject).type === "null",
  );
  const valueBranch = branches.find((branch) => branch !== nullBranch);
  if (!nullBranch || typeof valueBranch !== "object" || valueBranch === null) {
    return schema;
  }

  const value = valueBranch as JsonObject;
  const type = value.type;
  const { anyOf, ...rest } = schema;
  return {
    ...rest,
    ...value,
    ...(typeof type === "string" ? { type: [type, "null"] } : {}),
  };
}

function fallbackSchema(field: FieldDefinition): JsonObject {
  switch (field.column.type) {
    case "integer":
    case "bigint":
      return { type: "integer" };
    case "real":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "timestamp":
      return { type: "string", format: "date-time" };
    case "json":
      return {};
    default:
      return { type: "string" };
  }
}

function tags(cms: CmsInstance): JsonObject[] {
  const config = cms._config;
  const base: JsonObject[] = [
    ...Object.values(config.collections).map((collection) => ({
      name: collection.slug,
      description: `${collection.label}: CRUD, the trash and scheduled changes.`, // prettier-ignore
    })),
    ...(Object.keys(config.globals).length === 0
      ? []
      : [{ name: "globals", description: "Singletons." }]),
    ...(config.uploads
      ? [{ name: "media", description: "The library, the variants and the lifecycle." }] // prettier-ignore
      : []),
    {
      name: "auth",
      description: "Editor sign-in, second factor and API keys.",
    },
    { name: "access", description: "Editors and roles." },
    { name: "i18n", description: "The language registry." },
    ...(config.trash.enabled
      ? [{ name: "trash", description: "Deleted documents." }]
      : []),
    { name: "activity", description: "The audit trail." },
    { name: "jobs", description: "The sweeps." },
    { name: "admin", description: "The panel." },
    { name: "system", description: "This document." },
  ];

  for (const plugin of config.plugins) {
    if (plugin.routes?.length) {
      base.push({ name: plugin.id, description: `Routes from the ${plugin.id} plugin.` }); // prettier-ignore
    }
  }
  return base;
}

/** `/posts/:id` is how the router matches; `/posts/{id}` is how OpenAPI says it. */
function openApiPath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      segment.startsWith(":")
        ? `{${segment.slice(1)}}`
        : segment === "*"
          ? "{path}"
          : segment,
    )
    .join("/");
}

function pathParams(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.startsWith(":") || segment === "*")
    .map((segment) => (segment === "*" ? "path" : segment.slice(1)));
}

function operationId(route: RouteRecord): string {
  const parts = route.path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment.startsWith(":")
        ? `by-${segment.slice(1)}`
        : segment === "*"
          ? "asset"
          : segment,
    );
  return [route.method.toLowerCase(), ...parts]
    .join("-")
    .replaceAll(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * A short, stable hash of the generated paths.
 *
 * Used as `info.version` so a client can tell that the contract moved without
 * diffing the document. FNV-1a because it has to produce the same answer on
 * Node, Bun and Workers without a crypto call in a response path.
 */
function fingerprint(paths: JsonObject): string {
  const text = JSON.stringify(Object.keys(paths).sort());
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `0.0.0+${hash.toString(16).padStart(8, "0")}`;
}
