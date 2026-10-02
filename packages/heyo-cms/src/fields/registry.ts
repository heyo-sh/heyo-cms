import type { ZodType } from "zod";

import { CmsConfigError } from "../errors";
import type {
  FieldAiConfig,
  FieldDefinition,
  FieldOptions,
  FieldType,
} from "../types/fields";
import type { JsonValue } from "../types/json";

/**
 * Nullability is a property of the options, not of the field type.
 *
 * `text()` holds `string | null` and `text({ required: true })` holds
 * `string`, and both facts are visible in the inferred document type instead
 * of being discovered at runtime.
 */
export type FieldValue<TValue, TOptions> = TOptions extends { required: true }
  ? TValue
  : TValue | null;

export interface FieldBuilderOptions extends FieldOptions {
  default?: JsonValue;
}

/**
 * A field builder: what `text`, `select` or a third-party `rating` is.
 *
 * `const TOptions` captures literal option values, which is what lets
 * `select({ options: ["draft", "published"] })` infer a union rather than
 * `string`.
 */
export type FieldBuilder<TValue, TOptions extends FieldOptions> = <
  const TGiven extends TOptions,
>(
  options?: TGiven,
) => FieldDefinition<FieldValue<TValue, TGiven>>;

/**
 * Every registered type, so the panel and `cms.inspect()` can enumerate them.
 *
 * Stored opaquely: a field type is generic in its value, and a registry that
 * tried to keep that generic would be unusable as a map.
 */
const registry = new Map<string, unknown>();

export function registerFieldType<TValue, TOptions extends FieldOptions>(
  type: FieldType<TValue, TOptions>,
): void {
  const existing: unknown = registry.get(type.name);
  if (existing !== undefined && existing !== (type as unknown)) {
    throw new CmsConfigError(
      `fields.${type.name}`,
      "a different field type with this name is already registered",
    );
  }
  registry.set(type.name, type);
}

export function getFieldType<TValue = unknown>(
  name: string,
): FieldType<TValue, FieldOptions> | undefined {
  return registry.get(name) as FieldType<TValue, FieldOptions> | undefined;
}

export function registeredFieldTypes(): string[] {
  return [...registry.keys()].sort();
}

/**
 * Declares a field type and returns its builder.
 *
 * Every built-in field goes through this function. A shortcut for built-ins
 * would mean the public extension API is the one nobody uses, which is how
 * extension points rot (stage 9).
 */
export function defineField<TValue, TOptions extends FieldOptions>(
  type: FieldType<TValue, TOptions>,
): FieldBuilder<TValue, TOptions> {
  registerFieldType(type);

  return (<const TGiven extends TOptions>(options?: TGiven) => {
    const given = (options ?? {}) as TGiven &
      FieldBuilderOptions &
      Record<string, unknown>;
    const parsed = type.optionsSchema
      ? parseOptions(type.name, type.optionsSchema, given)
      : given;

    const required = given.required === true;
    const localized = given.localized === true;
    const column = type.column(parsed as TOptions);

    if (localized && (given.unique === true || column.unique === true)) {
      // Uniqueness would have to be enforced per locale, and locales are rows
      // in a table rather than entries in the configuration (section 9), so
      // the index could not exist until that locale was created. Refusing is
      // better than an index that silently covers one language.
      throw new CmsConfigError(
        `fields.${type.name}`,
        "a localized field cannot be unique in v1; enforce it in a hook instead",
      );
    }

    validateAiActions(type.name, type.aiActions, given.ai);

    const definition: FieldDefinition<FieldValue<TValue, TGiven>> = {
      type: type.name,
      options: given,
      schema: applyNullability(
        type.schema(parsed as TOptions),
        required,
      ) as ZodType<FieldValue<TValue, TGiven>>,
      column: {
        ...column,
        nullable: column.nullable ?? !required,
        ...(given.unique === undefined ? {} : { unique: given.unique }),
        ...(given.index === undefined ? {} : { index: given.index }),
        storage: column.storage ?? "document",
      },
      localized,
      required,
      ...(given.default === undefined ? {} : { defaultValue: given.default }),
      ...(given.ai === undefined ? {} : { ai: given.ai }),
      ...(given.access === undefined ? {} : { access: given.access }),
      ...(given.admin === undefined ? {} : { admin: given.admin }),
      ...(typeof given.relationTo === "string"
        ? { relationTo: given.relationTo }
        : {}),
    };

    return definition;
  }) as FieldBuilder<TValue, TOptions>;
}

function parseOptions(
  name: string,
  schema: ZodType<unknown>,
  options: unknown,
): unknown {
  const result = schema.safeParse(options);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
    throw new CmsConfigError(
      `fields.${name}`,
      `${issue?.message ?? "invalid options"}${where}`,
    );
  }
  return result.data;
}

/**
 * An optional field holds `null`, never `undefined`.
 *
 * A document body round-trips through JSON on every engine, and `undefined`
 * does not survive that trip. Storing `null` keeps "never set" and "set to
 * nothing" from drifting apart depending on the database.
 */
function applyNullability(
  schema: ZodType<unknown>,
  required: boolean,
): ZodType<unknown> {
  return required ? schema : schema.nullable();
}

function validateAiActions(
  name: string,
  aiActions: string[] | undefined,
  ai: FieldAiConfig | undefined,
): void {
  if (!ai || !aiActions) return;
  for (const action of Object.keys(ai)) {
    const builtIn = aiActions.includes(action);
    const custom = typeof ai[action] === "object";
    // A typo in a built-in action name would silently remove a button from
    // the panel, so an unknown key is only accepted when it brings its own
    // prompt — that is a custom action, not a mistake.
    if (!builtIn && !custom) {
      throw new CmsConfigError(
        `fields.${name}.ai.${action}`,
        `unknown AI action; ${name} supports ${aiActions.join(", ")}. ` +
          "Custom actions need an object with a prompt.",
      );
    }
  }
}
