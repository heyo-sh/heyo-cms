import type {
  Comparator,
  FieldPath,
  OrderBy,
  Query,
  Where,
} from "./types/query";

/**
 * Builders for the filter AST.
 *
 * The AST is the contract between the engine and every database adapter
 * (section 12), so it is worth writing by hand — but not often. These helpers
 * make the common shapes readable and keep access rules, which return
 * `Where`, from having to construct node objects literally.
 */

export function and(...conditions: (Where | undefined)[]): Where {
  return { kind: "and", conditions: conditions.filter(isWhere) };
}

export function or(...conditions: (Where | undefined)[]): Where {
  return { kind: "or", conditions: conditions.filter(isWhere) };
}

export function not(condition: Where): Where {
  return { kind: "not", condition };
}

export function where(
  path: FieldPath,
  operator: Comparator,
  value: CompareValue | CompareValue[],
): Where {
  return { kind: "compare", path, operator, value };
}

export function eq(path: FieldPath, value: CompareValue): Where {
  return { kind: "compare", path, operator: "eq", value };
}

export function ne(path: FieldPath, value: CompareValue): Where {
  return { kind: "compare", path, operator: "ne", value };
}

export function gt(path: FieldPath, value: CompareValue): Where {
  return { kind: "compare", path, operator: "gt", value };
}

export function gte(path: FieldPath, value: CompareValue): Where {
  return { kind: "compare", path, operator: "gte", value };
}

export function lt(path: FieldPath, value: CompareValue): Where {
  return { kind: "compare", path, operator: "lt", value };
}

export function lte(path: FieldPath, value: CompareValue): Where {
  return { kind: "compare", path, operator: "lte", value };
}

export function inList(path: FieldPath, values: CompareValue[]): Where {
  return { kind: "compare", path, operator: "in", value: values };
}

export function notInList(path: FieldPath, values: CompareValue[]): Where {
  return { kind: "compare", path, operator: "nin", value: values };
}

export function like(
  path: FieldPath,
  pattern: string,
  caseInsensitive = false,
): Where {
  return {
    kind: "compare",
    path,
    operator: caseInsensitive ? "ilike" : "like",
    value: pattern,
  };
}

export function contains(path: FieldPath, value: CompareValue): Where {
  return { kind: "compare", path, operator: "contains", value };
}

export function exists(path: FieldPath, present = true): Where {
  return { kind: "compare", path, operator: "exists", value: present };
}

export function orderBy(
  path: FieldPath,
  direction: "asc" | "desc" = "asc",
): OrderBy {
  return { path, direction };
}

/**
 * Combines a caller's filter with the one access control produced.
 *
 * Always an `and`, always in the query: a rule that filtered after fetching
 * would leak through counts, pagination and every aggregate (stage 4).
 */
export function restrict(
  requested: Where | undefined,
  granted: Where | undefined,
): Where | undefined {
  if (!requested) return granted;
  if (!granted) return requested;
  return and(requested, granted);
}

/** A query with its filter restricted; the shape adapters receive. */
export function restrictQuery(query: Query, granted: Where | undefined): Query {
  const combined = restrict(query.where, granted);
  return combined === undefined ? query : { ...query, where: combined };
}

/** One comparable value: the array form belongs to `in` and `nin` alone. */
type CompareValue = Exclude<
  Extract<Where, { kind: "compare" }>["value"],
  unknown[]
>;

function isWhere(condition: Where | undefined): condition is Where {
  return condition !== undefined;
}
