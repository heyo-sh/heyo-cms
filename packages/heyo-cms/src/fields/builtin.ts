import { z } from "zod";

import { CmsConfigError } from "../errors";
import type { FieldDefinition, FieldOptions } from "../types/fields";
import type { JsonObject, JsonValue } from "../types/json";
import { slugify, slugPattern } from "../slugify";
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
  aiActions: ["improve", "summarize", "translate"],
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
  aiActions: ["improve", "summarize", "translate"],
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
  aiActions: ["improve", "summarize", "translate"],
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
  // The same shape as the column: one id, or with `many` the list of them
  // that is stored as JSON and that `depth` resolves into documents.
  schema: (options) =>
    (options.many === true
      ? z.array(z.string().min(1))
      : z.string().min(1)) as unknown as z.ZodType<string>,
  column: (options) => ({
    type: "text",
    ...(options.many === true ? { type: "json" as const, array: true } : {}),
  }),
  aiActions: ["tags"],
});

/** The stored value of a relation: a list of ids with `many: true`, one id otherwise. */
type RelationValue<TOptions> = TOptions extends { many: true }
  ? string[]
  : string;

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
): FieldDefinition<FieldValue<RelationValue<TOptions>, TOptions>> {
  return relationBuilder({
    ...(options ?? {}),
    relationTo: to,
  } as TOptions) as unknown as FieldDefinition<
    FieldValue<RelationValue<TOptions>, TOptions>
  >;
}

// ---------------------------------------------------------------------------
// slug
// ---------------------------------------------------------------------------

export interface SlugOptions extends FieldOptions {
  /**
   * The field a slug is made from while it is empty: `"title"`.
   *
   * Made once, on the write that first has a value for it, and then left
   * alone: retitling a page must not move its URL. Clearing the slug makes
   * it again. The same function is the panel's "Generate" button.
   */
  from?: string;
  /**
   * Keep every slug a document stops using as a previous address of it.
   *
   * `cms.api.<collection>.resolveSlug()` finds a document by a previous
   * address too, which is what a 301 from an old URL is built on; a new
   * document cannot take an address an old one still redirects from. Needs
   * the `slug_history` table, which `heyo-cms generate` adds.
   */
  history?: boolean;
  /** The longest slug produced; longer input is cut at a hyphen. 96 by default. */
  maxLength?: number;
  /**
   * Your own transliteration, when the built-in one is not the house style:
   * `&` as `and`, a language's own rules. Used everywhere a slug is made or
   * cleaned — writes, the Generate button, previous slugs. Its output must
   * still match `slugPattern`; `maxLength` is then yours to apply.
   */
  slugify?: (text: string) => string;
  default?: string;
}

const slugBuilder = defineField<string, SlugOptions>({
  name: "slug",
  optionsSchema: commonOptions.extend({
    from: z.string().min(1).optional(),
    history: z.boolean().optional(),
    maxLength: z.number().int().min(8).max(512).optional(),
    slugify: z.function().optional(),
    default: z.string().optional(),
  }) as unknown as z.ZodType<SlugOptions>,
  schema: (options) =>
    z
      .string()
      .max(options.maxLength ?? 96)
      .regex(new RegExp(slugPattern), "lowercase letters, digits and single hyphens only"), // prettier-ignore
  column: (options) => ({
    type: "text",
    ...(options.default === undefined ? {} : { default: options.default }),
  }),
});

/**
 * A URL slug: `"lodz-in-autumn"`.
 *
 * What makes it more than `text` with a pattern is the engine, on every
 * write path — the panel, the REST API, an import, a scheduled change:
 *
 * - a typed slug is cleaned (`"Łódź in Autumn!"` becomes `lodz-in-autumn`);
 * - an empty one is made `from` another field, with `-2`, `-3`… until free;
 * - it is unique within the collection — per language when localized, which
 *   a database index cannot express, so the engine checks it, trashed
 *   documents included;
 * - with `history`, a changed slug stays a previous address of the document,
 *   which `resolveSlug()` finds and nobody else may take.
 *
 * ```ts
 * slug: slug({ from: "title", localized: true, history: true })
 * ```
 */
export function slug<const TOptions extends SlugOptions>(
  options?: TOptions,
): FieldDefinition<FieldValue<string, TOptions>> {
  const given: SlugOptions = { ...(options ?? {}) };
  const localized = given.localized === true;
  const max = given.maxLength;
  const from = given.from;
  const clean =
    given.slugify ??
    ((text: string) =>
      slugify(text, max === undefined ? {} : { maxLength: max }));
  return slugBuilder({
    ...given,
    // A localized field cannot carry a unique index (one index cannot cover
    // languages that do not exist yet), so its uniqueness is the engine's
    // per-language check alone; `unique: false` turns both off.
    unique: localized ? (given.unique === false ? false : undefined) : (given.unique ?? true), // prettier-ignore
    index: localized ? undefined : (given.index ?? true),
    ...(given.generate === undefined && from !== undefined
      ? {
          generate: ({ fields }: { fields: JsonObject }) => {
            const source = fields[from];
            const made = typeof source === "string" ? clean(source) : "";
            return made === "" ? null : made;
          },
        }
      : {}),
  } as TOptions) as unknown as FieldDefinition<FieldValue<string, TOptions>>;
}

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
// list
// ---------------------------------------------------------------------------

/**
 * What a row of a list may hold: values that are complete on their own. A
 * relation or a media file needs a loader and usage accounting, rich text an
 * editor and a renderer, a slug a uniqueness check across documents — none
 * of which reaches inside a row.
 */
const listRowTypes = new Set([
  "text",
  "textarea",
  "email",
  "url",
  "number",
  "boolean",
  "date",
  "select",
  "multiselect",
]);

/** What a field inside a row cannot be: these belong to the list, or to a document. */
const listRowRefused = [
  "localized",
  "unique",
  "index",
  "access",
  "generate",
  "aiGenerate",
  "ai",
] as const;

export interface ListOptions extends FieldOptions {
  /**
   * The fields of one row:
   * `{ question: text({ required: true }), answer: textarea() }`.
   */
  fields: Record<string, FieldDefinition>;
  minItems?: number;
  maxItems?: number;
  default?: JsonObject[];
}

type RowValue<TField> = TField extends FieldDefinition<infer TValue> ? TValue : never; // prettier-ignore

/** One row of a list: a required field is always there, an optional one may be missing or `null`. */
export type ListRow<TFields extends Record<string, FieldDefinition>> = {
  [
    K in keyof TFields as null extends RowValue<TFields[K]> ? never : K
  ]: RowValue<TFields[K]>; // prettier-ignore
} & {
  [
    K in keyof TFields as null extends RowValue<TFields[K]> ? K : never
  ]?: RowValue<TFields[K]>; // prettier-ignore
};

const isFieldDefinition = (value: unknown): value is FieldDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as FieldDefinition).type === "string" &&
  typeof (value as FieldDefinition).schema?.safeParse === "function";

const listBuilder = defineField<JsonObject[], ListOptions>({
  name: "list",
  optionsSchema: commonOptions.extend({
    fields: z.record(
      z.string(),
      z.custom<FieldDefinition>(
        isFieldDefinition,
        "must be a field, such as text()",
      ),
    ),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().positive().optional(),
    default: z.array(z.record(z.string(), jsonValue)).optional(),
  }) as unknown as z.ZodType<ListOptions>,
  schema: (options) => {
    const row: Record<string, z.ZodType> = {};
    for (const [name, field] of Object.entries(options.fields)) {
      // A field's own schema already says whether it may be `null`; an
      // optional one may also be left out of the row altogether.
      row[name] = field.required ? field.schema : field.schema.optional();
    }
    // Strict: a misspelt key is an error, not a value silently dropped.
    let rows = z.array(z.strictObject(row));
    if (options.minItems !== undefined) rows = rows.min(options.minItems);
    if (options.maxItems !== undefined) rows = rows.max(options.maxItems);
    return rows as unknown as z.ZodType<JsonObject[]>;
  },
  column: () => ({ type: "json", array: true }),
});

/**
 * An ordered list of rows, each with the same small set of fields: questions
 * and answers, sources, a change log.
 *
 * ```ts
 * faq: list({
 *   localized: true,
 *   fields: {
 *     question: text({ required: true }),
 *     answer: textarea({ required: true }),
 *   },
 * }),
 * ```
 *
 * The value is an array of objects, stored as JSON in the document and
 * validated row by row with the fields' own schemas. The list is the field:
 * it is localized as a whole, and it carries `required`, `access` and the
 * rest. A row holds text, textarea, email, url, number, boolean, date, select
 * and multiselect fields.
 */
export function list<const TOptions extends ListOptions>(
  options: TOptions,
): FieldDefinition<FieldValue<ListRow<TOptions["fields"]>[], TOptions>> {
  const fields = (options as ListOptions | undefined)?.fields;
  if (
    !fields ||
    typeof fields !== "object" ||
    Object.keys(fields).length === 0
  ) {
    throw new CmsConfigError("fields.list.fields", "a list needs at least one field in a row"); // prettier-ignore
  }
  for (const [name, field] of Object.entries(fields)) {
    const path = `fields.list.fields.${name}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new CmsConfigError(path, "a row's field name must be an identifier (letters, digits, _)"); // prettier-ignore
    }
    if (!isFieldDefinition(field)) {
      throw new CmsConfigError(path, "must be a field, such as text()");
    }
    if (!listRowTypes.has(field.type)) {
      throw new CmsConfigError(
        path,
        `a list row cannot hold a ${field.type} field; use ${[...listRowTypes].join(", ")}`,
      );
    }
    for (const option of listRowRefused) {
      if (field.options[option] !== undefined) {
        throw new CmsConfigError(
          `${path}.${option}`,
          option === "localized"
            ? "a list is localized as a whole: set localized on the list"
            : `not supported inside a list row`,
        );
      }
    }
  }
  if (options.unique === true || options.index === true) {
    throw new CmsConfigError(
      "fields.list",
      "a list cannot be unique or indexed",
    );
  }
  if (
    options.minItems !== undefined &&
    options.maxItems !== undefined &&
    options.minItems > options.maxItems
  ) {
    throw new CmsConfigError(
      "fields.list.minItems",
      "cannot be more than maxItems",
    );
  }
  return listBuilder(options) as unknown as FieldDefinition<
    FieldValue<ListRow<TOptions["fields"]>[], TOptions>
  >;
}

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
