import type { Actor, OperationSource } from "./actor";
import type { AnyEventType, CmsEvent } from "./events";
import type { JsonObject } from "./json";

/**
 * Webhooks (stage 9, section 7).
 *
 * The delivery half of the outbox. An event is written inside the
 * transaction that caused it and delivered afterwards, so a rolled back
 * write sends nothing and a committed one sends even if the process dies a
 * line later — and a subscriber that is down does not slow a save down, it
 * accumulates retries.
 */

export interface WebhookFilters {
  collections?: string[];
  locales?: string[];
}

export interface WebhookSubscription {
  id: string;
  url: string;
  /** Event types, or prefixes: `document.*`, or `*` for everything. */
  events: string[];
  filters: WebhookFilters | null;
  headers: Record<string, string> | null;
  /** Whether this subscription signs with its own secret rather than the global one. */
  hasSecret: boolean;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * One attempt to hand one event to one subscriber.
 *
 * `pending` is waiting or being retried, `delivered` succeeded, `failed` is
 * out of attempts — the dead-letter queue is a status rather than a second
 * table, because a replay has to be able to put the same row back in flight.
 */
export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempt: number;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string | null;
  /** The exact body that was signed and sent. Present when asked for. */
  requestBody?: JsonObject | null;
}

export interface WebhookCreateArgs {
  url: string;
  events: string[];
  filters?: WebhookFilters;
  headers?: Record<string, string>;
  /** Overrides `webhooks.signing.secret` for this subscription. */
  secret?: string;
  active?: boolean;
  actor?: Actor | null;
  source?: OperationSource;
}

export interface WebhookUpdateArgs extends Partial<WebhookCreateArgs> {
  id: string;
}

export interface WebhookListArgs {
  /** Includes inactive subscriptions. They are included by default. */
  active?: boolean;
}

export interface WebhookDeliveryListArgs {
  webhookId?: string;
  status?: WebhookDeliveryStatus;
  eventId?: string;
  limit?: number;
  cursor?: string;
  /** Includes the request body, which can be large. */
  includeBody?: boolean;
}

export interface WebhookDeliveryPage {
  entries: WebhookDelivery[];
  limit: number;
  hasNextPage: boolean;
  cursor: string | null;
}

export interface WebhookTestArgs {
  id: string;
  actor?: Actor | null;
}

export interface WebhookRetryArgs {
  /** A delivery id. The replay is a new attempt carrying the same event id. */
  id: string;
  actor?: Actor | null;
}

/** What one sweep of the retry queue did. */
export interface WebhookDispatchReport {
  attempted: number;
  delivered: number;
  failed: number;
}

export interface CmsWebhooks {
  readonly enabled: boolean;
  list(args?: WebhookListArgs): Promise<WebhookSubscription[]>;
  get(id: string): Promise<WebhookSubscription | null>;
  create(args: WebhookCreateArgs): Promise<WebhookSubscription>;
  update(args: WebhookUpdateArgs): Promise<WebhookSubscription>;
  remove(args: { id: string; actor?: Actor | null }): Promise<boolean>;
  deliveries(args?: WebhookDeliveryListArgs): Promise<WebhookDeliveryPage>;
  /** Sends a synthetic `webhook.test` event to one subscription, now. */
  test(args: WebhookTestArgs): Promise<WebhookDelivery>;
  /** Replays a delivery: same event, new attempt, new row. */
  retry(args: WebhookRetryArgs): Promise<WebhookDelivery>;
  /**
   * Fans one committed event out to its subscribers.
   *
   * Called by the outbox worker after the commit. It never throws: a
   * subscriber that is down is a retry, not a failed event — making the
   * outbox row fail would replay the event to every *other* subscriber too.
   */
  dispatch(event: CmsEvent): Promise<void>;
  /** The `webhook-retries` sweep, also registered in `cms.jobs`. */
  drain(args?: { now?: Date; limit?: number }): Promise<WebhookDispatchReport>;
  /** Whether any active subscription wants this event type. */
  wants(type: AnyEventType): Promise<boolean>;
}
