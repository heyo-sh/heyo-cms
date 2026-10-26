import type {
  MongoCursor,
  MongoDocument,
  MongoFilter,
  MongoIndexInfo,
  MongoLikeCollection,
  MongoLikeDatabase,
} from "../src/db/mongodb";

/**
 * An in-process MongoDB.
 *
 * The contract suite has to run against MongoDB on every machine and in CI,
 * and downloading a `mongod` binary to assert that `$set` sets a field would
 * make the suite something people skip. This implements the slice of the
 * driver the adapter actually calls — filters, sorting, projection, indexes
 * including partial unique ones — and the same suite can be pointed at a real
 * server by setting MONGODB_URL.
 */
export function memoryMongo(): MongoLikeDatabase {
  const collections = new Map<string, MemoryCollection>();

  const ensure = (name: string): MemoryCollection => {
    const existing = collections.get(name);
    if (existing) return existing;
    const created = new MemoryCollection();
    collections.set(name, created);
    return created;
  };

  return {
    collection: (name) => ensure(name),
    listCollections: () =>
      cursor([...collections.keys()].sort().map((name) => ({ name }))),
    async createCollection(name) {
      ensure(name);
    },
    async dropCollection(name) {
      collections.delete(name);
    },
  };
}

interface MemoryIndex {
  name: string;
  keys: string[];
  unique: boolean;
  partial?: MongoFilter;
}

class MemoryCollection implements MongoLikeCollection {
  private readonly documents: MongoDocument[] = [];
  private readonly indexes: MemoryIndex[] = [];

  find(
    filter: MongoFilter,
    options: {
      sort?: Record<string, 1 | -1>;
      limit?: number;
      skip?: number;
      projection?: Record<string, 1>;
    } = {},
  ): MongoCursor<MongoDocument> {
    let matched = this.documents.filter((document) =>
      matches(document, filter),
    );

    if (options.sort) {
      const entries = Object.entries(options.sort);
      matched = [...matched].sort((a, b) => {
        for (const [path, direction] of entries) {
          const comparison = compare(readPath(a, path), readPath(b, path));
          if (comparison !== 0) return comparison * direction;
        }
        return 0;
      });
    }
    if (options.skip) matched = matched.slice(options.skip);
    if (options.limit !== undefined) matched = matched.slice(0, options.limit);

    return cursor(matched.map((document) => clone(document)));
  }

  async countDocuments(filter: MongoFilter): Promise<number> {
    return this.documents.filter((document) => matches(document, filter))
      .length;
  }

  async insertOne(document: MongoDocument): Promise<unknown> {
    this.assertUnique(document, undefined);
    this.documents.push(clone(document));
    return { acknowledged: true };
  }

  async updateMany(
    filter: MongoFilter,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount: number; matchedCount: number }> {
    const set = (update.$set ?? {}) as MongoDocument;
    const unset = (update.$unset ?? {}) as MongoDocument;
    let modified = 0;
    let matched = 0;

    for (const document of this.documents) {
      if (!matches(document, filter)) continue;
      matched += 1;
      const candidate = clone(document);
      for (const [path, value] of Object.entries(set)) {
        writePath(candidate, path, value);
      }
      for (const path of Object.keys(unset)) removePath(candidate, path);
      this.assertUnique(candidate, document);
      Object.keys(document).forEach((key) => delete document[key]);
      Object.assign(document, candidate);
      modified += 1;
    }
    return { modifiedCount: modified, matchedCount: matched };
  }

  async deleteMany(filter: MongoFilter): Promise<{ deletedCount: number }> {
    let deleted = 0;
    for (let index = this.documents.length - 1; index >= 0; index -= 1) {
      if (matches(this.documents[index] as MongoDocument, filter)) {
        this.documents.splice(index, 1);
        deleted += 1;
      }
    }
    return { deletedCount: deleted };
  }

  async createIndex(
    keys: Record<string, 1 | -1>,
    options: {
      name?: string;
      unique?: boolean;
      partialFilterExpression?: MongoFilter;
    } = {},
  ): Promise<string> {
    const name = options.name ?? Object.keys(keys).join("_");
    const index: MemoryIndex = {
      name,
      keys: Object.keys(keys),
      unique: options.unique === true,
      ...(options.partialFilterExpression
        ? { partial: options.partialFilterExpression }
        : {}),
    };
    const existing = this.indexes.findIndex((entry) => entry.name === name);
    if (existing >= 0) this.indexes.splice(existing, 1, index);
    else this.indexes.push(index);
    return name;
  }

  async dropIndex(name: string): Promise<unknown> {
    const position = this.indexes.findIndex((entry) => entry.name === name);
    if (position < 0) throw new Error(`index not found: ${name}`);
    this.indexes.splice(position, 1);
    return { ok: 1 };
  }

  listIndexes(): MongoCursor<MongoIndexInfo> {
    return cursor([
      { name: "_id_", key: { _id: 1 }, unique: true },
      ...this.indexes.map((index) => ({
        name: index.name,
        key: Object.fromEntries(index.keys.map((key) => [key, 1])),
        unique: index.unique,
      })),
    ]);
  }

  /** Uniqueness, including the partial indexes content collections rely on. */
  private assertUnique(
    candidate: MongoDocument,
    replacing: MongoDocument | undefined,
  ): void {
    // Every MongoDB collection has a unique `_id_` index that cannot be
    // dropped, so it is checked here without ever being created.
    const primary: MemoryIndex = { name: "_id_", keys: ["_id"], unique: true };
    for (const index of [primary, ...this.indexes]) {
      if (!index.unique) continue;
      if (index.partial && !matches(candidate, index.partial)) continue;

      const values = index.keys.map((key) => readPath(candidate, key));
      if (values.some((value) => value === undefined)) continue;

      for (const document of this.documents) {
        if (document === replacing) continue;
        if (index.partial && !matches(document, index.partial)) continue;
        const other = index.keys.map((key) => readPath(document, key));
        if (other.every((value, position) => equals(value, values[position]))) {
          throw new Error(
            `E11000 duplicate key error collection index: ${index.name}`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Filter evaluation
// ---------------------------------------------------------------------------

function matches(document: MongoDocument, filter: MongoFilter): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$and") {
      if (!(condition as MongoFilter[]).every((entry) => matches(document, entry))) return false; // prettier-ignore
      continue;
    }
    if (key === "$or") {
      if (!(condition as MongoFilter[]).some((entry) => matches(document, entry))) return false; // prettier-ignore
      continue;
    }
    if (key === "$nor") {
      if ((condition as MongoFilter[]).some((entry) => matches(document, entry))) return false; // prettier-ignore
      continue;
    }
    if (!matchesField(readPath(document, key), condition)) return false;
  }
  return true;
}

function matchesField(value: unknown, condition: unknown): boolean {
  if (
    condition === null ||
    typeof condition !== "object" ||
    Array.isArray(condition) ||
    condition instanceof Date ||
    !Object.keys(condition).some((key) => key.startsWith("$"))
  ) {
    return equals(value, condition);
  }

  const operators = condition as Record<string, unknown>;
  for (const [operator, operand] of Object.entries(operators)) {
    switch (operator) {
      case "$eq":
        if (!equals(value, operand)) return false;
        break;
      case "$ne":
        if (equals(value, operand)) return false;
        break;
      case "$gt":
        if (!(compare(value, operand) > 0)) return false;
        break;
      case "$gte":
        if (!(compare(value, operand) >= 0)) return false;
        break;
      case "$lt":
        if (!(compare(value, operand) < 0)) return false;
        break;
      case "$lte":
        if (!(compare(value, operand) <= 0)) return false;
        break;
      case "$in":
        if (!(operand as unknown[]).some((entry) => equals(value, entry))) return false; // prettier-ignore
        break;
      case "$nin":
        if ((operand as unknown[]).some((entry) => equals(value, entry))) return false; // prettier-ignore
        break;
      case "$exists":
        if ((value !== undefined) !== operand) return false;
        break;
      case "$regex": {
        const flags = String(operators.$options ?? "");
        if (typeof value !== "string") return false;
        if (!new RegExp(String(operand), flags).test(value)) return false;
        break;
      }
      case "$options":
        break;
      default:
        throw new Error(
          `Unsupported operator in the memory driver: ${operator}`,
        );
    }
  }
  return true;
}

/** Mongo equality: a scalar also matches an array that contains it. */
function equals(value: unknown, expected: unknown): boolean {
  if (Array.isArray(value) && !Array.isArray(expected)) {
    return value.some((entry) => equals(entry, expected));
  }
  if (value instanceof Date && expected instanceof Date) {
    return value.getTime() === expected.getTime();
  }
  if (value === null || expected === null) {
    // Mongo treats a missing field and an explicit null as the same value.
    return (value ?? null) === (expected ?? null);
  }
  if (typeof value === "object" && typeof expected === "object") {
    return JSON.stringify(value) === JSON.stringify(expected);
  }
  return value === expected;
}

function compare(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }
  return String(left) < String(right) ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function readPath(document: MongoDocument, path: string): unknown {
  let current: unknown = document;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(
  document: MongoDocument,
  path: string,
  value: unknown,
): void {
  const segments = path.split(".");
  let current: Record<string, unknown> = document;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === null || typeof next !== "object") current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1) as string] = value;
}

function removePath(document: MongoDocument, path: string): void {
  const segments = path.split(".");
  let current: Record<string, unknown> = document;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === null || typeof next !== "object") return;
    current = next as Record<string, unknown>;
  }
  delete current[segments.at(-1) as string];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cursor<T>(items: T[]): MongoCursor<T> {
  return { toArray: async () => items };
}
