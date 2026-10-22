import { and, eq, exists, lte, orderBy } from "../query";
import { documentsTableName } from "../schema/snapshot";
import type { ResolvedCmsConfig } from "../types/config";
import type { DatabaseAdapter } from "../types/database";
import type {
  CmsJobs,
  JobFailure,
  JobFailureArgs,
  JobResult,
  JobRunArgs,
  JobRunReport,
} from "../types/jobs";
import type { JsonObject } from "../types/json";
import type { Row } from "../types/query";
import { asObject, scheduledPatch, toIso } from "./documents";

const jobsTable = "jobs";
const defaultLimit = 100;

/**
 * What a sweep needs from the engine.
 *
 * Narrow on purpose: a job may ask which rows are due and may ask the engine
 * to act on one of them, and it may not write a document itself. Every write
 * in the product goes through one function (stage 3), and a background worker
 * is exactly the kind of caller that would quietly grow a second one.
 */
export interface JobHost {
  config: ResolvedCmsConfig;
  database(): Promise<DatabaseAdapter>;
  applyScheduled(row: Row): Promise<void>;
  purgeExpired(row: Row): Promise<void>;
  recordFailure(
    type: string,
    payload: JsonObject,
    error: unknown,
  ): Promise<void>;
}

/**
 * One sweep.
 *
 * Split into "what is due" and "act on one of them" so the runner owns the
 * batching, the counting and the failure record, and a job only has to know
 * its own question. Exported because `media-gc` is registered through it, and
 * a plugin will eventually register its own the same way.
 */
export interface JobDefinition {
  name: string;
  /** Rows this job would act on, oldest obligation first. */
  due(host: JobHost, now: Date, limit: number): Promise<Row[]>;
  run(host: JobHost, row: Row, now: Date): Promise<void>;
  /** What a failure is recorded as in the `jobs` table. */
  failureType: string;
  failurePayload(row: Row): JsonObject;
}

/**
 * The scheduled change sweep.
 *
 * `exists` is not redundant next to `lte`: on MongoDB a missing or null field
 * sorts below a date and would therefore match `$lte`, which would hand every
 * unscheduled document in the database to the applier. Writing the guard once
 * here is the price of one query shape that behaves the same on three engines.
 */
const scheduledChanges: JobDefinition = {
  name: "scheduled-changes",
  failureType: "document.schedule",
  /**
   * The patch travels into the failure record.
   *
   * Applying a change claims it first — the document's `scheduled_patch` is
   * cleared before the write that can fail — so by the time anything throws,
   * this row, read before the claim, holds the only copy of what the editor
   * asked for. Recording the ids alone would lose it.
   */
  failurePayload: (row) => {
    const patch = scheduledPatch(row);
    return {
      collection: String(row.collection),
      documentId: String(row.id),
      ...(patch === null ? {} : { locale: patch.locale, patch: patch.data }),
      ...(row.scheduled_at instanceof Date
        ? { scheduledFor: row.scheduled_at.toISOString() }
        : {}),
    };
  },
  due: async (host, now, limit) => {
    const adapter = await host.database();
    return adapter.transaction((tx) =>
      adapter.query(tx, {
        table: documentsTableName,
        where: and(
          exists("scheduled_at", true),
          lte("scheduled_at", now),
          // A document in the trash keeps its schedule nowhere: trashing
          // clears it, so this only guards rows trashed by an older version.
          eq("deleted_at", null),
        ),
        orderBy: [orderBy("scheduled_at", "asc"), orderBy("id", "asc")],
        limit,
      }),
    );
  },
  run: (host, row) => host.applyScheduled(row),
};

const trashPurge: JobDefinition = {
  name: "trash-purge",
  failureType: "trash.purge",
  failurePayload: (row) => ({
    collection: String(row.collection),
    documentId: String(row.id),
  }),
  due: async (host, now, limit) => {
    // `purgeAfter: false` keeps deleted documents forever, so the sweep has
    // nothing to do rather than a shorter deadline to apply.
    if (host.config.trash.purgeAfter === false) return [];
    const adapter = await host.database();
    return adapter.transaction((tx) =>
      adapter.query(tx, {
        table: documentsTableName,
        where: and(
          exists("deleted_at", true),
          exists("purge_after", true),
          lte("purge_after", now),
        ),
        orderBy: [orderBy("purge_after", "asc"), orderBy("id", "asc")],
        limit,
      }),
    );
  },
  run: (host, row) => host.purgeExpired(row),
};

/**
 * `cms.jobs`.
 *
 * A registry rather than hard-coded calls: `media-gc` joins the two below only
 * when the configuration has an `uploads` section, a plugin will eventually
 * add its own, and `cms.inspect().jobs` has to print what will actually run
 * rather than what the package happens to contain.
 */
export class JobRunner implements CmsJobs {
  private readonly jobs: JobDefinition[] = [scheduledChanges, trashPurge];

  constructor(private readonly host: JobHost) {}

  list(): string[] {
    return this.jobs.map((job) => job.name);
  }

  /** Adds a sweep. Used by the media lifecycle, and later by plugins. */
  register(job: JobDefinition): void {
    this.jobs.push(job);
  }

  /**
   * One pass over everything that is due.
   *
   * A failing item never stops the sweep: one document whose scheduled change
   * no longer validates must not keep every other publication waiting. Each
   * failure is recorded with its payload and emitted as `job.failed`.
   */
  async run(args: JobRunArgs = {}): Promise<JobRunReport> {
    const now = args.now ?? new Date();
    const limit = args.limit ?? defaultLimit;
    const selected = args.only
      ? this.jobs.filter((job) => args.only?.includes(job.name))
      : this.jobs;

    const results: JobResult[] = [];
    for (const job of selected) {
      const rows = await job.due(this.host, now, limit + 1);
      const batch = rows.slice(0, limit);
      let processed = 0;
      let failed = 0;

      for (const row of batch) {
        try {
          await job.run(this.host, row, now);
          processed += 1;
        } catch (error) {
          failed += 1;
          // One row per failed item, written here rather than by whatever
          // threw: a failure recorded in two places is a failure counted
          // twice and retried twice.
          await this.host
            .recordFailure(job.failureType, job.failurePayload(row), error)
            .catch(() => undefined);
        }
      }

      results.push({
        job: job.name,
        processed,
        failed,
        more: rows.length > limit,
      });
    }

    return {
      ranAt: now.toISOString(),
      processed: results.reduce((total, entry) => total + entry.processed, 0),
      failed: results.reduce((total, entry) => total + entry.failed, 0),
      results,
    };
  }

  async failures(args: JobFailureArgs = {}): Promise<JobFailure[]> {
    const adapter = await this.host.database();
    const rows = await adapter.transaction((tx) =>
      adapter.query(tx, {
        table: jobsTable,
        where:
          args.type === undefined
            ? eq("status", "failed")
            : and(eq("status", "failed"), eq("type", args.type)),
        orderBy: [orderBy("created_at", "desc"), orderBy("id", "desc")],
        limit: args.limit ?? 50,
      }),
    );

    return rows.map((row) => ({
      id: String(row.id),
      type: String(row.type),
      payload: row.payload === null || row.payload === undefined ? null : asObject(row.payload), // prettier-ignore
      error: row.error === null || row.error === undefined ? null : String(row.error), // prettier-ignore
      attempts: Number(row.attempts ?? 0),
      createdAt: toIso(row.created_at),
    }));
  }
}
