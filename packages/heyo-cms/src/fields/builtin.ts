import { z } from "zod";

import type { FieldDefinition, FieldOptions } from "../types/fields";
import type { JsonObject, JsonValue } from "../types/json";
import { defineField, type FieldValue } from "./registry";

// ---------------------------------------------------------------------------
// Shared option pieces
// ---------------------------------------------------------------------------

/**
 * Options are parsed loosely on purpose.
 *
 * Every field accepts the common options from `FieldOptions` plus its own, and
 * a strict schema would reject `label` or `ai` in each type separately. The
 * builder validates what it understands and carries the rest through.
 */
const commonOptions = z.looseObject({
  label: z.string().optional(),
  description: z.string().optional(),
  localized: z.boolean().optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  index: z.boolean().optional(),
  readOnly: z.boolean().optional(),
});

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

export interface TextOptions extends FieldOptions {
  default?: string;
  minLength?: number;
  maxLength?: number;
  /** Source string for the pattern; kept serialisable for the snapshot. */
  pattern?: string;
}

export const text = defineField<string, TextOptions>({
  name: "text",
  optionsSchema: commonOptions.extend({
    default: z.string().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    pattern: z.string().optional(),
  }) as unknown as z.ZodType<TextOptions>,
  schema: (options) => {
    let schema = z.string();
    if (options.minLength !== undefined) schema = schema.min(options.minLength);
    if (options.maxLength !== undefined) schema = schema.max(options.maxLength);
    if (options.pattern !== undefined) {
      schema = schema.regex(new RegExp(options.pattern));
    }
    return schema;
  },
  column: (options) => ({
    type: "text",
    ...(options.default === undefined ? {} : { default: options.default }),
  }),
  aiActions: ["generate", "improve", "summarize", "translate"],
});

export interface TextareaOptions extends TextOptions {
  rows?: number;
}

export const textarea = defineField<string, TextareaOptions>({
  name: "textarea",
  optionsSchema: commonOptions.extend({
    default: z.string().optional(),
    maxLength: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  }) as unknown as z.ZodType<TextareaOptions>,
  schema: (options) =>
    options.maxLength === undefined
      ? z.string()
      : z.string().max(options.maxLength),
  column: () => ({ type: "text" }),
  aiActions: ["generate", "improve", "summarize", "translate"],
});

// ---------------------------------------------------------------------------
// richText
// ---------------------------------------------------------------------------

/** A ProseMirror document. TipTap writes it, the serialisers read it. */
export type RichTextValue = JsonObject;

export interface RichTextOptions extends FieldOptions {
  /** Editor nodes allowed in this field; the panel hides the rest. */
  nodes?: string[];
  default?: RichTextValue;
}

export const richText = defineField<RichTextValue, RichTextOptions>({
  name: "richText",
  optionsSchema: commonOptions.extend({
    nodes: z.array(z.string()).optional(),
  }) as unknown as z.ZodType<RichTextOptions>,
  schema: () =>
    z.looseObject({ type: z.string() }) as unknown as z.ZodType<RichTextValue>,
  column: () => ({ type: "json" }),
  aiActions: ["generate", "improve", "summarize", "translate"],
});

// ---------------------------------------------------------------------------
// number, boolean, date
// ---------------------------------------------------------------------------

export interface NumberOptions extends FieldOptions {
  default?: number;
  min?: number;
  max?: number;
  integer?: boolean;
}

export const number = defineField<number, NumberOptions>({
  name: "number",
  optionsSchema: commonOptions.extend({
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
  }) as unknown as z.ZodType<NumberOptions>,
  schema: (options) => {
    let schema = options.integer === true ? z.number().int() : z.number();
    if (options.min !== undefined) schema = schema.min(options.min);
    if (options.max !== undefined) schema = schema.max(options.max);
    return schema;
  },
  column: (options) => ({
    type: options.integer === true ? "integer" : "real",
    ...(options.default === undefined ? {} : { default: options.default }),
  }),
});

export interface BooleanOptions extends FieldOptions {
  default?: boolean;
}

export const boolean = defineField<boolean, BooleanOptions>({
  name: "boolean",
  optionsSchema: commonOptions.extend({
    default: z.boolean().optional(),
  }) as unknown as z.ZodType<BooleanOptions>,
  schema: () => z.boolean(),
  column: (options) => ({
    type: "boolean",
    ...(options.default === undefined ? {} : { default: options.default }),
  }),
});

export interface DateOptions extends FieldOptions {
  default?: string;
  /** `date` hides the clock in the panel; storage is identical. */
  mode?: "date" | "datetime";
}

/**
 * Dates are ISO strings, not `Date` objects.
 *
 * The value travels through JSON on every path the engine has — storage, REST,
 * webhook payloads — and a string survives all of them unchanged. Converting
 * at the edges would mean three places that can disagree about time zones.
 */
export const date = defineField<string, DateOptions>({
  name: "date",
  optionsSchema: commonOptions.extend({
    default: z.string().optional(),
    mode: z.enum(["date", "datetime"]).optional(),
  }) as unknown as z.ZodType<DateOptions>,
  schema: () =>
    z
      .string()
      .refine(
        (value) => !Number.isNaN(Date.parse(value)),
        "must be an ISO 8601 date",
      ),
  column: () => ({ type: "timestamp" }),
});

// ---------------------------------------------------------------------------
// select, multiselect
// ---------------------------------------------------------------------------

export type SelectChoice = string | { label: string; value: string };

export interface SelectOptions extends FieldOptions {
  options: readonly SelectChoice[];
  default?: string;
}

/** Literal choices become a union in the document type. */
export type SelectValue<TOptions extends { options: readonly SelectChoice[] }> =
  TOptions["options"][number] extends infer TChoice
    ? TChoice extends string
      ? TChoice
      : TChoice extends { value: infer TValue }
        ? TValue
        : never
    : never;

const choiceValues = (choices: readonly SelectChoice[]): string[] =>
  choices.map((choice) => (typeof choice === "string" ? choice : choice.value));

const selectOptionsSchema = commonOptions.extend({
  options: z
    .array(
      z.union([
        z.string(),
        z.strictObject({ label: z.string(), value: z.string() }),
      ]),
    )
    .min(1),
  default: z.string().optional(),
});

const selectBuilder = defineField<string, SelectOptions>({
  name: "select",
  optionsSchema: selectOptionsSchema as unknown as z.ZodType<SelectOptions>,
  schema: (options) => z.enum(choiceValues(options.options) as [string]),
  column: (options) => ({
    type: "text",
    ...(options.default === undefined ? {} : { default: options.default }),
  }),
});

/**
 * A plain choice field.
 *
 * `status` is one of its uses and nothing more: the engine attaches no meaning
 * to it, which is what removed the whole publish/unpublish lifecycle from the
 * core (sections 3 and 11).
 */
export function select<const TOptions extends SelectOptions>(
  options: TOptions,
): FieldDefinition<FieldValue<SelectValue<TOptions>, TOptions>> {
  return selectBuilder(options) as unknown as FieldDefinition<
    FieldValue<SelectValue<TOptions>, TOptions>
  >;
}

export interface MultiselectOptions extends FieldOptions {
  options: readonly SelectChoice[];
  default?: string[];
  minItems?: number;
  maxItems?: number;
}

const multiselectBuilder = defineField<string[], MultiselectOptions>({
  name: "multiselect",
  optionsSchema: selectOptionsSchema.extend({
    default: z.array(z.string()).optional(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().positive().optional(),
  }) as unknown as z.ZodType<MultiselectOptions>,
  schema: (options) => {
    let schema = z.array(z.enum(choiceValues(options.options) as [string]));
    if (options.minItems !== undefined) schema = schema.min(options.minItems);
    if (options.maxItems !== undefined) schema = schema.max(options.maxItems);
    return schema;
  },
  column: () => ({ type: "json", array: true }),
  aiActions: ["tags"],
});

export function multiselect<const TOptions extends MultiselectOptions>(
  options: TOptions,
): FieldDefinition<FieldValue<SelectValue<TOptions>[], TOptions>> {
  return multiselectBuilder(options) as unknown as FieldDefinition<
    FieldValue<SelectValue<TOptions>[], TOptions>
  >;
}

// ---------------------------------------------------------------------------
// json, media, relation
// ---------------------------------------------------------------------------

export interface JsonFieldOptions extends FieldOptions {
  default?: JsonValue;
}

export const json = defineField<JsonValue, JsonFieldOptions>({
  name: "json",
  optionsSchema: commonOptions as unknown as z.ZodType<JsonFieldOptions>,
  schema: () => jsonValue,
  column: () => ({ type: "json" }),
});

export interface MediaOptions extends FieldOptions {
  /** MIME whitelist for the picker, e.g. `image/*`. */
  accept?: string;
}

/**
 * A reference to a row in `media`.
 *
 * Storing the id rather than a URL is what makes the media lifecycle work:
 * `media_usages` can count references, and a file that loses its last one is
 * orphaned rather than deleted (section 6).
 */
export const media = defineField<string, MediaOptions>({
  name: "media",
  optionsSchema: commonOptions.extend({
    accept: z.string().optional(),
  }) as unknown as z.ZodType<MediaOptions>,
  schema: () => z.string().min(1),
  column: () => ({ type: "text" }),
  aiActions: ["alt"],
});

export interface RelationOptions extends FieldOptions {
  relationTo?: string;
  /** Many-to-many: the value is an array of ids. */
  many?: boolean;
}

const relationBuilder = defineField<string, RelationOptions>({
  name: "relation",
  optionsSchema: commonOptions.extend({
    relationTo: z.string().min(1),
    many: z.boolean().optional(),
  }) as unknown as z.ZodType<RelationOptions>,
  schema: () => z.string().min(1),
  column: (options) => ({
    type: "text",
    ...(options.many === true ? { type: "json" as const, array: true } : {}),
  }),
  aiActions: ["tags"],
});

/**
 * A reference to another collection.
 *
 * Resolved by a batch loader rather than a join: one query per collection per
 * depth level works the same on all three engines and removes the N+1 problem
 * that Payload users hit with `depth` (section 12).
 */
export function relation<const TOptions extends RelationOptions>(
  to: string,
  options?: TOptions,
): FieldDefinition<FieldValue<string, TOptions>> {
  return relationBuilder({
    ...(options ?? {}),
    relationTo: to,
  } as TOptions) as unknown as FieldDefinition<FieldValue<string, TOptions>>;
}

/**
 * There is no `slug` type, and that is deliberate.
 *
 * It was one of these for a while, and it earned its keep by being `text`
 * with `unique`, `index` and a hyphen pattern already set — plus a `from`
 * option that promised the value would be derived from another field and
 * never did it, because nothing in the engine generates one field out of
 * another. A type whose only feature is a default and a promise is a type
 * that teaches the wrong thing. A URL handle is a `text` field:
 *
 * ```ts
 * handle: text({
 *   unique: true,
 *   index: true,
 *   pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
 * })
 * ```
 *
 * and generating it from the title is a `create.before` hook, which runs
 * before validation precisely so that it can fill a required field.
 */
export const email = defineField<string, TextOptions>({
  name: "email",
  optionsSchema: commonOptions as unknown as z.ZodType<TextOptions>,
  schema: () => z.string().email(),
  column: () => ({ type: "text" }),
});

export const url = defineField<string, TextOptions>({
  name: "url",
  optionsSchema: commonOptions as unknown as z.ZodType<TextOptions>,
  schema: () => z.string().url(),
  column: () => ({ type: "text" }),
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * SEO as fields, not as a plugin.
 *
 * A plugin would own the fields, the prompts and the panel section; a preset
 * spreads into `fields` and stays editable (`...seoFields()`), which is the
 * decision recorded in section 11.
 */
export function seoFields(): {
  seoTitle: FieldDefinition<string | null>;
  seoDescription: FieldDefinition<string | null>;
  ogImage: FieldDefinition<string | null>;
  canonical: FieldDefinition<string | null>;
} {
  return {
    seoTitle: text({
      label: "SEO title",
      localized: true,
      maxLength: 70,
      aiGenerate: {
        label: "Suggest an SEO title",
        prompt: "Write a search-friendly title under 60 characters.",
      },
    }),
    seoDescription: textarea({
      label: "SEO description",
      localized: true,
      maxLength: 160,
      aiGenerate: {
        label: "Suggest an SEO description",
        prompt: "Summarise the article in one sentence under 155 characters.",
      },
    }),
    ogImage: media({ label: "Social image", accept: "image/*" }),
    canonical: url({ label: "Canonical URL" }),
  };
}
