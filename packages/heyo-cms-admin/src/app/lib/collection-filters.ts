import type {
  PanelCollection,
  PanelField,
  PanelLocale,
  Where,
} from "@heyo-sh/heyo-cms/types";

/** The human wording stays independent from the API comparator vocabulary. */
export type CollectionFilterOperator =
  | "is"
  | "is-not"
  | "contains"
  | "does-not-contain"
  | "greater-than"
  | "greater-than-or-equal"
  | "less-than"
  | "less-than-or-equal"
  | "after"
  | "on-or-after"
  | "before"
  | "on-or-before";

export type CollectionFilterValue = string | string[] | number | boolean;

type FilterOption = { label: string; value: string | boolean };

type FilterInputKind =
  | "text"
  | "number"
  | "date"
  | "datetime"
  | "select"
  | "multiselect"
  | "boolean";

export interface CollectionFilterFieldDefinition {
  /** UI identity. It deliberately differs from `path`, which reaches the API. */
  id: string;
  path: string;
  label: string;
  groupLabel: string;
  inputKind: FilterInputKind;
  operators: CollectionFilterOperator[];
  options?: FilterOption[];
  /** Localized document fields that establish whether a translation exists. */
  localizedFields?: string[];
  /** Used for the number input's precision. */
  integer?: boolean;
}

export interface CollectionFilterFieldGroup {
  label: string;
  fields: CollectionFilterFieldDefinition[];
}

export interface AppliedCollectionFilter {
  id: string;
  fieldId: string;
  operator: CollectionFilterOperator;
  value: CollectionFilterValue;
}

export interface DraftCollectionFilter {
  id: string;
  fieldId: string;
  operator: CollectionFilterOperator;
  value: CollectionFilterValue | null;
}

const BOOLEAN_OPTIONS: FilterOption[] = [
  { label: "True", value: true },
  { label: "False", value: false },
];

const TEXT_OPERATORS: CollectionFilterOperator[] = [
  "is",
  "is-not",
  "contains",
  "does-not-contain",
];
const EQUALITY_OPERATORS: CollectionFilterOperator[] = ["is", "is-not"];
const NUMBER_OPERATORS: CollectionFilterOperator[] = [
  "is",
  "is-not",
  "greater-than",
  "greater-than-or-equal",
  "less-than",
  "less-than-or-equal",
];
const DATE_OPERATORS: CollectionFilterOperator[] = [
  "is",
  "is-not",
  "after",
  "on-or-after",
  "before",
  "on-or-before",
];
const MULTI_VALUE_OPERATORS: CollectionFilterOperator[] = [
  "contains",
  "does-not-contain",
];

export const COLLECTION_FILTER_OPERATOR_LABELS: Record<
  CollectionFilterOperator,
  string
> = {
  is: "is",
  "is-not": "is not",
  contains: "contains",
  "does-not-contain": "does not contain",
  "greater-than": "is greater than",
  "greater-than-or-equal": "is greater than or equal to",
  "less-than": "is less than",
  "less-than-or-equal": "is less than or equal to",
  after: "is after",
  "on-or-after": "is on or after",
  before: "is before",
  "on-or-before": "is on or before",
};

/**
 * The picker exposes only field types with a useful, universal control. Rich
 * text and JSON have nested shapes; media is an opaque asset id. Presenting
 * any of them as a generic text filter would be misleading.
 */
function fieldDefinition(
  collection: PanelCollection,
  field: PanelField,
): CollectionFilterFieldDefinition | null {
  const base = {
    id: `field:${field.name}`,
    path: field.name,
    label: field.label,
    groupLabel: collection.label,
  };

  switch (field.type) {
    case "text":
    case "textarea":
    case "email":
    case "url":
      return { ...base, inputKind: "text", operators: TEXT_OPERATORS };
    case "number":
      return {
        ...base,
        inputKind: "number",
        operators: NUMBER_OPERATORS,
        integer: field.options.integer === true,
      };
    case "boolean":
      return {
        ...base,
        inputKind: "boolean",
        operators: EQUALITY_OPERATORS,
        options: BOOLEAN_OPTIONS,
      };
    case "date":
      return {
        ...base,
        inputKind: field.options.mode === "date" ? "date" : "datetime",
        operators: DATE_OPERATORS,
      };
    case "select":
      return {
        ...base,
        inputKind: "select",
        operators: EQUALITY_OPERATORS,
        options: choices(field),
      };
    case "multiselect":
      return {
        ...base,
        inputKind: "multiselect",
        operators: MULTI_VALUE_OPERATORS,
        options: choices(field),
      };
    // A relation is a scalar id. The panel has no generic, safe way to fetch
    // its display labels, so keep the one-to-one form exact-id only rather
    // than presenting an empty combobox. Media is deliberately excluded: an
    // opaque asset id is not a meaningful collection-list filter. A
    // many-relation is a JSON array and, unlike multiselect, has no declared
    // choices; omit it until its target documents can be searched here.
    case "relation":
      return field.options.many === true
        ? null
        : { ...base, inputKind: "text", operators: EQUALITY_OPERATORS };
    default:
      return null;
  }
}

function choices(field: PanelField): FilterOption[] {
  const raw = field.options.options;
  if (!Array.isArray(raw)) return [];
  return raw.map((choice) =>
    typeof choice === "string"
      ? { value: choice, label: choice }
      : {
          value: String((choice as { value?: unknown }).value ?? ""),
          label: String(
            (choice as { label?: unknown; value?: unknown }).label ??
              (choice as { value?: unknown }).value ??
              "",
          ),
        },
  );
}

/** Fields supplied by the engine rather than a collection's document body. */
const documentFields: CollectionFilterFieldDefinition[] = [
  {
    id: "system:id",
    path: "id",
    label: "ID",
    groupLabel: "Document",
    inputKind: "text",
    operators: TEXT_OPERATORS,
  },
  {
    id: "system:createdAt",
    path: "createdAt",
    label: "Created at",
    groupLabel: "Document",
    inputKind: "datetime",
    operators: DATE_OPERATORS,
  },
  {
    id: "system:updatedAt",
    path: "updatedAt",
    label: "Updated at",
    groupLabel: "Document",
    inputKind: "datetime",
    operators: DATE_OPERATORS,
  },
  {
    id: "system:scheduledAt",
    path: "scheduledAt",
    label: "Scheduled at",
    groupLabel: "Document",
    inputKind: "datetime",
    operators: DATE_OPERATORS,
  },
];

export function buildCollectionFilterFieldGroups(
  collection: PanelCollection,
  locales: PanelLocale[] = [],
): CollectionFilterFieldGroup[] {
  const readableFields = collection.fields.filter(
    (field) => field.access.read && !field.admin.hidden,
  );
  const fields = readableFields
    .map((field) => fieldDefinition(collection, field))
    .filter(
      (field): field is CollectionFilterFieldDefinition => field !== null,
    );
  const localizedFields = readableFields
    .filter((field) => field.localized)
    .map((field) => field.name);
  const language = languageDefinition(localizedFields, locales);

  return [
    { label: "Document", fields: documentFields },
    ...(language ? [{ label: "i18n", fields: [language] }] : []),
    ...(fields.length > 0 ? [{ label: collection.label, fields }] : []),
  ];
}

/**
 * A document does not have one language column. A translation is present when
 * at least one readable localized field has a value under a configured locale.
 * Keeping that storage detail here gives the picker one honest "Language"
 * filter instead of exposing a list of `title.de`, `body.de`, … paths.
 */
function languageDefinition(
  localizedFields: string[],
  locales: PanelLocale[],
): CollectionFilterFieldDefinition | null {
  if (localizedFields.length === 0 || locales.length === 0) return null;

  return {
    id: "system:locale",
    path: "",
    label: "Language",
    groupLabel: "i18n",
    inputKind: "select",
    operators: EQUALITY_OPERATORS,
    options: locales.map((locale) => ({
      label: locale.name,
      value: locale.code,
    })),
    localizedFields,
  };
}

export function createCollectionFilterFieldMap(
  groups: CollectionFilterFieldGroup[],
): Map<string, CollectionFilterFieldDefinition> {
  return new Map(
    groups.flatMap((group) =>
      group.fields.map((field) => [field.id, field] as const),
    ),
  );
}

export function createNewCollectionFilter(
  fieldId: string,
): DraftCollectionFilter {
  return { id: crypto.randomUUID(), fieldId, operator: "is", value: null };
}

export function getDefaultOperatorForCollectionField(
  field: CollectionFilterFieldDefinition,
): CollectionFilterOperator {
  return field.operators[0] ?? "is";
}

export function isCollectionFilterValueReady(
  field: CollectionFilterFieldDefinition,
  value: CollectionFilterValue | null,
): value is CollectionFilterValue {
  if (value === null || value === undefined) return false;

  switch (field.inputKind) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "select":
    case "multiselect":
      return Array.isArray(value)
        ? value.length > 0 && value.every((entry) => entry.trim().length > 0)
        : typeof value === "string" && value.trim().length > 0;
    default:
      return typeof value === "string" && value.trim().length > 0;
  }
}

function valueLabels(
  field: CollectionFilterFieldDefinition,
  value: CollectionFilterValue,
): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(
    (entry) =>
      field.options?.find((option) => option.value === entry)?.label ??
      String(entry),
  );
}

export function collectionFilterBadgeLabel(
  filter: AppliedCollectionFilter,
  field: CollectionFilterFieldDefinition,
): string {
  const labels = valueLabels(field, filter.value);
  const summary =
    labels.length <= 3
      ? labels.join(", ")
      : `${labels[0]} and ${labels.length - 1} more`;
  return `${field.label} ${COLLECTION_FILTER_OPERATOR_LABELS[filter.operator]} ${summary}`;
}

/** A branch is flattened only to keep the JSON sent over the URL compact. */
function oneOrMany(kind: "and" | "or", conditions: Where[]): Where {
  return conditions.length === 1
    ? (conditions[0] as Where)
    : { kind, conditions };
}

function compare(
  path: string,
  operator: Extract<Where, { kind: "compare" }>["operator"],
  value: string | string[] | number | boolean,
): Where {
  return { kind: "compare", path, operator, value };
}

/**
 * Paragraph's negative filters include documents whose field is empty. SQL's
 * `NOT (column = value)` does not (NULL is neither true nor false), so say
 * that rule explicitly in the API's own AST.
 */
function missingOrNot(path: string, condition: Where): Where {
  return {
    kind: "or",
    conditions: [compare(path, "exists", false), { kind: "not", condition }],
  };
}

function apiDate(value: string): string {
  const parsed = new Date(value);
  // Readiness already establishes a non-empty value. Retaining an invalid
  // string lets the server return its normal validation error instead of
  // silently changing the requested filter.
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function apiValue(
  field: CollectionFilterFieldDefinition,
  value: CollectionFilterValue,
): CollectionFilterValue {
  return (field.inputKind === "date" || field.inputKind === "datetime") &&
    typeof value === "string"
    ? apiDate(value)
    : value;
}

/**
 * One selected language means "there is a translation in this language". A
 * document can have several localized fields, so their locale paths are ORed;
 * selecting several languages means any of them is present. The inverse is a
 * single NOT around that whole set — no translation in any selected language.
 */
function languageCondition(
  filter: AppliedCollectionFilter,
  field: CollectionFilterFieldDefinition,
): Where {
  const locales = Array.isArray(filter.value)
    ? filter.value
    : [String(filter.value)];
  const translations = oneOrMany(
    "or",
    field.localizedFields!.flatMap((name) =>
      locales.map((locale) => compare(`${name}.${locale}`, "exists", true)),
    ),
  );

  return filter.operator === "is"
    ? translations
    : { kind: "not", condition: translations };
}

function conditionForFilter(
  filter: AppliedCollectionFilter,
  field: CollectionFilterFieldDefinition,
): Where {
  if (field.localizedFields) return languageCondition(filter, field);

  const value = apiValue(field, filter.value);
  const path = field.path;

  switch (field.inputKind) {
    case "text": {
      const text = String(value);
      const exact = compare(path, "ilike", text);
      const partial = compare(path, "ilike", `%${text}%`);
      switch (filter.operator) {
        case "is":
          return exact;
        case "is-not":
          return missingOrNot(path, exact);
        case "contains":
          return partial;
        case "does-not-contain":
          return missingOrNot(path, partial);
        default:
          return exact;
      }
    }
    case "number": {
      const number = value as number;
      switch (filter.operator) {
        case "is":
          return compare(path, "eq", number);
        case "is-not":
          return missingOrNot(path, compare(path, "eq", number));
        case "greater-than":
          return compare(path, "gt", number);
        case "greater-than-or-equal":
          return compare(path, "gte", number);
        case "less-than":
          return compare(path, "lt", number);
        case "less-than-or-equal":
          return compare(path, "lte", number);
        default:
          return compare(path, "eq", number);
      }
    }
    case "date":
    case "datetime": {
      const date = String(value);
      switch (filter.operator) {
        case "is":
          return compare(path, "eq", date);
        case "is-not":
          return missingOrNot(path, compare(path, "eq", date));
        case "after":
          return compare(path, "gt", date);
        case "on-or-after":
          return compare(path, "gte", date);
        case "before":
          return compare(path, "lt", date);
        case "on-or-before":
          return compare(path, "lte", date);
        default:
          return compare(path, "eq", date);
      }
    }
    case "boolean": {
      const equals = compare(path, "eq", value as boolean);
      return filter.operator === "is" ? equals : missingOrNot(path, equals);
    }
    case "select": {
      const selected = Array.isArray(value) ? value : [String(value)];
      const matches = oneOrMany(
        "or",
        selected.map((entry) => compare(path, "ilike", entry)),
      );
      return filter.operator === "is" ? matches : missingOrNot(path, matches);
    }
    case "multiselect": {
      const selected = Array.isArray(value) ? value : [String(value)];
      const matches = oneOrMany(
        "or",
        selected.map((entry) => compare(path, "contains", entry)),
      );
      return filter.operator === "contains"
        ? matches
        : { kind: "not", condition: matches };
    }
  }
}

/**
 * Turns the visible filter chips into the engine's public `where` tree. It is
 * intentionally a JSON string: `api.url` URL-encodes it, and the same tree is
 * validated and combined with search/access rules by the server.
 */
export function serializeAppliedCollectionFilters(
  filters: AppliedCollectionFilter[],
  fieldMap: Map<string, CollectionFilterFieldDefinition>,
): string | undefined {
  const conditions = filters.flatMap((filter) => {
    const field = fieldMap.get(filter.fieldId);
    return field ? [conditionForFilter(filter, field)] : [];
  });

  if (conditions.length === 0) return undefined;
  return JSON.stringify(oneOrMany("and", conditions));
}
