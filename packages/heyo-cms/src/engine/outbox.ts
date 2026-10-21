import { createId, createOrderedId } from "../ids";
import { and, eq, inList, lt, lte, orderBy } from "../query";
import type { Actor } from "../types/actor";
import type { DatabaseAdapter } from "../types/database";
import type { AnyEventType, CmsEvent, HookEventEmitter } from "../types/events";
import type { JsonObject } from "../types/json";
import type { Row, Tx } from "../types/query";
import { asObject, toIso } from "./documents";

export const outboxTable = "outbox";

export interface BufferedEvent {
  type: AnyEventType;
  data: JsonObject;
  previous: JsonObject | null;
}

/**
 * `ctx.events`: the only way a hook causes a side effect.
 *
 * Emitting queues; it never sends. A mail or a webhook fired inside the
 * transaction would go out even when the write is rolled back, and a mail
 * fired after the commit without a record would be lost when the process
 * dies between the two. The queue is drained into the outbox table by the
 * engine, inside the same transaction as the write (section 5).
 */
export class EventBuffer implements HookEventEmitter {
  private readonly queued: BufferedEvent[] = [];

  emit(
    type: AnyEventType,
    data: JsonObject,
    previous: JsonObject | null = null,
  ): void {
    this.queued.push({ type, data, previous });
  }

  /** Empties the queue; the caller is now responsible for the events. */
  take(): BufferedEvent[] {
    return this.queued.splice(0, this.queued.length);
  }
}

export interface OutboxEntryMeta {
  actor: Actor | null;
  collection?: string;
  documentId?: string;
}

export interface OutboxOptions {
  /** Section 7: five attempts, then the delivery is dead. */
  maxAttempts?: number;
  /** Exponential by default: 1s, 2s, 4s, 8s. */
  backoff?: (attempt: number) => number;
  /** Abandoned deliveries become claimable again. Subscribers must deduplicate event.id. */
  leaseMs?: number;
  now?: () => Date;
}

export type EventDispatch = (event: CmsEvent) => Promise<void>;

/**
 * The transactional outbox.
 *
 * Rows are written inside the transaction that produced them and delivered
 * afterwards. That is the whole mechanism behind two promises the plan makes:
 * a rolled back write sends nothing, and a committed one sends even if the
 * process dies one line later (sections 5 and 7). It also means an engine
 * without real transactions still has a defined behaviour — the row lands in
 * the same operation sequence as the document, and the worker is idempotent
 * because it claims a row before delivering it.
 */
export class Outbox {
  private readonly maxAttempts: number;
  private readonly backoff: (attempt: number) => number;
  private readonly leaseMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly dispatch: EventDispatch,
    options: OutboxOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoff = options.backoff ?? ((attempt) => 1000 * 2 ** (attempt - 1));
    this.leaseMs = options.leaseMs ?? 300_000;
    this.now = options.now ?? (() => new Date());
  }

  async append(
    tx: Tx,
    events: BufferedEvent[],
    meta: OutboxEntryMeta,
  ): Promise<void> {
    const now = this.now();
    for (const event of events) {
      await this.adapter.mutate(tx, {
        kind: "insert",
        table: outboxTable,
        returning: false,
        values: {
          id: createOrderedId("obx"),
          event_id: createId("evt"),
          type: event.type,
          payload: event.data,
          previous: event.previous,
          actor: meta.actor
            ? { id: meta.actor.id, source: meta.actor.source }
            : null,
          collection: meta.collection ?? null,
          document_id: meta.documentId ?? null,
          status: "pending",
          attempts: 0,
          available_at: now,
          processed_at: null,
          error: null,
          created_at: now,
        },
      });
    }
  }

  /**
   * Delivers what is due and reports how much it delivered.
   *
   * Claim, deliver, settle — three short transactions rather than one long
   * one, because a delivery is an HTTP call and holding a row lock across it
   * is how an outbox turns into an outage.
   */
  async drain(limit = 50): Promise<number> {
    const due = await this.adapter.transaction((tx) =>
      this.adapter.query(tx, {
        table: outboxTable,
        where: and(
          inList("status", ["pending", "delivering"]),
          lte("available_at", this.now()),
        ),
        orderBy: [orderBy("created_at", "asc"), orderBy("id", "asc")],
        limit,
      }),
    );

    let delivered = 0;
    for (const row of due) {
      if (await this.hasPredecessor(row)) continue;
      const claimed = await this.claim(row);
      if (!claimed) continue;
      if (Number(claimed.attempts) > this.maxAttempts) {
        await this.settle(
          claimed,
          false,
          new Error("Delivery lease expired; attempt budget exhausted."),
        );
        continue;
      }
      try {
        await this.dispatch(toEvent(claimed));
        await this.settle(claimed, true);
        delivered += 1;
      } catch (error) {
        await this.settle(claimed, false, error);
      }
    }
    return delivered;
  }

  /**
   * Takes ownership of a row, or finds out somebody else already has.
   *
   * A conditional update is the portable claim: it works on all three
   * engines, needs no row locking and makes a second worker — or a retried
   * request on serverless — harmless.
   */
  private async hasPredecessor(row: Row): Promise<boolean> {
    if (!row.document_id) return false;
    const earlier = await this.adapter.transaction((tx) =>
      this.adapter.query(tx, {
        table: outboxTable,
        where: and(
          eq(
            "collection",
            row.collection == null ? null : String(row.collection),
          ),
          eq("document_id", String(row.document_id)),
          lt("id", String(row.id)),
          inList("status", ["pending", "delivering"]),
        ),
        limit: 1,
      }),
    );
    return earlier.length > 0;
  }

  private async claim(row: Row): Promise<Row | null> {
    const set: Row = {
      status: "delivering",
      attempts: Number(row.attempts ?? 0) + 1,
      available_at: new Date(this.now().getTime() + this.leaseMs),
    };
    const result = await this.adapter.transaction((tx) =>
      this.adapter.mutate(tx, {
        kind: "update",
        table: outboxTable,
        where: and(
          eq("id", String(row.id)),
          eq("status", String(row.status)),
          eq("attempts", Number(row.attempts ?? 0)),
          lte("available_at", this.now()),
        ),
        set,
        returning: false,
      }),
    );
    return result.count === 1 ? { ...row, ...set } : null;
  }

  private async settle(
    row: Row,
    success: boolean,
    error?: unknown,
  ): Promise<void> {
    const attempts = Number(row.attempts ?? 0);
    const exhausted = attempts >= this.maxAttempts;
    const set: Row = success
      ? {
          status: "delivered",
          attempts,
          processed_at: this.now(),
          error: null,
        }
      : {
          status: exhausted ? "failed" : "pending",
          attempts,
          available_at: new Date(this.now().getTime() + this.backoff(attempts)),
          error: error instanceof Error ? error.message : String(error),
        };

    await this.adapter.transaction((tx) =>
      this.adapter.mutate(tx, {
        kind: "update",
        table: outboxTable,
        where: and(
          eq("id", String(row.id)),
          eq("status", "delivering"),
          eq("attempts", attempts),
        ),
        set,
        returning: false,
      }),
    );
  }
}

function toEvent(row: Row): CmsEvent {
  const actor = asObject(row.actor);
  return {
    id: String(row.event_id),
    type: String(row.type),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    actor:
      typeof actor.id === "string"
        ? { id: actor.id, source: actor.source === "api-key" ? "api-key" : "session" } // prettier-ignore
        : null,
    data: asObject(row.payload),
    previous: row.previous === null || row.previous === undefined ? null : asObject(row.previous), // prettier-ignore
  };
}
