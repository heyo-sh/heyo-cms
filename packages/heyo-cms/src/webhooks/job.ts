import { and, eq, lte, or, orderBy } from "../query";
import type { JobDefinition, JobHost } from "../engine/jobs";
import type { Row } from "../types/query";
import type { WebhookRuntime } from "./service";

const deliveriesTable = "webhook_deliveries";

/**
 * The retry sweep.
 *
 * Registered in `cms.jobs` only when webhooks are enabled, so
 * `cms.inspect().jobs` lists what will actually run. The first attempt
 * happens inline, right after the commit: this is for the ones that did not
 * land, and it is the reason an outage at a subscriber costs them a delay
 * rather than the event.
 *
 * `exists` next to `lte` for the same reason the scheduled-change sweep needs
 * it: on MongoDB a missing `next_attempt_at` compares below a date, so a
 * delivery that has never been attempted would look due on every pass.
 */
export function webhookRetryJob(webhooks: WebhookRuntime): JobDefinition {
  return {
    name: "webhook-retries",
    failureType: "webhook.delivery",
    failurePayload: (row: Row) => ({
      deliveryId: String(row.id),
      webhookId: String(row.webhook_id),
      eventId: String(row.event_id),
      eventType: String(row.event_type),
      attempt: Number(row.attempt ?? 0),
    }),
    due: async (host: JobHost, now: Date, limit: number) => {
      const adapter = await host.database();
      return adapter.transaction((tx) =>
        adapter.query(tx, {
          table: deliveriesTable,
          where: and(
            eq("status", "pending"),
            or(eq("next_attempt_at", null), lte("next_attempt_at", now)),
          ),
          orderBy: [orderBy("next_attempt_at", "asc"), orderBy("id", "asc")],
          limit,
        }),
      );
    },
    // The row the runner selected, through the same attempt path a first
    // delivery takes: a retry and a first attempt cannot drift apart if
    // there is only one function that sends anything.
    run: async (_host: JobHost, row: Row, now: Date) => {
      await webhooks.attemptDelivery(String(row.id), now);
    },
  };
}
