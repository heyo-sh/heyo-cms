import type { ZodType } from "zod";

import type { Actor } from "./actor";
import type { ComponentType, JsonObject, JsonValue } from "./json";
import type { ColumnDefinition } from "./schema";

/** A model reference. The provider id comes from the pi catalogue (section 8). */
export interface AiModelRef {
  provider: string;
  model: string;
}

/**
 * One AI action on one field — one entry in the menu next to that field.
 *
 * Nothing is shared between actions: each has its own prompt, its own context
 * and optionally its own model. A missing key means the action does not exist
 * in the panel at all, which is how AI stays opt-in per field (section 8).
 */
export interface FieldAiAction {
  /** Defaults to the action key. */
  label?: string;
  prompt?: string;
  /** Fields of the document the model is allowed to see for this action. */
  context?: string[];
  model?: AiModelRef;
  maxLength?: number;
}

/**
 * `true` turns on a built-in action with its default prompt; an object
 * customises it. Unknown keys are custom actions registered with
 * `defineAiAction()`.
 */
export type FieldAiConfig = Record<string, FieldAiAction | true>;

/** What an access rule is told about the row it is deciding on. */
export interface FieldAccessContext {
  actor: Actor | null;
  record?: Record<string, unknown>;
  locale: string | null;
}

export type FieldAccessRule = (context: FieldAccessContext) => boolean;

/**
 * Field-level access.
 *
 * There is no `access.publish` anywhere in the engine: who may publish is
 * whoever may write the `status` field, which is exactly this (section 11).
 */
export interface FieldAccess {
  read?: FieldAccessRule;
  update?: FieldAccessRule;
}

/** Panel-only presentation. The engine never reads these. */
export interface FieldAdminOptions {
  placeholder?: string;
  hidden?: boolean;
}

/** Server-side, deterministic generator. `fields` contains only readable sibling fields. */
export type FieldGenerator = (args: {
  fields: JsonObject;
  locale: string;
}) => JsonValue | Promise<JsonValue>;

/** Options every field accepts, whatever its type. */
export interface FieldOptions {
  label?: string;
  description?: string;
  /** Stored as `{ [locale]: value }` inside the document body. */
  localized?: boolean;
  required?: boolean;
  unique?: boolean;
  index?: boolean;
  readOnly?: boolean;
  /** Generate this field from the current form values, without AI. */
  generate?: FieldGenerator;
  /** Generate an AI suggestion for this particular field; context names sibling fields. */
  aiGenerate?: FieldAiAction;
  /** @deprecated Use aiGenerate for field generation. Other legacy actions remain supported. */
  ai?: FieldAiConfig;
  access?: FieldAccess;
  admin?: FieldAdminOptions;
}

/**
 * A field as the engine sees it after a builder has validated its options.
 *
 * `TValue` is the value for a single locale. A localized field stores a record
 * keyed by locale code in the document body, but every read resolves one
 * locale before the value reaches a hook, the API or a template, so a
 * consumer never has to know which fields are translated.
 */
export interface FieldDefinition<TValue = unknown> {
  readonly type: string;
  readonly options: FieldOptions & Record<string, unknown>;
  /** Validates one locale's value. Validation is zod, never a hook. */
  readonly schema: ZodType<TValue>;
  readonly column: ColumnDefinition;
  readonly localized: boolean;
  readonly required: boolean;
  readonly defaultValue?: JsonValue;
  readonly generate?: FieldGenerator;
  readonly aiGenerate?: FieldAiAction;
  readonly ai?: FieldAiConfig;
  readonly access?: FieldAccess;
  readonly admin?: FieldAdminOptions;
  /** Collection targeted by a relation field; drives the batch loader. */
  readonly relationTo?: string;
}

export interface FieldInputProps<TValue> {
  value: TValue;
  onChange: (value: TValue) => void;
  field: FieldDefinition<TValue>;
  name: string;
  locale: string | null;
  disabled?: boolean;
  readOnly?: boolean;
  error?: string;
}

export interface FieldCellProps<TValue> {
  value: TValue;
  field: FieldDefinition<TValue>;
  name: string;
}

/**
 * A registered field type.
 *
 * Built-in fields are declared with exactly this contract through
 * `defineField()`, so a third-party field is never a second-class citizen
 * (stage 9). `Input` and `Cell` are optional: the core must not depend on a
 * renderer, and the panel falls back to the input registered for the
 * underlying column type.
 */
export interface FieldType<
  TValue,
  TOptions extends FieldOptions = FieldOptions,
> {
  name: string;
  schema(options: TOptions): ZodType<TValue>;
  column(options: TOptions): ColumnDefinition;
  /** Validates the options object itself, at config build time. */
  optionsSchema?: ZodType<TOptions>;
  /** AI action keys this type can expose, used to reject typos in `ai`. */
  aiActions?: string[];
  Input?: ComponentType<FieldInputProps<TValue>>;
  Cell?: ComponentType<FieldCellProps<TValue>>;
}

/** The value type a field definition carries, for document inference. */
export type InferFieldValue<TField> =
  TField extends FieldDefinition<infer TValue> ? TValue : never;

/** A collection's fields, keyed by field name. */
export type FieldsConfig = Record<string, FieldDefinition>;
