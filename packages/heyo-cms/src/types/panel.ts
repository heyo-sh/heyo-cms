import type { EditorSchemaDescription } from "./editor";
import type { JsonValue } from "./json";

/**
 * What the panel is told about this deployment (stage 8).
 *
 * The panel is one static bundle serving every configuration, so everything
 * it renders — which collections exist, which fields they carry, which
 * languages are registered, whether there is a trash — has to arrive as data.
 * `GET /panel` is that payload, and this file is its type.
 *
 * Two rules decide what may appear here:
 *
 * 1. **Only what survives JSON.** An access rule, a `condition` and a hook
 *    are functions; they stay on the server and the panel is told *that they
 *    exist* instead of being handed something it cannot run.
 * 2. **Resolved, not raw.** `purgeAfter: "30d"` is also given in milliseconds
 *    because a countdown should not re-implement the duration grammar, and a
 *    locale arrives with the name of its language, because `pl` is not a
 *    label a switcher can show.
 */

/** One entry in the AI menu next to a field. Keys come from `field.ai`. */
export interface PanelFieldAiAction {
  key: string;
  label: string;
  /** Present when the action overrides `ai.defaultModel`. */
  model?: { provider: string; model: string };
}

/**
 * Whether the caller may see and write a field.
 *
 * Evaluated with the actor but **without a record**, because the panel asks
 * before a document is chosen — so a rule that reads `record` answers for the
 * generic case and the engine remains the authority on the specific one. A
 * rule that throws without a record counts as permitted here and is still
 * enforced on the write.
 */
export interface PanelAccessFlags {
  read: boolean;
  update: boolean;
}

export interface PanelField {
  name: string;
  type: string;
  label: string;
  description?: string;
  required: boolean;
  localized: boolean;
  readOnly: boolean;
  unique: boolean;
  /** Server-side deterministic generator is available for this field. */
  generate: boolean;
  defaultValue?: JsonValue;
  /**
   * The field type's own options, minus everything that is a function.
   *
   * `select` carries its choices here, `relation` its target, `media` its
   * accept list — the panel reads them by field type, exactly as the field
   * type's `Input` would.
   */
  options: Record<string, JsonValue>;
  admin: {
    placeholder?: string;
    hidden: boolean;
  };
  ai: PanelFieldAiAction[];
  access: PanelAccessFlags;
  /** A `list`'s row: the fields every row has, in order. */
  fields?: PanelField[];
}

export interface PanelCollection {
  name: string;
  slug: string;
  label: string;
  kind: "collection" | "global";
  group?: string;
  description?: string;
  /** Field used as the row title. Resolved here so the panel never guesses. */
  useAsTitle: string | null;
  defaultColumns: string[];
  fields: PanelField[];
  /**
   * What this actor may do, evaluated without a record.
   *
   * Drives whether the panel offers a "New" button, not whether the write
   * succeeds: a rule that depends on the document is answered properly by the
   * engine when the document exists.
   */
  can: { read: boolean; create: boolean; update: boolean; delete: boolean };
}

export interface PanelLocale {
  code: string;
  /** The English name of the language, looked up from the code. */
  name: string;
  rtl: boolean;
  isDefault: boolean;
}

/**
 * The languages, as the switcher needs them.
 *
 * Configuration, not a registry: `i18n.locales` is a list of codes, so the
 * panel renders it and never offers to edit it.
 */
export interface PanelI18n {
  locales: PanelLocale[];
  defaultLocale: string;
}

export interface PanelMedia {
  enabled: boolean;
  /** Declared sizes. Nothing else may be requested from a URL. */
  variants: string[];
  variantMode: "on-demand" | "pregenerate" | null;
  focalPoint: boolean;
  crop: boolean;
  accept: string[];
  maxFileSize: string | null;
  maxFileSizeBytes: number | null;
  /** How long an unused file keeps serving, for the countdown. */
  purgeAfter: string | null;
  purgeAfterMs: number | null;
}

export interface PanelTrash {
  enabled: boolean;
  purgeAfter: string | null;
  purgeAfterMs: number | null;
}

export interface PanelAuth {
  methods: string[];
  twoFactor: boolean;
  apiKeys: boolean;
  sso: string | null;
  /**
   * Whether the magic-link and password-reset routes exist at all.
   *
   * They are registered only when `admin.auth.deliverToken` is configured, so
   * a sign-in screen that offered them unconditionally would offer a 404.
   */
  magicLink: boolean;
  passwordReset: boolean;
  /**
   * Whether this deployment has no account yet.
   *
   * `true` turns the sign-in screen into a "claim this CMS" screen: there is
   * nobody to sign in as, and `POST /auth/setup` is open for exactly as long
   * as that sentence stays true.
   */
  setupRequired: boolean;
}

export interface PanelRbac {
  enabled: boolean;
  roles: string[];
  customRoles: boolean;
}

/**
 * AI, as the panel sees it.
 *
 * `configured` is "there is an `ai` section"; `runtime` is "something answers
 * the AI routes". They are still two flags rather than one because they fail
 * for different reasons — no section, or no credentials for the provider the
 * default model names — and a greyed-out button with no explanation is a bug
 * report.
 */
export interface PanelAi {
  configured: boolean;
  runtime: boolean;
  defaultModel: { provider: string; model: string } | null;
  /**
   * Whether the panel-wide assistant is switched on for this deployment.
   *
   * The composer is rendered either way. A disabled composer that names its
   * reason is a feature somebody can fix; a composer that is simply not there
   * is a feature nobody reports as missing.
   */
  assistant: boolean;
  /** Effective assistant settings. Instructions themselves never leave the server. */
  assistantSettings: {
    model: { provider: string; model: string };
    maxTurns: number;
    maxToolCalls: number;
    timeoutMs: number;
    customInstructions: boolean;
  } | null;
  /** Every registered action id, including the ones plugins added. */
  actions: string[];
  /** Whether provider keys can be managed from the settings screen. */
  managedKeys: boolean;
}

export interface PanelWebhooks {
  enabled: boolean;
  managedInAdmin: boolean;
  /** Whether the delivery endpoints answer. */
  runtime: boolean;
  /** The event catalogue, so the subscription form is a picker. */
  events: string[];
}

/**
 * A plugin, as the panel can act on it.
 *
 * `scripts` is the whole of the client extension story: the panel is one
 * static bundle compiled before any plugin existed, so a plugin that wants
 * to render something ships a script the panel loads at boot, and that
 * script registers a field control or a view against the global the panel
 * exposes. The alternative — shipping React components through JSON — is not
 * a thing that can work.
 */
export interface PanelPlugin {
  id: string;
  navItems: { label: string; path: string; icon?: string }[];
  /** URLs, relative to `basePath` unless absolute. Loaded in order. */
  scripts: string[];
  /** Field types the plugin says it renders, for a diagnostic when it fails. */
  fields: string[];
}

export interface PanelConfig {
  title: string;
  /** Where the API is mounted, absolute: every request the panel makes. */
  basePath: string;
  /** Where the panel itself is mounted, absolute: its router's prefix. */
  panelPath: string;
  collections: PanelCollection[];
  globals: PanelCollection[];
  i18n: PanelI18n;
  media: PanelMedia;
  trash: PanelTrash;
  auth: PanelAuth;
  rbac: PanelRbac;
  ai: PanelAi;
  webhooks: PanelWebhooks;
  /** Rich-text nodes and marks, including the ones plugins registered. */
  editor: EditorSchemaDescription;
  /** Installed plugins and what they contribute to this screen. */
  plugins: PanelPlugin[];
}
