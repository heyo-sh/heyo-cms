import type { ActorSource } from "./actor";
import type { JsonObject } from "./json";

/**
 * The event catalogue from section 7.
 *
 * Webhook subscriptions, the activity log and the paid versions package all
 * read from this one list, so an event added here is immediately subscribable
 * without touching the webhook layer.
 */
export type DocumentEventType =
  | "document.created"
  | "document.updated"
  | "document.field.changed"
  | "document.scheduled"
  | "document.schedule.applied"
  /**
   * The one addition to the catalogue in section 7.
   *
   * A cancellation reported as `document.scheduled` with an empty payload
   * would make every subscriber to "something was scheduled" tell its users
   * about a schedule that no longer exists.
   */
  | "document.schedule.cancelled"
  | "document.trashed"
  | "document.restored"
  | "document.purged";

export type MediaEventType =
  | "media.uploaded"
  | "media.updated"
  | "media.orphaned"
  | "media.reclaimed"
  | "media.purged"
  | "media.processing.failed";

export type LocaleEventType = "translation.completed";

/**
 * What the AI runtime reports.
 *
 * `ai.task.*` is one field action. `ai.agent.*` is one run of the panel-wide
 * assistant, and `ai.agent.mutation.applied` is one write inside such a run —
 * emitted *in addition to* the ordinary `document.updated`, not instead of
 * it, so a subscriber that cares about content hears it the usual way and a
 * subscriber auditing the agent can correlate by `runId`.
 *
 * None of them carry the prompt, the reply or the record. They carry the run
 * id, the model, the usage, the duration, the tool names and the fields that
 * changed — which is what an audit needs and all an audit may have.
 */
export type AiEventType =
  | "ai.task.completed"
  | "ai.task.failed"
  | "ai.agent.completed"
  | "ai.agent.failed"
  | "ai.agent.mutation.applied";

export type AccessEventType =
  | "user.invited"
  | "user.joined"
  | "user.removed"
  | "role.changed"
  | "apikey.created"
  | "apikey.revoked";

export type SystemEventType = "migration.applied" | "job.failed";

export type CmsEventType =
  | DocumentEventType
  | MediaEventType
  | LocaleEventType
  | AiEventType
  | AccessEventType
  | SystemEventType;

/**
 * Anything a plugin emits. The template literal keeps editor completion for
 * the catalogue while leaving room for `analytics.rollup.finished`.
 */
export type AnyEventType = CmsEventType | (string & {});

/**
 * An event as it is stored in the outbox and delivered to webhooks.
 *
 * `previous` is part of the contract rather than an optimisation: the paid
 * versions package is specified to reconstruct history from events alone
 * (section 4), which is only possible if every change carries both sides.
 */
export interface CmsEvent<TData extends JsonObject = JsonObject> {
  id: string;
  type: AnyEventType;
  createdAt: string;
  actor: { id: string; source: ActorSource } | null;
  data: TData;
  previous: JsonObject | null;
}

export type CmsEventListener<TData extends JsonObject = JsonObject> = (
  event: CmsEvent<TData>,
) => void | Promise<void>;

/**
 * The emitter handed to hooks.
 *
 * It queues into the outbox inside the running transaction and never performs
 * the side effect itself: a rolled back transaction must not send a webhook,
 * and a committed one must send it even if the process dies (section 5).
 */
export interface HookEventEmitter {
  emit(
    type: AnyEventType,
    data: JsonObject,
    previous?: JsonObject | null,
  ): void;
}
