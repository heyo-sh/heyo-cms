import type { ActorSource, OperationSource } from "./actor";
import type { JsonObject } from "./json";

/**
 * One line of the audit trail.
 *
 * Written by the engine inside the transaction that caused it, which is the
 * difference between an audit trail and a log: a change that committed is in
 * here, and a change that rolled back is not (section 11).
 */
export interface ActivityEntry {
  id: string;
  /** `document.created`, `document.trashed`, … — the event vocabulary. */
  action: string;
  actorId: string | null;
  actorSource: ActorSource | null;
  /**
   * Where the write came from: `admin`, `rest`, `job`, `ai`, …
   *
   * Distinct from `actorSource`, which says how the actor authenticated. An AI
   * write has a human actor with a session and `source: "ai"`, and a trail
   * that could only report one of those could not answer "what did the
   * assistant change today".
   */
  source: OperationSource | null;
  collection: string | null;
  documentId: string | null;
  locale: string | null;
  /**
   * `{ fields: [...] }` for a write: what actually changed.
   *
   * Carries `runId` as well when the assistant made the change, which is what
   * ties a row back to the conversation that caused it.
   */
  changes: JsonObject | null;
  ip: string | null;
  createdAt: string | null;
}

export interface ActivityListArgs {
  collection?: string;
  documentId?: string;
  actorId?: string;
  action?: string;
  /** `"ai"` answers "what did the assistant change" without a scan. */
  source?: OperationSource;
  limit?: number;
  /** Keyset, over the ordered id. Pass back `cursor` from the last page. */
  cursor?: string;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  limit: number;
  hasNextPage: boolean;
  cursor: string | null;
}

/**
 * `cms.activity`.
 *
 * Read-only on purpose: there is no `write` and no `delete`. The engine is the
 * only writer, and an audit trail with a delete method is a list of the
 * changes somebody was willing to leave behind.
 *
 * Paged by the row id rather than by `created_at`, because the ids are ordered
 * and two writes to the same document routinely land in the same millisecond.
 */
export interface CmsActivity {
  list(args?: ActivityListArgs): Promise<ActivityPage>;
}
