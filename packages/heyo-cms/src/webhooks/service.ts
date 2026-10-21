import { cursorWhere, encodeCursor } from "../engine/cursor";
import { asObject, toIso } from "../engine/documents";
import { scopedDb } from "../engine/scoped-db";
import { parseDuration } from "../duration";
import { CmsError } from "../errors";
import { createId, createOrderedId } from "../ids";
import { and, eq, lte, or, orderBy } from "../query";
import type { ResolvedCmsConfig } from "../types/config";
import type { DatabaseAdapter } from "../types/database";
import type { AnyEventType, CmsEvent } from "../types/events";
import type { JsonObject, JsonValue } from "../types/json";
import type { OrderBy, Row, Tx, Where } from "../types/query";
import type {
  CmsWebhooks,
  WebhookCreateArgs,
  WebhookDelivery,
  WebhookDeliveryListArgs,
  WebhookDeliveryPage,
  WebhookDispatchReport,
  WebhookFilters,
  WebhookListArgs,
  WebhookRetryArgs,
  WebhookSubscription,
  WebhookTestArgs,
  WebhookUpdateArgs,
} from "../types/webhooks";
import type { BufferedEvent, OutboxEntryMeta } from "../engine/outbox";
import { signatureHeader, signPayload } from "./sign";

const webhooksTable = "webhooks";
const deliveriesTable = "webhook_deliveries";
const defaultLimit = 25;
const maxLimit = 200;
const defaultRetries = 5;
const defaultTimeout = "10s";

/**
 * The service, plus the one operation only a sweep needs.
 *
 * `cms.webhooks` is the public `CmsWebhooks`; the runner holds this. Keeping
 * "re-attempt this exact row" off the public type is deliberate: a caller
 * that wants to re-send something wants `retry()`, which records a new
 * attempt instead of quietly rewriting the history of an old one.
 */
export interface WebhookRuntime extends CmsWebhooks {
  attemptDelivery(id: string, at?: Date): Promise<WebhookDelivery | null>;
}

/**
 * What the service needs from `fetch`, and no more.
 *
 * Narrower than `typeof fetch` on purpose: that type carries whatever the
 * host runtime bolted on — Bun adds `preconnect` — and a package that has to
 * build the same way on Node, Bun and Workers cannot depend on which one is
 * compiling it.
 */
export type WebhookFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface WebhookServiceOptions {
  config: ResolvedCmsConfig;
  database(): Promise<DatabaseAdapter>;
  emit(tx: Tx, events: BufferedEvent[], meta: OutboxEntryMeta): Promise<void>;
  deliver(): void;
  /** Injectable so a test does not need a socket. Defaults to `fetch`. */
  fetch?: WebhookFetch;
  now?: () => Date;
}

/**
 * `cms.webhooks`.
 *
 * The contract, in one place, is section 7:
 *
 * - **Signed.** Every request carries an HMAC over `timestamp.body`, so a
 *   receiver can tell a delivery from a stranger with a URL.
 * - **Identified.** `x-heyo-event-id` and `x-heyo-delivery-id` let a consumer
 *   be idempotent, which matters because retries are a promise rather than an
 *   accident.
 * - **Retried, then parked.** Five attempts with exponential backoff, then
 *   the delivery is `failed` and stays in the table for replay. A dead letter
 *   that disappears is a dead letter nobody can act on.
 * - **Ordered per document, not globally.** The outbox is drained in
 *   insertion order and a document's events are inserted in the order they
 *   happened; across documents, parallel delivery is the point.
 */
export function createWebhooks(options: WebhookServiceOptions): WebhookRuntime {
  const { config } = options;
  // Resolved per call rather than captured: a runtime that installs its own
  // `fetch` after the module loads — a Worker shim, a test double — would
  // otherwise be ignored by the one thing in the product that makes
  // outbound requests.
  const send: WebhookFetch = (url, init) =>
    (options.fetch ?? globalThis.fetch)(url, init);
  const now = options.now ?? (() => new Date());
  const settings = config.webhooks;
  const retries = settings?.delivery?.retries ?? defaultRetries;
  const timeoutMs = parseDuration(
    settings?.delivery?.timeout ?? defaultTimeout,
  );
  const dlq = settings?.delivery?.dlq !== false;
  const linear = settings?.delivery?.backoff === "linear";

  const requireEnabled = (): void => {
    if (settings?.enabled) return;
    throw new CmsError(
      "Webhooks are switched off; set webhooks.enabled to true.",
      { status: 501, code: "webhooks_disabled" },
    );
  };

  const backoff = (attempt: number): number =>
    linear ? attempt * 30_000 : Math.min(3_600_000, 1000 * 2 ** attempt);

  const subscriptions = async (): Promise<Row[]> => {
    const adapter = await options.database();
    return adapter.transaction((tx) =>
      adapter.query(tx, { table: webhooksTable, where: eq("active", true) }),
    );
  };

  /**
   * One attempt, recorded whichever way it goes.
   *
   * The row is written before the request leaves and updated after it
   * returns, so a process that dies mid-flight leaves a `pending` row the
   * sweep will pick up rather than a delivery nobody remembers making.
   */
  const attempt = async (
    row: Row,
    subscription: Row,
    body: string,
    at: Date = now(),
  ): Promise<WebhookDelivery> => {
    const adapter = await options.database();
    const attemptNumber = Number(row.attempt ?? 0) + 1;
    // next_attempt_at doubles as a lease while the HTTP request is in flight.
    // Claim with a compare-and-swap so overlapping cron/request workers cannot
    // send the same attempt, and a process crash is retried after expiry.
    const claim = await adapter.transaction((tx) =>
      adapter.mutate(tx, {
        kind: "update",
        table: deliveriesTable,
        where: and(
          eq("id", String(row.id)),
          eq("status", "pending"),
          eq("attempt", Number(row.attempt ?? 0)),
          eq(
            "next_attempt_at",
            row.next_attempt_at == null
              ? null
              : new Date(toIso(row.next_attempt_at)!),
          ),
          or(eq("next_attempt_at", null), lte("next_attempt_at", at)),
        ),
        set: {
          attempt: attemptNumber,
          next_attempt_at: new Date(at.getTime() + timeoutMs + 30_000),
        },
        returning: false,
      }),
    );
    if (claim.count !== 1) return toDelivery(row);
    if (attemptNumber > retries) {
      const failed: Row = {
        status: "failed",
        next_attempt_at: null,
        error: "Delivery lease expired; attempt budget exhausted.",
      };
      await adapter.transaction((tx) =>
        scopedDb(adapter, tx).update(
          deliveriesTable,
          and(eq("id", String(row.id)), eq("attempt", attemptNumber)),
          failed,
        ),
      );
      return toDelivery({ ...row, ...failed, attempt: attemptNumber });
    }
    const secret =
      (typeof subscription.secret === "string" && subscription.secret) ||
      settings?.signing?.secret ||
      "";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "heyo-cms",
      "x-heyo-event-id": String(row.event_id),
      "x-heyo-event-type": String(row.event_type),
      "x-heyo-delivery-id": String(row.id),
      "x-heyo-attempt": String(attemptNumber),
      ...asHeaders(subscription.headers),
    };
    if (secret.length > 0) {
      headers[signatureHeader] = await signPayload(body, secret);
    }

    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let error: string | null = null;

    try {
      const response = await send(String(subscription.url), {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      responseStatus = response.status;
      // Capped: a receiver that answers with its whole homepage must not
      // turn the delivery log into the largest table in the database.
      responseBody = await readResponsePreview(response);
      if (!response.ok) error = `Responded ${response.status}.`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    const succeeded = error === null;
    const exhausted = attemptNumber >= retries;
    const timestamp = now();
    const set: Row = succeeded
      ? {
          status: "delivered",
          attempt: attemptNumber,
          response_status: responseStatus,
          response_body: responseBody,
          error: null,
          next_attempt_at: null,
          delivered_at: timestamp,
        }
      : {
          // `failed` is the dead-letter queue. With `dlq: false` the row is
          // still marked failed — dropping it would be the only way to make
          // "it was never delivered" unanswerable.
          status: exhausted ? "failed" : "pending",
          attempt: attemptNumber,
          response_status: responseStatus,
          response_body: responseBody,
          error,
          next_attempt_at: exhausted
            ? null
            : new Date(timestamp.getTime() + backoff(attemptNumber)),
          delivered_at: null,
        };

    const updated = await adapter.transaction(async (tx) => {
      const db = scopedDb(adapter, tx);
      await db.update(
        deliveriesTable,
        and(
          eq("id", String(row.id)),
          eq("status", "pending"),
          eq("attempt", attemptNumber),
        ),
        set,
      );
      return { ...row, ...set };
    });

    if (!succeeded && exhausted && dlq) {
      // A dead letter is a fact about this deployment, so it goes through the
      // same outbox everything else does — which also means a subscriber can
      // subscribe to other subscribers failing.
      const adapterForEvent = await options.database();
      await adapterForEvent.transaction((tx) =>
        options.emit(
          tx,
          [
            {
              type: "job.failed",
              data: {
                job: "webhook-delivery",
                webhookId: String(row.webhook_id),
                deliveryId: String(row.id),
                eventId: String(row.event_id),
                eventType: String(row.event_type),
                attempts: attemptNumber,
                error: error ?? "unknown",
              },
              previous: null,
            },
          ],
          { actor: null },
        ),
      );
      options.deliver();
    }

    return toDelivery(updated);
  };

  const queue = async (
    subscription: Row,
    event: CmsEvent,
  ): Promise<WebhookDelivery> => {
    const adapter = await options.database();
    const body = JSON.stringify(event);
    // Stable across outbox retries. A partial fan-out must not duplicate the
    // deliveries already queued for earlier subscriptions.
    const id = `whd_${event.id}_${String(subscription.id)}`;
    const existing = await adapter.transaction((tx) =>
      scopedDb(adapter, tx).findOne(deliveriesTable, eq("id", id)),
    );
    if (existing) return toDelivery(existing);
    const row = await adapter.transaction(async (tx) => {
      const db = scopedDb(adapter, tx);
      return db.insert(deliveriesTable, {
        id,
        webhook_id: String(subscription.id),
        event_id: event.id,
        event_type: event.type,
        status: "pending",
        attempt: 0,
        request_body: event as unknown as JsonValue,
        response_status: null,
        response_body: null,
        error: null,
        next_attempt_at: now(),
        delivered_at: null,
        created_at: now(),
      });
    });
    return attempt(row, subscription, body);
  };

  return {
    get enabled() {
      return settings?.enabled === true;
    },

    async list(args: WebhookListArgs = {}): Promise<WebhookSubscription[]> {
      requireEnabled();
      const adapter = await options.database();
      const rows = await adapter.transaction((tx) =>
        adapter.query(tx, {
          table: webhooksTable,
          ...(args.active === undefined ? {} : { where: eq("active", args.active) }), // prettier-ignore
          orderBy: [orderBy("created_at", "desc"), orderBy("id", "desc")],
        }),
      );
      return rows.map(toSubscription);
    },

    async get(id: string): Promise<WebhookSubscription | null> {
      requireEnabled();
      const adapter = await options.database();
      const row = await adapter.transaction(async (tx) =>
        scopedDb(adapter, tx).findOne(webhooksTable, eq("id", id)),
      );
      return row ? toSubscription(row) : null;
    },

    async create(args: WebhookCreateArgs): Promise<WebhookSubscription> {
      requireEnabled();
      assertUrl(args.url);
      assertEvents(args.events);

      const adapter = await options.database();
      const timestamp = now();
      const created = await adapter.transaction(async (tx) => {
        const db = scopedDb(adapter, tx);
        const row = await db.insert(webhooksTable, {
          id: createId("whk"),
          url: args.url,
          events: args.events as unknown as JsonValue,
          filters: (args.filters ?? null) as unknown as JsonValue,
          headers: (args.headers ?? null) as unknown as JsonValue,
          secret: args.secret ?? null,
          active: args.active !== false,
          created_at: timestamp,
          updated_at: timestamp,
        });
        return toSubscription(row);
      });
      return created;
    },

    async update(args: WebhookUpdateArgs): Promise<WebhookSubscription> {
      requireEnabled();
      if (args.url !== undefined) assertUrl(args.url);
      if (args.events !== undefined) assertEvents(args.events);

      const adapter = await options.database();
      return adapter.transaction(async (tx) => {
        const db = scopedDb(adapter, tx);
        const existing = await db.findOne(webhooksTable, eq("id", args.id));
        if (!existing) throw CmsError.notFound("No such webhook.");

        const set: Row = { updated_at: now() };
        if (args.url !== undefined) set.url = args.url;
        if (args.events !== undefined) set.events = args.events as unknown as JsonValue; // prettier-ignore
        if (args.filters !== undefined) set.filters = args.filters as unknown as JsonValue; // prettier-ignore
        if (args.headers !== undefined) set.headers = args.headers as unknown as JsonValue; // prettier-ignore
        if (args.secret !== undefined) set.secret = args.secret;
        if (args.active !== undefined) set.active = args.active;

        await db.update(webhooksTable, eq("id", args.id), set);
        const row = await db.findOne(webhooksTable, eq("id", args.id));
        return toSubscription(row ?? { ...existing, ...set });
      });
    },

    async remove(args: { id: string }): Promise<boolean> {
      requireEnabled();
      const adapter = await options.database();
      return adapter.transaction(async (tx) => {
        const db = scopedDb(adapter, tx);
        // The deliveries go with it: they are the history of this
        // subscription and mean nothing without it. The foreign key says so
        // too, but saying it here keeps MongoDB honest.
        await db.delete(deliveriesTable, eq("webhook_id", args.id));
        const count = await db.delete(webhooksTable, eq("id", args.id));
        return count > 0;
      });
    },

    async deliveries(
      args: WebhookDeliveryListArgs = {},
    ): Promise<WebhookDeliveryPage> {
      requireEnabled();
      const adapter = await options.database();
      const limit = Math.min(maxLimit, Math.max(1, args.limit ?? defaultLimit));
      const order: OrderBy[] = [
        orderBy("created_at", "desc"),
        orderBy("id", "desc"),
      ];

      const filters: Where[] = [];
      if (args.webhookId) filters.push(eq("webhook_id", args.webhookId));
      if (args.status) filters.push(eq("status", args.status));
      if (args.eventId) filters.push(eq("event_id", args.eventId));
      const where = filters.length === 0 ? undefined : and(...filters);

      const rows = await adapter.transaction((tx) =>
        adapter.query(tx, {
          table: deliveriesTable,
          ...(args.cursor
            ? {
                where:
                  where === undefined
                    ? cursorWhere(args.cursor, order)
                    : and(where, cursorWhere(args.cursor, order)),
              }
            : where === undefined
              ? {}
              : { where }),
          orderBy: order,
          limit: limit + 1,
        }),
      );

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page.map((row) => toDelivery(row, args.includeBody === true)),
        limit,
        hasNextPage: rows.length > limit,
        cursor: last ? encodeCursor(last, order) : null,
      };
    },

    async test(args: WebhookTestArgs): Promise<WebhookDelivery> {
      requireEnabled();
      const adapter = await options.database();
      const subscription = await adapter.transaction(async (tx) =>
        scopedDb(adapter, tx).findOne(webhooksTable, eq("id", args.id)),
      );
      if (!subscription) throw CmsError.notFound("No such webhook.");

      const actor = args.actor ?? null;
      const event: CmsEvent = {
        id: createId("evt"),
        type: "webhook.test",
        createdAt: now().toISOString(),
        actor: actor ? { id: actor.id, source: actor.source } : null,
        data: {
          message:
            "A test delivery from Heyo CMS. Verify the signature exactly as you would for a real event.",
          webhookId: String(subscription.id),
        },
        previous: null,
      };
      return queue(subscription, event);
    },

    async retry(args: WebhookRetryArgs): Promise<WebhookDelivery> {
      requireEnabled();
      const adapter = await options.database();
      const { delivery, subscription } = await adapter.transaction(
        async (tx) => {
          const db = scopedDb(adapter, tx);
          const row = await db.findOne(deliveriesTable, eq("id", args.id));
          if (!row) throw CmsError.notFound("No such delivery.");
          const parent = await db.findOne(
            webhooksTable,
            eq("id", String(row.webhook_id)),
          );
          if (!parent) throw CmsError.notFound("That webhook is gone.");
          return { delivery: row, subscription: parent };
        },
      );

      // A replay is a new row carrying the same event id. The consumer's
      // idempotency key therefore still matches, and the original attempt —
      // including the response that failed — stays readable in the panel.
      const body = JSON.stringify(delivery.request_body ?? {});
      const fresh = await adapter.transaction(async (tx) =>
        scopedDb(adapter, tx).insert(deliveriesTable, {
          id: createOrderedId("whd"),
          webhook_id: String(subscription.id),
          event_id: String(delivery.event_id),
          event_type: String(delivery.event_type),
          status: "pending",
          attempt: 0,
          request_body: (delivery.request_body ?? null) as JsonValue,
          response_status: null,
          response_body: null,
          error: null,
          next_attempt_at: now(),
          delivered_at: null,
          created_at: now(),
        }),
      );
      return attempt(fresh, subscription, body);
    },

    async attemptDelivery(
      id: string,
      at = now(),
    ): Promise<WebhookDelivery | null> {
      const adapter = await options.database();
      const found = await adapter.transaction(async (tx) => {
        const db = scopedDb(adapter, tx);
        const row = await db.findOne(deliveriesTable, eq("id", id));
        if (!row || row.status !== "pending") return null;
        const subscription = await db.findOne(
          webhooksTable,
          eq("id", String(row.webhook_id)),
        );
        return subscription ? { row, subscription } : null;
      });
      if (!found) return null;
      return attempt(
        found.row,
        found.subscription,
        JSON.stringify(found.row.request_body ?? {}),
        at,
      );
    },

    async dispatch(event: CmsEvent): Promise<void> {
      if (settings?.enabled !== true) return;
      const rows = await subscriptions();
      for (const subscription of rows) {
        if (!matches(subscription, event)) continue;
        await queue(subscription, event);
      }
      // Network failures are recorded by attempt(). Database failures must
      // propagate so the outbox retries durable fan-out instead of losing it.
    },

    async drain(
      args: { now?: Date; limit?: number } = {},
    ): Promise<WebhookDispatchReport> {
      const report: WebhookDispatchReport = {
        attempted: 0,
        delivered: 0,
        failed: 0,
      };
      if (settings?.enabled !== true) return report;

      const adapter = await options.database();
      const at = args.now ?? now();
      const rows = await adapter.transaction((tx) =>
        adapter.query(tx, {
          table: deliveriesTable,
          where: and(
            eq("status", "pending"),
            or(eq("next_attempt_at", null), lte("next_attempt_at", at)),
          ),
          orderBy: [orderBy("next_attempt_at", "asc"), orderBy("id", "asc")],
          limit: args.limit ?? 50,
        }),
      );

      for (const row of rows) {
        const subscription = await adapter.transaction(async (tx) =>
          scopedDb(adapter, tx).findOne(
            webhooksTable,
            eq("id", String(row.webhook_id)),
          ),
        );
        if (!subscription) continue;
        report.attempted += 1;
        const result = await attempt(
          row,
          subscription,
          JSON.stringify(row.request_body ?? {}),
          at,
        );
        if (result.status === "delivered") report.delivered += 1;
        else if (result.status === "failed") report.failed += 1;
      }
      return report;
    },

    async wants(type: AnyEventType): Promise<boolean> {
      if (settings?.enabled !== true) return false;
      const rows = await subscriptions();
      return rows.some((row) => subscribedTo(row, type));
    },
  };
}

/** Bound memory even when a receiver responds with an unbounded body. */
async function readResponsePreview(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < 2000) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.slice(0, 2000 - size);
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Whether a subscription wants an event.
 *
 * `*` is everything, `document.*` is a family, and an exact type is itself.
 * Prefix matching exists because the catalogue grows: a subscriber that asked
 * for `document.*` in order to keep a search index in sync should receive the
 * event this CMS adds next year without editing its subscription.
 */
function subscribedTo(subscription: Row, type: AnyEventType): boolean {
  const events = toStringArray(subscription.events);
  return events.some((pattern) => {
    if (pattern === "*" || pattern === type) return true;
    if (!pattern.endsWith("*")) return false;
    return type.startsWith(pattern.slice(0, -1));
  });
}

function matches(subscription: Row, event: CmsEvent): boolean {
  if (!subscribedTo(subscription, event.type)) return false;

  const filters = (subscription.filters ?? null) as WebhookFilters | null;
  if (!filters) return true;

  const data = event.data;
  if (filters.collections?.length) {
    const collection = typeof data.collection === "string" ? data.collection : null; // prettier-ignore
    // An event with no collection — a locale, an API key — is not about any
    // collection, so a collection filter excludes it rather than passing it
    // through. The filter is a statement about what the subscriber wants.
    if (!collection || !filters.collections.includes(collection)) return false;
  }
  if (filters.locales?.length) {
    const locales = eventLocales(data);
    if (
      locales.length > 0 &&
      !locales.some((locale) => filters.locales?.includes(locale))
    ) {
      // prettier-ignore
      return false;
    }
  }
  return true;
}

function eventLocales(data: JsonObject): string[] {
  if (typeof data.locale === "string") return [data.locale];
  if (Array.isArray(data.locales)) {
    return data.locales.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// Row mapping and validation
// ---------------------------------------------------------------------------

function toSubscription(row: Row): WebhookSubscription {
  return {
    id: String(row.id),
    url: String(row.url),
    events: toStringArray(row.events),
    filters: row.filters ? (asObject(row.filters) as WebhookFilters) : null,
    headers: row.headers
      ? (asObject(row.headers) as Record<string, string>)
      : null,
    hasSecret: typeof row.secret === "string" && row.secret.length > 0,
    active: row.active === true || row.active === 1,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toDelivery(row: Row, includeBody = false): WebhookDelivery {
  return {
    id: String(row.id),
    webhookId: String(row.webhook_id),
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    status: (String(row.status) as WebhookDelivery["status"]) ?? "pending",
    attempt: Number(row.attempt ?? 0),
    responseStatus:
      row.response_status === null || row.response_status === undefined
        ? null
        : Number(row.response_status),
    responseBody:
      row.response_body === null || row.response_body === undefined
        ? null
        : String(row.response_body),
    error: row.error === null || row.error === undefined ? null : String(row.error), // prettier-ignore
    nextAttemptAt: toIso(row.next_attempt_at),
    deliveredAt: toIso(row.delivered_at),
    createdAt: toIso(row.created_at),
    ...(includeBody
      ? {
          requestBody:
            row.request_body === null || row.request_body === undefined
              ? null
              : asObject(row.request_body),
        }
      : {}),
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asHeaders(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    // Signing and identification are ours; letting a subscription overwrite
    // them would let it disable its own verification by accident.
    if (name.toLowerCase().startsWith("x-heyo-")) continue;
    if (name.toLowerCase() === signatureHeader) continue;
    if (typeof entry === "string") result[name] = entry;
  }
  return result;
}

function assertUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw CmsError.validation(`"${url}" is not a URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw CmsError.validation("A webhook URL has to be http or https.");
  }
}

function assertEvents(events: string[]): void {
  if (events.length === 0) {
    throw CmsError.validation(
      "A webhook has to subscribe to at least one event type.",
    );
  }
  for (const event of events) {
    if (!/^[a-z][a-z0-9.]*\*?$|^\*$/.test(event)) {
      throw CmsError.validation(
        `"${event}" is not an event type; use "document.updated", "document.*" or "*".`,
      );
    }
  }
}
