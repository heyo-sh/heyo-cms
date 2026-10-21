import { CmsError } from "../errors";
import { and, not, or } from "../query";
import type { Actor } from "../types/actor";
import type { FindArgs, ReadArgs } from "../types/api";
import type { ResolvedCollection } from "../types/config";
import type { Comparator, ColumnValue, OrderBy, Where } from "../types/query";

/**
 * The URL, turned into the arguments the local API takes.
 *
 * Two filter syntaxes, deliberately: `?status=draft` and `?views[gte]=10` for
 * a human with curl, and `?where=<json>` carrying the same AST the engine
 * uses for a client that composes filters in code. They produce identical
 * `Where` trees — the typed client builds the second with the very `eq()`
 * helpers an access rule uses, so there is one query language in the product
 * rather than one per transport.
 *
 * Nothing here decides what a caller may see. Access control is the engine's,
 * applied to whatever this produces (stage 4).
 */

/** Query keys that are options rather than filters. */
const reserved = new Set([
  "where",
  "sort",
  "limit",
  "offset",
  "cursor",
  "count",
  "depth",
  "locale",
  "fallbackLocale",
  "includeTrashed",
  "permanent",
  "refresh",
  "force",
  // How rich-text fields are rendered in the response, not what to filter
  // by: a collection with a field called `richText` would otherwise lose
  // the ability to filter on it, which is why this list exists at all.
  "richText",
]);

/** The system columns a caller may filter and sort by, in both spellings. */
const systemPaths: Record<string, string> = {
  id: "id",
  createdAt: "created_at",
  created_at: "created_at",
  updatedAt: "updated_at",
  updated_at: "updated_at",
  updatedBy: "updated_by",
  updated_by: "updated_by",
  deletedAt: "deleted_at",
  deleted_at: "deleted_at",
  purgeAfter: "purge_after",
  purge_after: "purge_after",
  scheduledAt: "scheduled_at",
  scheduled_at: "scheduled_at",
};

/** Columns holding a moment, so a string from a URL becomes a `Date`. */
const timestampPaths = new Set([
  "created_at",
  "updated_at",
  "deleted_at",
  "purge_after",
  "scheduled_at",
]);

const comparators = new Set<Comparator>([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "like",
  "ilike",
  "contains",
  "exists",
]);

/** A filter nobody wrote by hand is a filter nobody meant to send. */
const maxWhereNodes = 100;

export interface ReadQueryOptions {
  actor: Actor | null;
  /** `rest` for everything over HTTP; the panel is marked by a header. */
  source: ReadArgs["source"];
}

/** Locale, depth and the trash flag: what every read takes. */
export function readArgs(
  query: URLSearchParams,
  options: ReadQueryOptions,
): ReadArgs {
  const locale = query.get("locale");
  const fallback = query.get("fallbackLocale");
  const depth = integer(query.get("depth"), "depth", 0, 10);

  return {
    actor: options.actor,
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(locale === null ? {} : { locale }),
    ...(fallback === null
      ? {}
      : { fallbackLocale: fallback === "false" ? false : fallback }),
    ...(depth === undefined ? {} : { depth }),
    ...(boolean(query.get("includeTrashed"), "includeTrashed") === true
      ? { includeTrashed: true }
      : {}),
  };
}

/** The whole of `GET /posts`: filters, sort, paging. */
export function findArgs(
  query: URLSearchParams,
  collection: ResolvedCollection,
  options: ReadQueryOptions,
): FindArgs {
  const base = readArgs(query, options);
  const locale = base.locale ?? null;
  const filter = parseWhere(query, collection, locale);
  const order = parseSort(query.get("sort"), collection, locale);
  const limit = integer(query.get("limit"), "limit", 1, 500);
  const offset = integer(query.get("offset"), "offset", 0, Number.MAX_SAFE_INTEGER); // prettier-ignore
  const cursor = query.get("cursor");

  return {
    ...base,
    ...(filter === undefined ? {} : { where: filter }),
    ...(order === undefined ? {} : { orderBy: order }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
    ...(cursor === null ? {} : { cursor }),
    ...(boolean(query.get("count"), "count") === true ? { count: true } : {}),
  };
}

/**
 * The filter, from either syntax.
 *
 * Both are resolved through the same path resolver, which is what makes a
 * localized field filterable without the caller knowing it is stored as a map:
 * `?title=Hello` with `?locale=de` becomes `data.title.de`, because that is
 * where the German title lives (section 9).
 */
export function parseWhere(
  query: URLSearchParams,
  collection: ResolvedCollection,
  locale: string | null,
): Where | undefined {
  const conditions: Where[] = [];

  const raw = query.get("where");
  if (raw !== null && raw.trim().length > 0) {
    conditions.push(parseWhereJson(raw, collection, locale));
  }

  for (const [key, value] of query.entries()) {
    if (reserved.has(key)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_.]*)(?:\[([a-z]+)\])?$/.exec(key);
    if (!match) {
      throw CmsError.validation(`"${key}" is not a filter; see the OpenAPI document for the query syntax.`); // prettier-ignore
    }
    const [, field = "", operator = "eq"] = match;
    if (!comparators.has(operator as Comparator)) {
      throw CmsError.validation(`"${operator}" is not a comparison; use one of ${[...comparators].join(", ")}.`); // prettier-ignore
    }
    const resolved = resolvePath(field, collection, locale);
    const op = operator as Comparator;
    conditions.push({
      kind: "compare",
      path: resolved.path,
      operator: op,
      value:
        op === "in" || op === "nin"
          ? value.split(",").map((entry) => coerce(entry, resolved))
          : coerce(value, resolved),
    });
  }

  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? (conditions[0] as Where) : and(...conditions); // prettier-ignore
}

/**
 * The AST form, validated node by node.
 *
 * Accepting a filter tree from a client is only safe because the tree cannot
 * name a table, cannot reach a column the collection does not declare and
 * cannot nest without limit — all three checked here. What it can do is
 * exactly what an access rule can do, which is the point: the same filter
 * composes on the client, in a hook and in a rule.
 */
function parseWhereJson(
  raw: string,
  collection: ResolvedCollection,
  locale: string | null,
): Where {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw CmsError.validation('"where" has to be a JSON filter.');
  }

  let nodes = 0;
  const visit = (value: unknown): Where => {
    nodes += 1;
    if (nodes > maxWhereNodes) {
      throw CmsError.validation(`"where" has more than ${maxWhereNodes} conditions.`); // prettier-ignore
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw CmsError.validation('every node of "where" has to be an object.');
    }
    const node = value as Record<string, unknown>;

    switch (node.kind) {
      case "and":
      case "or": {
        const conditions = node.conditions;
        if (!Array.isArray(conditions)) {
          throw CmsError.validation(`"${node.kind}" needs a "conditions" array.`); // prettier-ignore
        }
        const mapped = conditions.map(visit);
        return node.kind === "and" ? and(...mapped) : or(...mapped);
      }
      case "not":
        return not(visit(node.condition));
      case "compare": {
        const path = node.path;
        const operator = node.operator;
        if (typeof path !== "string") {
          throw CmsError.validation('"compare" needs a "path".');
        }
        if (
          typeof operator !== "string" ||
          !comparators.has(operator as Comparator)
        ) {
          throw CmsError.validation(`"${String(operator)}" is not a comparison.`); // prettier-ignore
        }
        const resolved = resolvePath(path, collection, locale);
        return {
          kind: "compare",
          path: resolved.path,
          operator: operator as Comparator,
          value: coerceJson(node.value, resolved),
        };
      }
      default:
        throw CmsError.validation(`"${String(node.kind)}" is not a filter node.`); // prettier-ignore
    }
  };

  return visit(parsed);
}

export function parseSort(
  raw: string | null,
  collection: ResolvedCollection,
  locale: string | null,
): OrderBy[] | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;

  const order: OrderBy[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const descending = trimmed.startsWith("-");
    const field = descending ? trimmed.slice(1) : trimmed;
    order.push({
      path: resolvePath(field, collection, locale).path,
      direction: descending ? "desc" : "asc",
    });
  }
  return order.length === 0 ? undefined : order;
}

interface ResolvedFilterPath {
  path: string;
  /** Needed to turn `"true"` into `true` and an ISO string into a `Date`. */
  type: "text" | "number" | "boolean" | "timestamp" | "json";
}

/**
 * A field name, as the AST addresses it.
 *
 * A collection field resolves into the document body, which the adapter does
 * for a bare name; a system column resolves to the column. Anything else is
 * refused rather than passed through, because a path the collection never
 * declared can only be a typo or an attempt to read a column by guessing.
 */
function resolvePath(
  field: string,
  collection: ResolvedCollection,
  locale: string | null,
): ResolvedFilterPath {
  const [head = "", ...rest] = field.split(".");

  const system = systemPaths[head];
  if (system !== undefined && rest.length === 0) {
    return {
      path: system,
      type: timestampPaths.has(system) ? "timestamp" : "text",
    };
  }

  const definition = collection.fields[head];
  if (!definition) {
    throw CmsError.validation(
      `"${field}" is not a field of ${collection.name}, and not a system column.`,
    );
  }
  if (rest.length > 2) {
    throw CmsError.validation(`"${field}" is nested too deeply to filter.`);
  }

  // A localized field is stored as `{ [locale]: value }`, so a filter on it
  // has to name a language. The requested locale is the right default: it is
  // the language the rest of the response is in.
  const segments =
    definition.localized && rest.length === 0 ? [locale ?? ""] : rest;
  const path = [head, ...segments.filter((segment) => segment.length > 0)].join(
    ".",
  );

  return { path, type: columnType(definition.column.type) };
}

function columnType(type: string): ResolvedFilterPath["type"] {
  switch (type) {
    case "integer":
    case "bigint":
    case "real":
      return "number";
    case "boolean":
      return "boolean";
    case "timestamp":
      return "timestamp";
    case "json":
      return "json";
    default:
      return "text";
  }
}

/** A query string carries only strings; the column says what it meant. */
function coerce(value: string, resolved: ResolvedFilterPath): ColumnValue {
  if (value === "null") return null;
  switch (resolved.type) {
    case "number": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw CmsError.validation(`"${value}" is not a number for ${resolved.path}.`); // prettier-ignore
      }
      return parsed;
    }
    case "boolean": {
      if (value === "true") return true;
      if (value === "false") return false;
      throw CmsError.validation(`"${value}" is not a boolean for ${resolved.path}.`); // prettier-ignore
    }
    case "timestamp":
      return date(value, resolved.path);
    default:
      return value;
  }
}

/** The AST form already carries types; only a date still needs reviving. */
function coerceJson(
  value: unknown,
  resolved: ResolvedFilterPath,
): ColumnValue | ColumnValue[] {
  if (Array.isArray(value)) {
    return value.map((entry) => coerceJson(entry, resolved) as ColumnValue);
  }
  if (resolved.type === "timestamp" && typeof value === "string") {
    return date(value, resolved.path);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw CmsError.validation(`${resolved.path} cannot be compared to an object.`); // prettier-ignore
}

function date(value: string, path: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw CmsError.validation(`"${value}" is not a date for ${path}.`);
  }
  return parsed;
}

export function integer(
  raw: string | null,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw CmsError.validation(`"${name}" has to be an integer between ${min} and ${max}.`); // prettier-ignore
  }
  return parsed;
}

/**
 * `?flag`, `?flag=true` and `?flag=1` all mean yes.
 *
 * A bare `?permanent` with no value is what somebody types, and reading it as
 * "false" would make a destructive flag silently do nothing.
 */
export function boolean(raw: string | null, name: string): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === "" || raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw CmsError.validation(`"${name}" has to be true or false.`);
}
