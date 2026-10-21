import type { JsonObject } from "./json";

/**
 * The background work the engine owes.
 *
 * All three are sweeps rather than queues: a scheduled change is discovered
 * from `documents.scheduled_at`, an expired trash entry from
 * `documents.purge_after`, and a collectable file from `media.purge_after`.
 * Nothing has to be enqueued, so a schedule written by a migration, a seed
 * script or a `ctx.db` call in a hook is applied exactly like one written
 * through the API \u2014 there is no second place to remember.
 *
 * `media-gc` is registered only when the configuration has an `uploads`
 * section, so `cms.inspect().jobs` lists what will actually run.
 */
export type JobName =
  "scheduled-changes" | "trash-purge" | "media-gc" | (string & {});

export interface JobRunArgs {
  /** The moment the sweep runs as. Injectable so a test need not wait. */
  now?: Date;
  /** Documents examined per job in one call. Defaults to 100. */
  limit?: number;
  /** Runs only these jobs. Defaults to all registered ones. */
  only?: JobName[];
}

export interface JobResult {
  job: string;
  /** Items this run actually completed. */
  processed: number;
  /** Items that threw. Each one is recorded in `jobs` and emits `job.failed`. */
  failed: number;
  /**
   * Whether more work was waiting than `limit` allowed.
   *
   * A caller running the sweep from a cron can loop on it instead of
   * discovering a backlog by watching a number fail to fall.
   */
  more: boolean;
}

export interface JobRunReport {
  ranAt: string;
  processed: number;
  failed: number;
  results: JobResult[];
}

/**
 * A recorded failure.
 *
 * It carries the payload, which for a scheduled change is the patch itself:
 * the claim that removed the schedule from the document has already happened
 * by the time the write can fail, so this row is the only remaining copy and
 * losing it would lose the editor's work.
 */
export interface JobFailure {
  id: string;
  type: string;
  payload: JsonObject | null;
  error: string | null;
  attempts: number;
  createdAt: string | null;
}

export interface JobFailureArgs {
  limit?: number;
  type?: string;
}

/**
 * `cms.jobs`.
 *
 * Deliberately not a daemon: the CMS runs on Workers and on Lambda as much as
 * on a long-lived Node process, so the engine exposes the sweep and lets the
 * deployment decide what calls it \u2014 a cron route in stage 7, `wrangler`'s
 * scheduled handler, or a loop in `bun run dev`.
 */
export interface CmsJobs {
  /** Registered job names, in the order they run. */
  list(): string[];
  run(args?: JobRunArgs): Promise<JobRunReport>;
  failures(args?: JobFailureArgs): Promise<JobFailure[]>;
}
