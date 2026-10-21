import { assistantLimits } from "./ai/assistant/limits";
import { registeredAiActions } from "./ai/registry";
import { describeEditorSchema } from "./editor/index";
import { parseByteSize, parseDuration } from "./duration";
import type { Actor } from "./types/actor";
import type {
  CollectionAccess,
  ResolvedCmsConfig,
  ResolvedCollection,
} from "./types/config";
import type {
  FieldAccessRule,
  FieldAiAction,
  FieldDefinition,
} from "./types/fields";
import type { JsonValue } from "./types/json";
import type { LocaleRecord } from "./types/locales";
import type {
  PanelCollection,
  PanelConfig,
  PanelField,
  PanelFieldAiAction,
  PanelI18n,
} from "./types/panel";

/**
 * The configuration, as the panel can read it.
 *
 * One bundle serves every deployment, so the panel learns what to render at
 * runtime rather than at build time — and `GET /panel` hands it this. The
 * work here is turning a configuration full of closures into data: a rule is
 * a function and cannot be shipped, so it is *evaluated* for the caller and
 * the answer travels instead. That answer is advisory by construction. The
 * engine decides every actual read and write; this only decides whether the
 * panel draws a button that would be refused.
 *
 * Nothing secret leaves: no provider tokens, no signing secrets, no hook
 * bodies. `ai.auth` is reported as "configured", never as its keys.
 */
export function describePanel(
  config: ResolvedCmsConfig,
  actor: Actor | null,
  locales: LocaleRecord[],
  state: PanelState = {},
): PanelConfig {
  const auth = config.admin.auth;
  const methods = new Set(auth?.methods ?? []);
  const images = config.uploads?.images;
  const retention = config.uploads?.retention;
  const trashPurge = config.trash.purgeAfter;
  const mediaPurge = retention?.purgeAfter ?? false;
  const maxFileSize = config.uploads?.limits?.maxFileSize ?? null;

  return {
    title: config.admin.title ?? "Heyo CMS",
    basePath: config.basePath,
    panelPath: `${config.basePath}${config.admin.path}`,
    collections: Object.values(config.collections).map((collection) =>
      describeCollection(collection, actor),
    ),
    globals: Object.values(config.globals).map((global) =>
      describeCollection(global, actor),
    ),
    i18n: describeI18n(config, locales),
    media: {
      enabled: config.uploads !== undefined,
      variants: Object.keys(images?.variants?.sizes ?? {}),
      variantMode: images?.variants?.mode ?? null,
      focalPoint: images?.focalPoint === true,
      crop: images?.crop === true,
      accept: config.uploads?.limits?.accept ?? [],
      maxFileSize,
      maxFileSizeBytes: maxFileSize === null ? null : parseByteSize(maxFileSize), // prettier-ignore
      purgeAfter: mediaPurge === false ? null : mediaPurge,
      purgeAfterMs: mediaPurge === false ? null : parseDuration(mediaPurge),
    },
    trash: {
      enabled: config.trash.enabled,
      purgeAfter: trashPurge === false ? null : trashPurge,
      purgeAfterMs: trashPurge === false ? null : parseDuration(trashPurge),
    },
    auth: {
      methods: [...methods],
      twoFactor: auth?.twoFactor === true,
      apiKeys: auth?.apiKeys?.enabled === true,
      sso: auth?.sso?.issuer ?? null,
      // The routes exist only when a delivery function does, so the sign-in
      // screen must not offer a door that answers 404 (stage 7).
      magicLink: methods.has("magic-link") && auth?.deliverToken !== undefined,
      passwordReset:
        methods.has("password") && auth?.deliverToken !== undefined,
      // Configuration cannot answer this one: "are there any accounts" is a
      // row count, so the route that serves the panel looks it up and hands
      // the answer in.
      setupRequired: state.setupRequired === true,
    },
    rbac: {
      enabled: config.rbac !== undefined,
      roles: Object.keys(config.rbac?.roles ?? {}),
      customRoles: config.rbac?.customRoles === true,
    },
    ai: {
      configured: config.ai !== undefined,
      // The routes exist whenever the section does: `aiRoutes()` is built
      // from the same configuration. What can still be missing at this point
      // is a credential, and that is a 500 with a sentence rather than
      // something to grey a button out for.
      runtime: config.ai !== undefined,
      defaultModel: config.ai?.defaultModel ?? null,
      assistant:
        config.ai !== undefined && config.ai.assistant?.enabled !== false,
      assistantSettings:
        config.ai !== undefined && config.ai.assistant?.enabled !== false
          ? {
              model: config.ai.assistant?.model ?? config.ai.defaultModel,
              maxTurns:
                config.ai.assistant?.maxTurns ?? assistantLimits.maxTurns,
              maxToolCalls:
                config.ai.assistant?.maxToolCalls ??
                assistantLimits.maxToolCalls,
              timeoutMs:
                config.ai.assistant?.timeoutMs ?? assistantLimits.timeoutMs,
              customInstructions: Boolean(config.ai.assistant?.instructions),
            }
          : null,
      actions: registeredAiActions(),
      managedKeys: config.ai?.storage?.secret !== undefined,
    },
    webhooks: {
      enabled: config.webhooks?.enabled === true,
      managedInAdmin: config.webhooks?.managedInAdmin !== false,
      runtime: config.webhooks?.enabled === true,
      events: webhookEventCatalogue(config),
    },
    editor: describeEditorSchema(),
    plugins: config.plugins.map((plugin) => ({
      id: plugin.id,
      navItems: plugin.admin?.navItems ?? [],
      scripts: plugin.admin?.scripts ?? [],
      fields: Object.keys(plugin.admin?.fields ?? {}),
    })),
  };
}

/**
 * The parts of the first screen that are facts rather than configuration.
 *
 * Everything else here is derived from `ResolvedCmsConfig`, which is why this
 * function is synchronous and testable without a database. The one thing the
 * sign-in screen needs that no configuration knows is whether the deployment
 * has any accounts at all, so the caller looks it up and passes it.
 */
export interface PanelState {
  setupRequired?: boolean;
}

/**
 * What a subscription form can offer.
 *
 * The catalogue from section 7, plus the families, plus the per-collection
 * shorthands nobody should have to remember the spelling of. Built here
 * rather than in the panel because the collection list is configuration and
 * the panel is a bundle.
 */
function webhookEventCatalogue(config: ResolvedCmsConfig): string[] {
  if (config.webhooks?.enabled !== true) return [];
  const events = [
    "*",
    "document.*",
    "document.created",
    "document.updated",
    "document.field.changed",
    "document.scheduled",
    "document.schedule.applied",
    "document.schedule.cancelled",
    "document.trashed",
    "document.restored",
    "document.purged",
    "media.*",
    "media.uploaded",
    "media.updated",
    "media.orphaned",
    "media.reclaimed",
    "media.purged",
    "ai.task.completed",
    "ai.task.failed",
    "ai.agent.completed",
    "ai.agent.failed",
    "ai.agent.mutation.applied",
    "user.invited",
    "user.joined",
    "user.removed",
    "role.changed",
    "apikey.created",
    "apikey.revoked",
    "job.failed",
  ];
  return events;
}

function describeI18n(
  config: ResolvedCmsConfig,
  locales: LocaleRecord[],
): PanelI18n {
  return {
    locales: locales.map((locale) => ({
      code: locale.code,
      name: locale.name,
      rtl: locale.rtl,
      isDefault: locale.isDefault,
    })),
    defaultLocale: config.i18n.defaultLocale,
  };
}

function describeCollection(
  collection: ResolvedCollection,
  actor: Actor | null,
): PanelCollection {
  const fields = Object.entries(collection.fields).map(([name, field]) =>
    describeField(name, field, actor),
  );

  return {
    name: collection.name,
    slug: collection.slug,
    label: collection.label,
    kind: collection.kind,
    ...(collection.admin?.group === undefined
      ? {}
      : { group: collection.admin.group }),
    ...(collection.admin?.description === undefined
      ? {}
      : { description: collection.admin.description }),
    useAsTitle: titleField(collection),
    defaultColumns: collection.admin?.defaultColumns ?? [],
    fields,
    can: {
      read: mayOperate(collection.access, "read", actor),
      create:
        collection.kind === "collection" &&
        mayOperate(collection.access, "create", actor),
      update: mayOperate(collection.access, "update", actor),
      delete:
        collection.kind === "collection" &&
        mayOperate(collection.access, "delete", actor),
    },
  };
}

/**
 * The column a row is named after.
 *
 * `admin.useAsTitle`, then a field actually called `title` or `name`, then
 * the first text-ish field, then nothing — at which point the panel shows the
 * id, which is always true if rarely useful.
 */
function titleField(collection: ResolvedCollection): string | null {
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

function describeField(
  name: string,
  field: FieldDefinition,
  actor: Actor | null,
): PanelField {
  const options = field.options;
  const admin = field.admin ?? {};

  return {
    name,
    type: field.type,
    label: typeof options.label === "string" ? options.label : humanise(name),
    ...(typeof options.description === "string"
      ? { description: options.description }
      : {}),
    required: field.required,
    localized: field.localized,
    readOnly: options.readOnly === true,
    unique: options.unique === true,
    generate: field.generate !== undefined,
    ...(field.defaultValue === undefined
      ? {}
      : { defaultValue: field.defaultValue }),
    options: serialisableOptions(options),
    admin: {
      ...(typeof admin.placeholder === "string"
        ? { placeholder: admin.placeholder }
        : {}),
      hidden: admin.hidden === true,
    },
    ai: describeFieldAi(field),
    access: {
      read: mayTouchField(field.access?.read, actor),
      update:
        options.readOnly === true
          ? false
          : mayTouchField(field.access?.update, actor),
    },
  };
}

function describeFieldAi(field: FieldDefinition): PanelFieldAiAction[] {
  const actions: Record<string, FieldAiAction | true> = {
    ...(field.ai ?? {}),
    ...(field.aiGenerate === undefined ? {} : { generate: field.aiGenerate }),
  };
  return Object.entries(actions).map(([key, action]) => ({
    key,
    label: action === true ? humanise(key) : (action.label ?? humanise(key)),
    ...(action === true || action.model === undefined
      ? {}
      : { model: action.model }),
  }));
}

/**
 * The field type's options, minus everything that is not data.
 *
 * `select` needs its choices in the browser, `relation` its target, `number`
 * its bounds — and all of them live in the same loosely-typed bag, next to
 * closures the panel must never receive. Rather than maintain a list of safe
 * keys per field type, which would silently drop a third-party field's
 * options (stage 9), anything that survives JSON is kept and anything that
 * does not is dropped.
 */
function serialisableOptions(
  options: Record<string, unknown>,
): Record<string, JsonValue> {
  const hoisted = new Set([
    "label",
    "description",
    "localized",
    "required",
    "unique",
    "index",
    "readOnly",
    "ai",
    "aiGenerate",
    "generate",
    "access",
    "admin",
  ]);

  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(options)) {
    if (hoisted.has(key)) continue;
    const json = toJson(value);
    if (json !== undefined) result[key] = json;
  }
  return result;
}

function toJson(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map(toJson).filter((item) => item !== undefined);
        return items as JsonValue;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      const object: Record<string, JsonValue> = {};
      for (const [key, item] of entries) {
        const json = toJson(item);
        if (json !== undefined) object[key] = json;
      }
      return object;
    }
    default:
      // Functions, symbols and `undefined`: not data, not sent.
      return undefined;
  }
}

/**
 * Asks a collection rule without a record.
 *
 * A missing rule is "yes" here and the engine's business otherwise: when
 * `rbac` is configured the engine requires `collection:action` instead, and
 * this function is not where that is decided. A rule that returns a `Where`
 * means "some rows", which for a button means yes.
 */
function mayOperate(
  access: CollectionAccess,
  operation: "read" | "create" | "update" | "delete",
  actor: Actor | null,
): boolean {
  const rule = access[operation];
  if (!rule) return true;
  try {
    const result = rule({ actor, operation, locale: null });
    // An async rule cannot be awaited in a synchronous description; the
    // optimistic answer is the honest one, since the engine runs it properly.
    if (result instanceof Promise) return true;
    return result !== false;
  } catch {
    return true;
  }
}

function mayTouchField(
  rule: FieldAccessRule | undefined,
  actor: Actor | null,
): boolean {
  if (!rule) return true;
  try {
    return rule({ actor, locale: null });
  } catch {
    return true;
  }
}

/** `seoTitle` → `SEO title`-ish. A label beats a camelCase key in a form. */
function humanise(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
