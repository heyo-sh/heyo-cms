import type { OperationArgs } from "./api";
import type { JsonObject } from "./json";

/**
 * The trash, across every collection at once.
 *
 * The per-collection API already has `restore` and `purge`; this exists
 * because the panel's trash screen and `GET /trash` (section 10) are one list
 * of everything an editor deleted, and building that by asking every
 * collection in turn would page wrongly and count wrongly.
 */
export interface TrashListArgs extends OperationArgs {
  /** Collection name. Omitted means every collection the actor may read. */
  collection?: string;
  limit?: number;
  cursor?: string;
}

export interface TrashedEntry {
  collection: string;
  id: string;
  deletedAt: string | null;
  /** When the purge job will remove it; `null` when retention is off. */
  purgeAfter: string | null;
  /** The document itself, with field-level read access already applied. */
  document: JsonObject;
}

export interface TrashPage {
  entries: TrashedEntry[];
  limit: number;
  hasNextPage: boolean;
  cursor: string | null;
}

export interface TrashTargetArgs extends OperationArgs {
  collection: string;
  id: string;
}

export interface CmsTrash {
  /** Newest deletion first. Keyset-paged, like every other list. */
  list(args?: TrashListArgs): Promise<TrashPage>;
  restore(args: TrashTargetArgs): Promise<JsonObject | null>;
  purge(args: TrashTargetArgs): Promise<JsonObject | null>;
}
