import type { CollectionsConfig, ResolvedCmsConfig } from "./config";
import type { DatabaseAdapter, DatabaseCapabilities } from "./database";
import type { AnyEventType, CmsEventListener } from "./events";
import type { HookOperation } from "./hooks";
import type { RouteMethod } from "./plugin";
import type { SchemaSnapshot } from "./schema";

/** One entry of the hook pipeline, in the order it will actually run. */
export interface HookPipelineEntry {
  collection: string;
  operation: HookOperation;
  timing: "before" | "after";
  /** `config` or the id of the plugin that registered it. */
  source: string;
  priority: number;
}

export interface RouteInspection {
  method: RouteMethod;
  /** Including `basePath`, i.e. what a client actually calls. */
  path: string;
  source: string;
}

export interface CollectionInspection {
  name: string;
  slug: string;
  kind: "collection" | "global";
  fields: {
    name: string;
    type: string;
    localized: boolean;
    required: boolean;
  }[];
}

/**
 * What `cms.inspect()` answers.
 *
 * The auto-router and the plugin loader are only acceptable if their result is
 * printable: this is the antidote to "magic" (section 10). Everything the
 * engine decided — schema, hook order, routes — is readable from one call.
 */
export interface CmsInspection {
  basePath: string;
  database: { id: string; capabilities: DatabaseCapabilities };
  storage?: { id: string };
  collections: CollectionInspection[];
  schema: SchemaSnapshot;
  hooks: HookPipelineEntry[];
  routes: RouteInspection[];
  plugins: string[];
}

/**
 * The object `heyoCms()` returns.
 *
 * `handler` and `api` arrive with the engine and the router (stages 3 and 7);
 * declaring them before they exist would make the type lie, so they are added
 * to this interface in those stages rather than stubbed here.
 */
export interface CmsInstance<
  TCollections extends CollectionsConfig = CollectionsConfig,
> {
  /** Frozen, fully resolved configuration. */
  readonly _config: ResolvedCmsConfig;
  /** The schema the configuration implies; the `to` side of every migration. */
  readonly schema: SchemaSnapshot;
  readonly collections: TCollections;
  inspect(): CmsInspection;
  /** Resolves the adapter, building it on first use. */
  database(): Promise<DatabaseAdapter>;
  /** Subscribes to a committed event. Returns an unsubscribe function. */
  on(type: AnyEventType, listener: CmsEventListener): () => void;
  close(): Promise<void>;
}
