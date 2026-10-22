import { parseDuration } from "../duration";
import type { Duration } from "../types/config";
import type { CmsInstance } from "../types/instance";
import type { JobRunArgs, JobRunReport } from "../types/jobs";

/**
 * Something has to call `cms.jobs.run()`.
 *
 * The package deliberately starts no timer of its own (stage 5): it has to
 * load on Workers and on Lambda, where a `setInterval` either does nothing
 * or keeps an invocation alive and bills for it. So the sweeps are a
 * function, and this file is the two ways a deployment calls it — a timer
 * for a process that has one, and a handler for a platform that owns the
 * clock.
 *
 * Both do the same two things in the same order: run what is due, then drain
 * the outbox. The second part is not optional on serverless, where the
 * process freezes the moment the handler returns and anything still in the
 * outbox waits for the next cron.
 */
export interface RunDueOptions extends JobRunArgs {
  /** Delivers the events the sweep produced before returning. Default true. */
  drainEvents?: boolean;
}

export async function runDueJobs(
  cms: CmsInstance,
  options: RunDueOptions = {},
): Promise<JobRunReport> {
  const { drainEvents = true, ...args } = options;
  const report = await cms.jobs.run(args);
  if (drainEvents) await cms.drainEvents();
  return report;
}

export interface JobRunnerOptions extends RunDueOptions {
  cms: CmsInstance;
  /** How often to sweep. Defaults to one minute. */
  interval?: Duration | number;
  /** Runs one sweep immediately instead of waiting for the first tick. */
  immediate?: boolean;
  onReport?: (report: JobRunReport) => void;
  /**
   * Called when a sweep throws.
   *
   * A sweep that throws is a database that is unreachable, not a job that
   * failed — individual failures are recorded and counted inside the report.
   * Default: log to `console.error`, because a background loop that swallows
   * its own outage is worse than a noisy one.
   */
  onError?: (error: unknown) => void;
  /** Stops the loop. The same signal a server shutdown already has. */
  signal?: AbortSignal;
}

export interface JobRunnerHandle {
  /** Runs one sweep now, outside the schedule. */
  runNow(): Promise<JobRunReport>;
  /** Stops the loop and waits for a sweep in flight. */
  stop(): Promise<void>;
  readonly running: boolean;
}

/**
 * The Node and Bun answer: a timer that never overlaps itself.
 *
 * Overlap is the failure that matters here. A sweep that takes longer than
 * the interval — a backlog of scheduled changes, a slow webhook endpoint —
 * would otherwise start a second pass over the same rows, and every job in
 * the product claims its row before acting precisely because that must stay
 * harmless. Not starting the second pass is cheaper than relying on it.
 */
export function startJobRunner(options: JobRunnerOptions): JobRunnerHandle {
  const {
    cms,
    interval = 60_000,
    immediate = true,
    onReport,
    onError,
    signal,
    ...rest
  } = options;

  const every =
    typeof interval === "number" ? interval : parseDuration(interval);
  let stopped = false;
  let inFlight: Promise<JobRunReport> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sweep = async (): Promise<JobRunReport> => {
    const run = runDueJobs(cms, rest);
    inFlight = run;
    try {
      const report = await run;
      onReport?.(report);
      return report;
    } finally {
      inFlight = null;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void sweep()
        .catch((error: unknown) => {
          if (onError) onError(error);
          else console.error("[heyo-cms] job sweep failed:", error);
        })
        .finally(schedule);
    }, every);
    // The loop must not be the reason a CLI refuses to exit.
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  const handle: JobRunnerHandle = {
    runNow: () => sweep(),
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight?.catch(() => undefined);
    },
    get running() {
      return !stopped;
    },
  };

  signal?.addEventListener("abort", () => void handle.stop(), { once: true });

  if (immediate) {
    void sweep()
      .catch((error: unknown) => {
        if (onError) onError(error);
        else console.error("[heyo-cms] job sweep failed:", error);
      })
      .finally(schedule);
  } else {
    schedule();
  }

  return handle;
}

/**
 * The Workers answer: the platform owns the clock.
 *
 * ```ts
 * export default {
 *   fetch: (request) => cms.handler(request),
 *   scheduled: cmsScheduled(cms),
 * };
 * ```
 *
 * `waitUntil` is used when the platform provides it, so the outbox drain is
 * allowed to outlive the handler rather than being killed halfway through a
 * webhook.
 */
export function cmsScheduled(
  cms: CmsInstance,
  options: RunDueOptions = {},
): (
  event: unknown,
  env?: unknown,
  context?: { waitUntil?: (promise: Promise<unknown>) => void },
) => Promise<void> {
  return async (_event, _env, context) => {
    const work = runDueJobs(cms, options);
    context?.waitUntil?.(work);
    await work;
  };
}
