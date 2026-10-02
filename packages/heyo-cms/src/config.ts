import { CmsConfigError } from "./errors";
import { parseByteSize, parseDuration } from "./duration";
import { buildSchemaSnapshot } from "./schema/snapshot";
import { systemTableNames } from "./schema/system";
import type { Actor } from "./types/actor";
import type {
  CollectionDefinition,
  CollectionDefinitionInput,
  CollectionsConfig,
  GlobalDefinition,
  GlobalsConfig,
  HeyoCmsConfig,
  ResolvedCmsConfig,
  ResolvedCollection,
} from "./types/config";
import type { DatabaseAdapter } from "./types/database";
import type { AnyEventType, CmsEventListener } from "./types/events";
import type { FieldDefinition, FieldsConfig } from "./types/fields";
import type {
  CmsInspection,
  CmsInstance,
  CollectionInspection,
  HookPipelineEntry,
} from "./types/instance";
import type { CmsPlugin } from "./types/plugin";

export const defaultBasePath = "/api/heyo-cms";
export const defaultAdminPath = "/admin";
export const defaultMigrationsDirectory = "./migrations";

const nameFormat = /^[a-z][a-z0-9_]*$/;
const slugFormat = /^[a-z][a-z0-9-]*$/;

/**
 * Declares a collection.
 *
 * Returns the definition unchanged apart from a tag: the work happens in
 * `heyoCms()`, which is the only place that can see collections, globals and
 * plugins at once and therefore the only place that can validate them against
 * each other.
 */
export function defineCollection<TFields extends FieldsConfig>(
  definition: CollectionDefinitionInput<TFields>,
): CollectionDefinition<TFields> {
  return { ...definition, kind: "collection" };
}

/** Declares a singleton. Same machinery, one row. */
export function defineGlobal<TFields extends FieldsConfig>(
  definition: Omit<CollectionDefinitionInput<TFields>, "access"> & {
    access?: GlobalDefinition<TFields>["access"];
  },
): GlobalDefinition<TFields> {
  return { ...definition, kind: "global" };
}

/**
 * Builds the CMS.
 *
 * Everything that can be decided without a database is decided here: names,
 * defaults, the schema the configuration implies, the order hooks will run
 * in. A misconfiguration should fail while the module is loading, with the
 * path to the offending key — not on the first request that happens to touch
 * it.
 */
export function heyoCms<
  const TCollections extends CollectionsConfig,
  const TGlobals extends GlobalsConfig = Record<string, never>,
>(config: HeyoCmsConfig<TCollections, TGlobals>): CmsInstance<TCollections> {
  const resolved = resolveConfig(config);
  const schema = buildSchemaSnapshot({
    collections: resolved.collections,
    globals: resolved.globals,
    pluginTables: resolved.plugins.flatMap(
      (plugin) => plugin.schema?.tables ?? [],
    ),
  });

  const listeners = new Map<string, Set<CmsEventListener>>();
  let adapter: DatabaseAdapter | undefined;
  let pending: Promise<DatabaseAdapter> | undefined;

  const instance: CmsInstance<TCollections> = {
    _config: Object.freeze(resolved),
    schema,
    collections: config.collections,

    inspect(): CmsInspection {
      return {
        basePath: resolved.basePath,
        database: {
          id: adapter?.id ?? "unresolved",
          capabilities: adapter?.capabilities ?? {
            transactions: false,
            sqlMigrations: false,
            jsonQuery: false,
          },
        },
        collections: inspectCollections(resolved),
        schema,
        hooks: hookPipeline(resolved),
        // The router arrives with stage 7; reporting an empty list is honest,
        // inventing route names would not be.
        routes: [],
        plugins: resolved.plugins.map((plugin) => plugin.id),
      };
    },

    async database(): Promise<DatabaseAdapter> {
      if (adapter) return adapter;
      // Two concurrent requests must not each build a connection pool.
      pending ??= Promise.resolve(
        typeof resolved.database === "function"
          ? resolved.database()
          : resolved.database,
      ).then((built) => {
        built.useSchema(schema);
        adapter = built;
        return built;
      });
      return pending;
    },

    on(type: AnyEventType, listener: CmsEventListener): () => void {
      const existing = listeners.get(type) ?? new Set<CmsEventListener>();
      existing.add(listener);
      listeners.set(type, existing);
      return () => {
        existing.delete(listener);
      };
    },

    async close(): Promise<void> {
      await adapter?.close?.();
      adapter = undefined;
      pending = undefined;
      listeners.clear();
    },
  };

  return instance;
}

// ---------------------------------------------------------------------------
// Resolution and validation
// ---------------------------------------------------------------------------

function resolveConfig(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): ResolvedCmsConfig {
  const basePath = normaliseBasePath(config.basePath ?? defaultBasePath);
  const reserved = new Set(systemTableNames());

  const collections: Record<string, ResolvedCollection> = {};
  for (const [name, definition] of Object.entries(config.collections)) {
    collections[name] = resolveCollection(
      name,
      definition,
      "collection",
      reserved,
    );
  }
  const globals: Record<string, ResolvedCollection> = {};
  for (const [name, definition] of Object.entries(config.globals ?? {})) {
    globals[name] = resolveCollection(name, definition, "global", reserved);
  }

  assertUniqueSlugs({ ...collections, ...globals });
  validateRelations({ ...collections, ...globals });
  validateChat({ ...collections, ...globals });
  validateHookTargets(config, collections, globals);
  validatePlugins(config.plugins ?? []);
  validateI18n(config);
  validateRbac(config);
  validateUploads(config);
  validateAi(config);
  validateWebhooks(config);

  const trashPurge = config.trash?.purgeAfter ?? "30d";
  if (typeof trashPurge === "string") parseDuration(trashPurge, "trash.purgeAfter"); // prettier-ignore

  return {
    basePath,
    database: config.database,
    admin: {
      ...config.admin,
      path: config.admin?.path ?? defaultAdminPath,
    },
    ...(config.rbac === undefined ? {} : { rbac: config.rbac }),
    i18n: {
      locales: config.i18n?.locales ?? "dynamic",
      defaultLocale: config.i18n?.defaultLocale ?? "en",
      ...(config.i18n?.fallback === undefined
        ? {}
        : { fallback: config.i18n.fallback }),
    },
    ...(config.uploads === undefined ? {} : { uploads: config.uploads }),
    ...(config.ai === undefined ? {} : { ai: config.ai }),
    ...(config.webhooks === undefined ? {} : { webhooks: config.webhooks }),
    trash: {
      enabled: config.trash?.enabled ?? true,
      purgeAfter: trashPurge,
    },
    collections,
    globals,
    ...(config.hooks === undefined ? {} : { hooks: config.hooks }),
    ...(config.databaseHooks === undefined
      ? {}
      : { databaseHooks: config.databaseHooks }),
    plugins: config.plugins ?? [],
    migrationsDirectory:
      config.migrations?.directory ?? defaultMigrationsDirectory,
  };
}

function resolveCollection(
  name: string,
  definition: CollectionDefinition | GlobalDefinition,
  kind: "collection" | "global",
  reserved: Set<string>,
): ResolvedCollection {
  if (!nameFormat.test(name)) {
    throw new CmsConfigError(
      `collections.${name}`,
      "a collection name must be lowercase letters, digits and underscores, starting with a letter",
    );
  }
  const slug = definition.slug ?? name.replaceAll("_", "-");
  if (!slugFormat.test(slug)) {
    throw new CmsConfigError(
      `collections.${name}.slug`,
      `"${slug}" is not a URL-safe slug`,
    );
  }
  if (reserved.has(name) || reserved.has(slug)) {
    throw new CmsConfigError(
      `collections.${name}`,
      `"${name}" is a reserved system name; pick another`,
    );
  }

  const fields: Record<string, FieldDefinition> = {};
  for (const [fieldName, field] of Object.entries(definition.fields)) {
    if (!nameFormat.test(fieldName)) {
      throw new CmsConfigError(
        `collections.${name}.fields.${fieldName}`,
        "a field name must be lowercase letters, digits and underscores, starting with a letter",
      );
    }
    // Paths into the document body are dotted, so a dot in a field name would
    // make `where: { "a.b": ... }` ambiguous. The name format already forbids
    // it; this is the reason it does.
    fields[fieldName] = field;
  }

  if (Object.keys(fields).length === 0) {
    throw new CmsConfigError(
      `collections.${name}.fields`,
      "a collection needs at least one field",
    );
  }

  return {
    name,
    slug,
    label: definition.label ?? titleCase(name),
    kind,
    fields,
    access: (definition.access ?? {}) as ResolvedCollection["access"],
    ...(definition.ai === undefined ? {} : { ai: definition.ai }),
    ...(definition.admin === undefined ? {} : { admin: definition.admin }),
  };
}

function assertUniqueSlugs(
  collections: Record<string, ResolvedCollection>,
): void {
  const seen = new Map<string, string>();
  for (const collection of Object.values(collections)) {
    const owner = seen.get(collection.slug);
    if (owner) {
      throw new CmsConfigError(
        `collections.${collection.name}.slug`,
        `"${collection.slug}" is already used by "${owner}"; slugs are URLs and index names`,
      );
    }
    seen.set(collection.slug, collection.name);
  }
}

/**
 * A relation has to point somewhere.
 *
 * Catching this at build time rather than at `depth: 1` means a renamed
 * collection breaks the start-up of the application that renamed it, instead
 * of the page nobody visits until Friday.
 */
function validateRelations(
  collections: Record<string, ResolvedCollection>,
): void {
  const targets = new Set([...Object.keys(collections), ...systemTableNames()]);
  for (const collection of Object.values(collections)) {
    for (const [fieldName, field] of Object.entries(collection.fields)) {
      if (!field.relationTo) continue;
      if (!targets.has(field.relationTo)) {
        throw new CmsConfigError(
          `collections.${collection.name}.fields.${fieldName}`,
          `relation points at "${field.relationTo}", which is not a collection`,
        );
      }
    }
  }
}

/** Chat may only see fields that exist, and may only write fields it can see. */
function validateChat(collections: Record<string, ResolvedCollection>): void {
  for (const collection of Object.values(collections)) {
    const chat = collection.ai?.chat;
    if (!chat) continue;

    for (const field of chat.context) {
      if (!(field in collection.fields)) {
        throw new CmsConfigError(
          `collections.${collection.name}.ai.chat.context`,
          `"${field}" is not a field of this collection`,
        );
      }
    }
    for (const field of chat.writable ?? []) {
      if (!chat.context.includes(field)) {
        throw new CmsConfigError(
          `collections.${collection.name}.ai.chat.writable`,
          `"${field}" is not in context; the chat cannot write a field it cannot read`,
        );
      }
    }
  }
}

/** A hook on a collection that does not exist is a typo, and typos are silent. */
function validateHookTargets(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
  collections: Record<string, ResolvedCollection>,
  globals: Record<string, ResolvedCollection>,
): void {
  for (const name of Object.keys(config.databaseHooks ?? {})) {
    if (!(name in collections) && !(name in globals)) {
      throw new CmsConfigError(
        `databaseHooks.${name}`,
        "no collection or global with this name",
      );
    }
  }
}

function validatePlugins(plugins: CmsPlugin<never>[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) {
      throw new CmsConfigError(
        `plugins.${plugin.id}`,
        "two plugins share this id",
      );
    }
    seen.add(plugin.id);
  }

  // Route collisions are detected the way Better Auth does it: at start-up,
  // naming both sides, rather than letting the last registration win.
  const routes = new Map<string, string>();
  for (const plugin of plugins) {
    for (const route of plugin.routes ?? []) {
      const key = `${route.method} ${route.path}`;
      const owner = routes.get(key);
      if (owner) {
        throw new CmsConfigError(
          `plugins.${plugin.id}.routes`,
          `"${key}" is already registered by "${owner}"`,
        );
      }
      routes.set(key, plugin.id);
    }
  }
}

function validateI18n(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const i18n = config.i18n;
  if (!i18n) return;

  if (Array.isArray(i18n.locales)) {
    const codes = i18n.locales.map((locale) => locale.code);
    if (new Set(codes).size !== codes.length) {
      throw new CmsConfigError("i18n.locales", "duplicate locale codes");
    }
    if (!codes.includes(i18n.defaultLocale)) {
      throw new CmsConfigError(
        "i18n.defaultLocale",
        `"${i18n.defaultLocale}" is not in the configured locales`,
      );
    }
  }

  const fallback = i18n.fallback;
  if (fallback && fallback.mode === "chain") {
    for (const [locale, chain] of Object.entries(fallback.chain)) {
      if (chain.includes(locale)) {
        throw new CmsConfigError(
          `i18n.fallback.chain.${locale}`,
          "a locale cannot fall back to itself",
        );
      }
    }
  }
}

function validateRbac(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const rbac = config.rbac;
  if (!rbac) return;

  for (const [role, permissions] of Object.entries(rbac.roles)) {
    for (const permission of permissions) {
      if (permission === "*") continue;
      if (!/^[a-z0-9_*-]+:[a-z0-9_*-]+$/.test(permission)) {
        throw new CmsConfigError(
          `rbac.roles.${role}`,
          `"${permission}" is not a permission; use "collection:action" or "*"`,
        );
      }
    }
  }
  if (rbac.defaultRole && !(rbac.defaultRole in rbac.roles)) {
    throw new CmsConfigError(
      "rbac.defaultRole",
      `"${rbac.defaultRole}" is not one of the configured roles`,
    );
  }
}

function validateUploads(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const uploads = config.uploads;
  if (!uploads) return;

  if (uploads.limits?.maxFileSize) {
    parseByteSize(uploads.limits.maxFileSize, "uploads.limits.maxFileSize");
  }
  const purgeAfter = uploads.retention?.purgeAfter;
  if (typeof purgeAfter === "string") {
    parseDuration(purgeAfter, "uploads.retention.purgeAfter");
  }

  const quality = uploads.images?.quality;
  if (quality !== undefined && (quality < 1 || quality > 100)) {
    throw new CmsConfigError("uploads.images.quality", "must be between 1 and 100"); // prettier-ignore
  }
}

function validateAi(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const ai = config.ai;
  if (!ai) return;

  if (Object.keys(ai.auth).length === 0) {
    throw new CmsConfigError(
      "ai.auth",
      "AI is configured without credentials; remove the section to disable it",
    );
  }
  // A model whose provider has no credentials would fail on the first click
  // in the panel, which is the worst possible moment to learn about it.
  const configured = new Set(Object.keys(ai.auth));
  if (!configured.has(ai.defaultModel.provider)) {
    throw new CmsConfigError(
      "ai.defaultModel.provider",
      `"${ai.defaultModel.provider}" has no entry in ai.auth`,
    );
  }
  const chatProvider = ai.chat?.model?.provider;
  if (chatProvider && !configured.has(chatProvider)) {
    throw new CmsConfigError(
      "ai.chat.model.provider",
      `"${chatProvider}" has no entry in ai.auth`,
    );
  }
}

function validateWebhooks(
  config: HeyoCmsConfig<CollectionsConfig, GlobalsConfig>,
): void {
  const webhooks = config.webhooks;
  if (!webhooks?.enabled) return;

  if (!webhooks.signing?.secret) {
    // An unsigned webhook is one a consumer cannot verify, which makes every
    // receiver a public write endpoint.
    throw new CmsConfigError(
      "webhooks.signing.secret",
      "webhooks must be signed; set a secret",
    );
  }
  if (webhooks.delivery?.timeout) {
    parseDuration(webhooks.delivery.timeout, "webhooks.delivery.timeout");
  }
}

/**
 * The mount point is stripped from incoming requests, so it has to be a plain
 * absolute path. Same rule as every other Heyo package.
 */
function normaliseBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    throw new CmsConfigError("basePath", 'must start with "/"');
  }
  if (/[?#]/.test(trimmed)) {
    throw new CmsConfigError("basePath", "cannot contain a query or fragment");
  }
  if (trimmed.includes("//")) {
    throw new CmsConfigError("basePath", "cannot contain empty segments");
  }
  const normalised = trimmed.replace(/\/+$/, "");
  if (normalised.length === 0) {
    throw new CmsConfigError("basePath", 'cannot be "/"');
  }
  return normalised;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

function inspectCollections(config: ResolvedCmsConfig): CollectionInspection[] {
  return [
    ...Object.values(config.collections),
    ...Object.values(config.globals),
  ].map((collection) => ({
    name: collection.name,
    slug: collection.slug,
    kind: collection.kind,
    fields: Object.entries(collection.fields).map(([name, field]) => ({
      name,
      type: field.type,
      localized: field.localized,
      required: field.required,
    })),
  }));
}

/**
 * The order hooks will actually run in.
 *
 * Plugin hooks first, by priority, then the configuration's own — so a
 * developer can always have the last word over a plugin they installed
 * (section 5). Printing it is the difference between a pipeline and a
 * mystery.
 */
function hookPipeline(config: ResolvedCmsConfig): HookPipelineEntry[] {
  const entries: HookPipelineEntry[] = [];

  for (const plugin of config.plugins) {
    for (const hook of plugin.hooks ?? []) {
      entries.push({
        collection: hook.collection,
        operation: hook.operation,
        timing: hook.timing,
        source: plugin.id,
        priority: hook.priority ?? 0,
      });
    }
  }

  for (const [collection, hooks] of Object.entries(
    config.databaseHooks ?? {},
  )) {
    for (const operation of ["create", "update", "delete"] as const) {
      const definition = hooks?.[operation];
      if (!definition) continue;
      if (definition.before) {
        entries.push({ collection, operation, timing: "before", source: "config", priority: 100 }); // prettier-ignore
      }
      if (definition.after) {
        entries.push({ collection, operation, timing: "after", source: "config", priority: 100 }); // prettier-ignore
      }
    }
  }

  return entries.sort(
    (a, b) =>
      a.collection.localeCompare(b.collection) ||
      a.operation.localeCompare(b.operation) ||
      a.timing.localeCompare(b.timing) ||
      a.priority - b.priority ||
      a.source.localeCompare(b.source),
  );
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

/** Convenience for tests and tooling that need an actor without a session. */
export function systemActor(id = "system"): Actor {
  return { id, source: "session", roles: ["admin"], permissions: ["*"] };
}
