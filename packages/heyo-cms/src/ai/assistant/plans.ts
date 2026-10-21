import { scopedDb } from "../../engine/scoped-db";
import { CmsError } from "../../errors";
import { createId } from "../../ids";
import { and, eq } from "../../query";
import type { Actor } from "../../types/actor";
import type { AiMutationTarget, AiPlanSummary } from "../../types/ai";
import type { DatabaseAdapter } from "../../types/database";
import type { JsonObject, JsonValue } from "../../types/json";

const aiPlansTable = "cms_ai_plans";

/** Ten minutes. Long enough to read, short enough that the world has not moved. */
const planTtlMs = 10 * 60 * 1_000;

/** The ceiling on one plan. A bigger intention is several approvals. */
export const maxPlanOperations = 25;

/**
 * One operation inside a plan, exactly as it will be executed.
 *
 * Normalised at the moment the plan is written: collection *names* rather than
 * whatever the model typed, the shaped field values rather than Markdown, the
 * revision the agent actually read. Approving a plan then means replaying this
 * row — no second pass through the model, no re-interpretation, no chance that
 * the thing executed differs from the thing displayed.
 */
export interface PlanOperation {
  action:
    | "create"
    | "update"
    | "trash"
    | "restore"
    | "purge"
    | "update-global"
    | "update-media";
  collection?: string;
  id?: string;
  locale?: string | null;
  expectedRevision?: number;
  data?: JsonObject;
  /** What the panel shows for this line. Server-written, never the model's. */
  label: string;
  fields: string[];
}

export interface StoredPlan {
  id: string;
  runId: string;
  actorId: string | null;
  kind: string;
  summary: string;
  operations: PlanOperation[];
  status: "pending" | "approved" | "expired";
  expiresAt: Date;
}

export interface PlanStoreOptions {
  database: () => Promise<DatabaseAdapter>;
}

/**
 * Where a plan waits for a human.
 *
 * In the database rather than in memory, for two reasons that both come up in
 * ordinary use: the approval arrives on a *different* HTTP request from the
 * one that proposed it, and a deployment with more than one instance will
 * routinely route those two requests to different processes.
 */
export class PlanStore {
  constructor(private readonly options: PlanStoreOptions) {}

  async create(args: {
    runId: string;
    actor: Actor | null;
    kind: string;
    summary: string;
    operations: PlanOperation[];
    now?: Date;
  }): Promise<StoredPlan> {
    if (args.operations.length === 0) {
      throw CmsError.validation("A plan has to contain at least one change.");
    }
    if (args.operations.length > maxPlanOperations) {
      throw CmsError.validation(
        `A plan may change at most ${maxPlanOperations} records; this one has ${args.operations.length}. Split it and ask for approval separately.`,
      );
    }

    const now = args.now ?? new Date();
    const plan: StoredPlan = {
      id: createId("aip"),
      runId: args.runId,
      actorId: args.actor?.id ?? null,
      kind: args.kind,
      summary: args.summary,
      operations: args.operations,
      status: "pending",
      expiresAt: new Date(now.getTime() + planTtlMs),
    };

    const adapter = await this.options.database();
    await adapter.transaction(async (tx) => {
      await scopedDb(adapter, tx).insert(aiPlansTable, {
        id: plan.id,
        run_id: plan.runId,
        actor_id: plan.actorId,
        kind: plan.kind,
        summary: plan.summary,
        operations: plan.operations as unknown as JsonValue,
        status: "pending",
        result: null,
        expires_at: plan.expiresAt,
        approved_at: null,
        created_at: now,
      });
    });
    return plan;
  }

  /**
   * The plan this actor is allowed to approve, if it is still approvable.
   *
   * The actor check is not decoration. A plan is a stored intention to write,
   * and an id that anybody signed in could POST would turn one editor's
   * unapproved proposal into another editor's authority.
   */
  async claim(args: {
    planId: string;
    actor: Actor | null;
    now?: Date;
  }): Promise<StoredPlan> {
    const now = args.now ?? new Date();
    const adapter = await this.options.database();

    return adapter.transaction(async (tx) => {
      const db = scopedDb(adapter, tx);
      const row = await db.findOne(aiPlansTable, eq("id", args.planId));
      if (!row) throw CmsError.notFound("That plan no longer exists.");

      const plan = toPlan(row as JsonObject);
      if (plan.actorId !== (args.actor?.id ?? null)) {
        // Reads as missing rather than forbidden: "that plan exists but is
        // not yours" is information about somebody else's session.
        throw CmsError.notFound("That plan no longer exists.");
      }
      if (plan.status === "approved") {
        throw CmsError.conflict("That plan has already been applied.");
      }
      if (plan.expiresAt.getTime() <= now.getTime()) {
        throw new CmsError(
          "That plan expired. Ask again and approve the new one — the records may have changed since.",
          { status: 410, code: "ai_plan_expired" },
        );
      }

      // Conditional, so two clicks on Approve cannot both win.
      const claimed = await adapter.mutate(tx, {
        kind: "update",
        table: aiPlansTable,
        where: and(eq("id", plan.id), eq("status", "pending")),
        set: { status: "approved", approved_at: now },
      });
      if (claimed.count === 0) {
        throw CmsError.conflict("That plan has already been applied.");
      }
      return plan;
    });
  }

  /** Records what executing the plan produced, for an interrupted approval. */
  async complete(planId: string, result: JsonObject): Promise<void> {
    const adapter = await this.options.database();
    await adapter.transaction(async (tx) => {
      await scopedDb(adapter, tx).update(aiPlansTable, eq("id", planId), {
        result: result as unknown as JsonValue,
      });
    });
  }
}

/**
 * The plan as the panel may see it.
 *
 * Field *names*, never field values. An approval dialog has to say "this will
 * change `title` and `body` on three posts", and a dialog that printed the
 * proposed body would be a dialog nobody reads — which is the failure mode an
 * approval step exists to prevent.
 */
export function planSummary(plan: StoredPlan): AiPlanSummary {
  return {
    id: plan.id,
    runId: plan.runId,
    summary: plan.summary,
    operations: plan.operations.map((operation) => ({
      action: operation.action,
      target: targetOf(operation),
      label: operation.label,
      fields: operation.fields,
    })),
    expiresAt: plan.expiresAt.toISOString(),
  };
}

function targetOf(operation: PlanOperation): AiMutationTarget {
  return {
    kind:
      operation.action === "update-global"
        ? "global"
        : operation.action === "update-media"
          ? "media"
          : "document",
    ...(operation.collection === undefined
      ? {}
      : { collection: operation.collection }),
    id: operation.id ?? "",
    ...(operation.locale === undefined ? {} : { locale: operation.locale }),
  };
}

function toPlan(row: JsonObject): StoredPlan {
  const operations = Array.isArray(row.operations)
    ? (row.operations as unknown as PlanOperation[])
    : [];
  const expires = row.expires_at;
  return {
    id: String(row.id),
    runId: String(row.run_id ?? ""),
    actorId: row.actor_id === null || row.actor_id === undefined ? null : String(row.actor_id), // prettier-ignore
    kind: String(row.kind ?? "mutation"),
    summary: String(row.summary ?? ""),
    operations,
    status: (row.status as StoredPlan["status"]) ?? "pending",
    expiresAt:
      expires instanceof Date ? expires : new Date(String(expires ?? 0)),
  };
}
