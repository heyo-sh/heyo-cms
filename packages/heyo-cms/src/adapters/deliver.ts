import type { CmsHandler } from "../types/instance";

/** What an adapter needs from the instance: the handler, and the outbox. */
export interface HandlerLike {
  handler: CmsHandler;
  /** `cms.drainEvents`, for delivering a write's events through `waitUntil`. */
  drainEvents?: (limit?: number) => Promise<number>;
}

export type WaitUntil = (promise: Promise<unknown>) => void;

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `cms.handler(request)`, and then the platform's `waitUntil` for a write.
 *
 * A commit starts delivering its events in the background, which a
 * long-running server finishes on its own. A serverless runtime may freeze
 * the moment the response is sent, leaving webhooks, listeners and plugins
 * such as `indexNow()` for the next request or the next cron; handing the
 * delivery to `waitUntil` keeps it alive. Reads have nothing to deliver and a
 * drain costs a query, so only the methods that write ask for one.
 *
 * Here rather than in `cms.handler`: a second parameter on the handler would
 * meet whatever a framework passes there — Next's `{ params }`, Bun's server
 * — and fail its type check.
 */
export async function handle(
  cms: HandlerLike,
  request: Request,
  waitUntil: WaitUntil | undefined,
): Promise<Response> {
  const response = await cms.handler(request);
  if (waitUntil && cms.drainEvents && !safeMethods.has(request.method)) {
    waitUntil(cms.drainEvents().catch(() => 0));
  }
  return response;
}

/** `context.waitUntil`, bound to its context, when the context has one. */
export function boundWaitUntil(context: unknown): WaitUntil | undefined {
  const target = context as { waitUntil?: WaitUntil } | null | undefined;
  const waitUntil = target?.waitUntil;
  return typeof waitUntil === "function" ? waitUntil.bind(target) : undefined;
}
