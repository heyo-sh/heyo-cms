import { CmsError } from "../errors";
import { and, eq, inList } from "../query";
import { documentsTableName } from "../schema/snapshot";
import type { Actor } from "../types/actor";
import type { RbacConfig, ResolvedCollection } from "../types/config";
import type { DatabaseAdapter } from "../types/database";
import type { FieldDefinition } from "../types/fields";
import type { JsonObject, JsonValue } from "../types/json";
import type { Tx } from "../types/query";
import { rowToDocument, systemRowToJson } from "./documents";
import { accessFilter } from "./access";
import { applyFieldReadAccess } from "./field-access";
import type { LocaleContext } from "./locales";

export interface RelationLoaderOptions {
  adapter: DatabaseAdapter;
  tx: Tx;
  locale: LocaleContext;
  /** Every declared collection and global, keyed by name. */
  collections: Record<string, ResolvedCollection>;
  includeTrashed?: boolean;
  /**
   * Whose read this is.
   *
   * A related document is filtered by the rules of the collection it belongs
   * to, not by the one that pointed at it: `depth` must not be a way to read
   * a field through a relation that cannot be read directly.
   */
  actor?: Actor | null;
  rbac?: RbacConfig | undefined;
}

/**
 * `depth`, resolved by batching instead of by joining.
 *
 * Collect the ids at this level, run one query per target collection, then
 * recurse. The query count depends on the shape of the schema, never on the
 * number of documents — which is the N+1 problem Payload users hit with
 * `depth`, and the reason section 12 rules joins out: one batching strategy
 * works identically on Postgres, SQLite and MongoDB.
 */
export class RelationLoader {
  /** Shared across levels, so a document fetched once is never fetched again. */
  private readonly cache = new Map<string, JsonObject | null>();
  /** Counted so a test can assert the absence of N+1 rather than infer it. */
  private queries = 0;

  constructor(private readonly options: RelationLoaderOptions) {}

  get queryCount(): number {
    return this.queries;
  }

  async expand(
    documents: JsonObject[],
    collection: ResolvedCollection,
    depth: number,
  ): Promise<void> {
    if (depth <= 0 || documents.length === 0) return;

    const relations = Object.entries(collection.fields)
      .map(([name, field]) => ({ name, target: relationTarget(field) }))
      .filter((entry): entry is { name: string; target: string } =>
        Boolean(entry.target),
      );
    if (relations.length === 0) return;

    const wanted = new Map<string, Set<string>>();
    for (const document of documents) {
      for (const relation of relations) {
        for (const id of idsOf(document[relation.name])) {
          if (this.cache.has(cacheKey(relation.target, id))) continue;
          const bucket = wanted.get(relation.target) ?? new Set<string>();
          bucket.add(id);
          wanted.set(relation.target, bucket);
        }
      }
    }

    for (const [target, ids] of wanted) {
      await this.load(target, [...ids]);
    }

    const loaded = new Map<string, JsonObject[]>();
    for (const document of documents) {
      for (const relation of relations) {
        const value = document[relation.name];
        document[relation.name] = this.substitute(
          relation.target,
          value,
          loaded,
        );
      }
    }

    // One recursion per target, not per document: the level below is batched
    // exactly like this one.
    for (const [target, children] of loaded) {
      const childCollection = this.options.collections[target];
      if (childCollection) {
        await this.expand(children, childCollection, depth - 1);
      }
    }
  }

  private async load(target: string, ids: string[]): Promise<void> {
    const collection = this.options.collections[target];
    this.queries += 1;

    if (collection) {
      for (const id of ids) this.cache.set(cacheKey(target, id), null);
      let granted;
      try {
        granted = await accessFilter(collection, {
          actor: this.options.actor ?? null,
          operation: "read",
          locale: this.options.locale.locale,
          rbac: this.options.rbac,
        });
      } catch (error) {
        // A denied target stays an id; a relation grants no new permissions.
        if (
          error instanceof CmsError &&
          (error.status === 401 || error.status === 403)
        )
          return;
        throw error;
      }
      const conditions = [
        granted,
        eq("collection", collection.slug),
        inList("id", ids),
        ...(this.options.includeTrashed ? [] : [eq("deleted_at", null)]),
      ];
      const rows = await this.options.adapter.query(this.options.tx, {
        table: documentsTableName,
        where: and(...conditions),
      });
      for (const id of ids) this.cache.set(cacheKey(target, id), null);
      for (const row of rows) {
        const document = rowToDocument(row, collection, this.options.locale);
        this.cache.set(
          cacheKey(target, String(row.id)),
          applyFieldReadAccess(
            document,
            collection,
            this.options.actor ?? null,
            this.options.locale.locale,
          ),
        );
      }
      return;
    }

    // System tables are not public documents. Never expand credentials,
    // sessions, token hashes, webhook secrets or operational payloads.
    // Authors expose only a public byline; everything else stays an id.
    for (const id of ids) this.cache.set(cacheKey(target, id), null);
    if (target !== "media" && target !== "cms_users") return;
    const rows = await this.options.adapter.query(this.options.tx, {
      table: target,
      where: inList("id", ids),
      ...(target === "cms_users" ? { select: ["id", "name"] } : {}),
    });
    for (const id of ids) this.cache.set(cacheKey(target, id), null);
    for (const row of rows) {
      this.cache.set(cacheKey(target, String(row.id)), systemRowToJson(row));
    }
  }

  /**
   * Replaces ids with documents, remembering what was replaced so the next
   * level can be batched. A reference that no longer resolves stays an id
   * rather than becoming `null`: losing the value would hide the dangling
   * reference instead of reporting it.
   */
  private substitute(
    target: string,
    value: JsonValue | undefined,
    loaded: Map<string, JsonObject[]>,
  ): JsonValue {
    const remember = (document: JsonObject): JsonObject => {
      // Expand a copy, not the cached raw document. Self-relations and
      // A → B → A otherwise build circular JS objects that JSON cannot serve.
      const copy = structuredClone(document);
      const bucket = loaded.get(target) ?? [];
      bucket.push(copy);
      loaded.set(target, bucket);
      return copy;
    };

    if (typeof value === "string") {
      const found = this.cache.get(cacheKey(target, value));
      return found ? remember(found) : value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => {
        if (typeof entry !== "string") return entry;
        const found = this.cache.get(cacheKey(target, entry));
        return found ? remember(found) : entry;
      });
    }
    return value ?? null;
  }
}

/**
 * What a field points at.
 *
 * `media` is a relation that does not spell it out: the value is an id in the
 * `media` table, which is what makes the usage counting in section 6
 * possible. Treating it as one here means `depth` resolves a cover image.
 */
export function relationTarget(field: FieldDefinition): string | undefined {
  if (field.relationTo) return field.relationTo;
  return field.type === "media" ? "media" : undefined;
}

function idsOf(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function cacheKey(target: string, id: string): string {
  return `${target}:${id}`;
}
