import type {
  ColumnSnapshot,
  ColumnType,
  ForeignKeyDefinition,
  IndexSnapshot,
  IndexTarget,
  TableSnapshot,
} from "../types/schema";
import type { JsonPrimitive } from "../types/json";

/**
 * The journal.
 *
 * Owned by the adapter rather than by the schema: it has to exist before the
 * first migration runs, so it can never be the product of one. `introspect()`
 * ignores it for the same reason.
 */
export const migrationsTable = "cms_migrations";

interface ColumnOptions {
  nullable?: boolean;
  default?: JsonPrimitive;
  unique?: boolean;
  index?: boolean;
  array?: boolean;
  references?: ForeignKeyDefinition;
}

function column(
  name: string,
  type: ColumnType,
  options: ColumnOptions = {},
): ColumnSnapshot {
  return {
    name,
    type,
    nullable:
      options.default !== undefined ? false : (options.nullable ?? true),
    storage: "column",
    ...(options.default === undefined ? {} : { default: options.default }),
    ...(options.unique === undefined ? {} : { unique: options.unique }),
    ...(options.index === undefined ? {} : { index: options.index }),
    ...(options.array === undefined ? {} : { array: options.array }),
    ...(options.references === undefined
      ? {}
      : { references: options.references }),
  };
}

const id = (): ColumnSnapshot =>
  column("id", "text", { nullable: false, unique: true });

const createdAt = (): ColumnSnapshot =>
  column("created_at", "timestamp", { nullable: false });

const updatedAt = (): ColumnSnapshot =>
  column("updated_at", "timestamp", { nullable: false });

function index(
  table: string,
  columns: string[],
  options: { unique?: boolean; name?: string } = {},
): IndexSnapshot {
  const targets: IndexTarget[] = columns.map((name) => ({
    kind: "column",
    column: name,
  }));
  const prefix = options.unique === true ? "uniq" : "idx";
  return {
    name: options.name ?? `${prefix}_${table}_${columns.join("_")}`,
    table,
    targets,
    unique: options.unique === true,
  };
}

function table(
  name: string,
  columns: ColumnSnapshot[],
  indexes: IndexSnapshot[] = [],
  documentColumn?: string,
): TableSnapshot {
  return {
    name,
    columns: [...columns].sort((a, b) => a.name.localeCompare(b.name)),
    primaryKey: ["id"],
    indexes: [...indexes].sort((a, b) => a.name.localeCompare(b.name)),
    ...(documentColumn === undefined ? {} : { documentColumn }),
  };
}

/**
 * Every table the engine owns.
 *
 * One `documents` table holds all content: a table per collection would turn
 * "add a field" into DDL and "add a locale" into a migration, which is exactly
 * what the document model avoids (section 12). Everything else here is
 * machinery — auth, media, delivery, scheduling — and is queried by the engine
 * itself, so it gets real columns.
 */
export function systemTables(): TableSnapshot[] {
  return [
    documentsTable(),
    cmsUsersTable(),
    cmsSessionsTable(),
    cmsAccountsTable(),
    cmsTokensTable(),
    cmsApiKeysTable(),
    cmsRolesTable(),
    cmsAiCredentialsTable(),
    cmsAiMutationsTable(),
    cmsAiPlansTable(),
    mediaTable(),
    mediaUsagesTable(),
    webhooksTable(),
    webhookDeliveriesTable(),
    outboxTable(),
    activityTable(),
    jobsTable(),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** Names the engine reserves; a collection cannot take one of them. */
export function systemTableNames(): string[] {
  return [migrationsTable, ...systemTables().map((entry) => entry.name)].sort();
}

function documentsTable(): TableSnapshot {
  return table(
    "documents",
    [
      id(),
      column("collection", "text", { nullable: false }),
      column("data", "json", { nullable: false }),
      // The optimistic-concurrency token. Every write that changes the row
      // increments it, and a caller that read the document first may pass it
      // back as a precondition: without it "read, think, write" silently
      // overwrites whoever else wrote in between — which the AI assistant
      // would do routinely, because minutes pass between its read and its
      // save.
      column("revision", "integer", { nullable: false, default: 1 }),
      // A scheduled change is a patch plus a time, not a second copy of the
      // document: it works for a status flip and for any other field, and it
      // is applied as an ordinary update so hooks and events still run.
      column("scheduled_at", "timestamp"),
      column("scheduled_patch", "json"),
      column("deleted_at", "timestamp"),
      column("purge_after", "timestamp"),
      createdAt(),
      updatedAt(),
      column("updated_by", "text"),
    ],
    [
      index("documents", ["collection"]),
      index("documents", ["collection", "deleted_at"]),
      index("documents", ["collection", "updated_at"]),
      index("documents", ["scheduled_at"]),
      index("documents", ["purge_after"]),
    ],
    "data",
  );
}

function cmsUsersTable(): TableSnapshot {
  return table(
    "cms_users",
    [
      id(),
      column("email", "text", { nullable: false, unique: true }),
      column("name", "text"),
      column("password_hash", "text"),
      column("two_factor_secret", "text"),
      // A secret exists from the moment setup starts; this is what says the
      // user finished it. Without the distinction a half-configured
      // authenticator would lock its owner out of their own account.
      column("two_factor_enabled", "boolean", { default: false }),
      column("status", "text", { nullable: false, default: "active" }),
      column("roles", "json", { nullable: false, array: true }),
      column("avatar_url", "text"),
      column("locale", "text"),
      column("last_login_at", "timestamp"),
      createdAt(),
      updatedAt(),
    ],
    [index("cms_users", ["email"], { unique: true })],
  );
}

function cmsSessionsTable(): TableSnapshot {
  return table(
    "cms_sessions",
    [
      id(),
      column("user_id", "text", {
        nullable: false,
        references: { table: "cms_users", column: "id", onDelete: "cascade" },
      }),
      // Only the hash is stored: a leaked database must not hand out live
      // sessions.
      column("token_hash", "text", { nullable: false, unique: true }),
      column("ip", "text"),
      column("user_agent", "text"),
      column("expires_at", "timestamp", { nullable: false }),
      createdAt(),
    ],
    [
      index("cms_sessions", ["token_hash"], { unique: true }),
      index("cms_sessions", ["user_id"]),
      index("cms_sessions", ["expires_at"]),
    ],
  );
}

/**
 * External identities, one row per provider account.
 *
 * Separate from `cms_users` because a single editor legitimately signs in
 * through GitHub at home and through the company's OIDC at work, and because
 * a provider id is the only stable join key — an email address changes.
 */
function cmsAccountsTable(): TableSnapshot {
  return table(
    "cms_accounts",
    [
      id(),
      column("user_id", "text", {
        nullable: false,
        references: { table: "cms_users", column: "id", onDelete: "cascade" },
      }),
      column("provider", "text", { nullable: false }),
      column("provider_account_id", "text", { nullable: false }),
      column("email", "text"),
      createdAt(),
      updatedAt(),
    ],
    [
      index("cms_accounts", ["provider", "provider_account_id"], {
        unique: true,
        name: "uniq_cms_accounts_provider_account",
      }),
      index("cms_accounts", ["user_id"]),
    ],
  );
}

/**
 * Every single-use secret: invitations, magic links, password resets, the
 * two-factor challenge between a password and a session, and the OAuth state.
 *
 * One table rather than five because they differ only in `type` and in how
 * long they live, and because "is this token still valid" has to be one query
 * with one set of rules. Only the hash is stored, for the same reason sessions
 * store only a hash.
 */
function cmsTokensTable(): TableSnapshot {
  return table(
    "cms_tokens",
    [
      id(),
      column("type", "text", { nullable: false }),
      column("user_id", "text", {
        references: { table: "cms_users", column: "id", onDelete: "cascade" },
      }),
      column("email", "text"),
      column("token_hash", "text", { nullable: false, unique: true }),
      /** PKCE verifier, the provider being used, where to go afterwards. */
      column("data", "json"),
      column("expires_at", "timestamp", { nullable: false }),
      // Consumption is a column rather than a delete: a token that was used
      // once and is presented again should read as spent, not as unknown.
      column("consumed_at", "timestamp"),
      createdAt(),
    ],
    [
      index("cms_tokens", ["token_hash"], { unique: true }),
      index("cms_tokens", ["user_id"]),
      index("cms_tokens", ["type", "expires_at"]),
    ],
  );
}

function cmsApiKeysTable(): TableSnapshot {
  return table(
    "cms_api_keys",
    [
      id(),
      column("name", "text", { nullable: false }),
      column("user_id", "text", {
        references: { table: "cms_users", column: "id", onDelete: "cascade" },
      }),
      column("key_hash", "text", { nullable: false, unique: true }),
      /** Shown in the panel so a key can be recognised without revealing it. */
      column("prefix", "text", { nullable: false }),
      column("scopes", "json", { nullable: false, array: true }),
      column("last_used_at", "timestamp"),
      column("expires_at", "timestamp"),
      column("revoked_at", "timestamp"),
      createdAt(),
    ],
    [
      index("cms_api_keys", ["key_hash"], { unique: true }),
      index("cms_api_keys", ["user_id"]),
    ],
  );
}

function cmsRolesTable(): TableSnapshot {
  return table(
    "cms_roles",
    [
      id(),
      column("name", "text", { nullable: false, unique: true }),
      column("label", "text"),
      column("permissions", "json", { nullable: false, array: true }),
      createdAt(),
      updatedAt(),
    ],
    [index("cms_roles", ["name"], { unique: true })],
  );
}

/**
 * Provider keys configured in the panel rather than in the environment.
 *
 * The token is encrypted with `ai.storage.secret` before it gets here, so a
 * copy of this table is not a copy of the keys (section 8). `hint` is the
 * last four characters, which is what a settings screen needs to show that a
 * key is the one somebody meant.
 */
function cmsAiCredentialsTable(): TableSnapshot {
  return table(
    "cms_ai_credentials",
    [
      id(),
      column("provider", "text", { nullable: false, unique: true }),
      column("auth_type", "text", { nullable: false, default: "api-key" }),
      column("secret", "text", { nullable: false }),
      column("hint", "text"),
      createdAt(),
      updatedAt(),
    ],
    [index("cms_ai_credentials", ["provider"], { unique: true })],
  );
}

/**
 * What the assistant has already written, keyed by run and tool call.
 *
 * A dropped SSE connection is not an unusual event; a client that retries a
 * mutation after one is the normal client. The key is written inside the same
 * transaction as the document it describes, so a replay answers with the
 * first result rather than running the hooks and the outbox a second time —
 * which is the difference between "idempotent" and "usually idempotent".
 */
function cmsAiMutationsTable(): TableSnapshot {
  return table(
    "cms_ai_mutations",
    [
      id(),
      column("idempotency_key", "text", { nullable: false, unique: true }),
      column("run_id", "text", { nullable: false }),
      column("collection", "text"),
      column("document_id", "text"),
      column("result", "json"),
      createdAt(),
    ],
    [
      index("cms_ai_mutations", ["idempotency_key"], { unique: true }),
      index("cms_ai_mutations", ["run_id"]),
    ],
  );
}

/**
 * A mutation the assistant proposed and a human has not approved yet.
 *
 * Stored rather than kept in the model's context on purpose: approving a plan
 * must execute exactly what was shown on screen, so the plan is normalised,
 * written down, and replayed from the row — never handed back to the model to
 * reconstruct (section "Zapis, konflikty i zatwierdzanie").
 */
function cmsAiPlansTable(): TableSnapshot {
  return table(
    "cms_ai_plans",
    [
      id(),
      column("run_id", "text", { nullable: false }),
      column("actor_id", "text"),
      column("kind", "text", { nullable: false }),
      column("summary", "text", { nullable: false }),
      column("operations", "json", { nullable: false }),
      column("status", "text", { nullable: false, default: "pending" }),
      column("result", "json"),
      column("expires_at", "timestamp", { nullable: false }),
      column("approved_at", "timestamp"),
      createdAt(),
    ],
    [
      index("cms_ai_plans", ["run_id"]),
      index("cms_ai_plans", ["status", "expires_at"]),
    ],
  );
}

function mediaTable(): TableSnapshot {
  return table(
    "media",
    [
      id(),
      column("filename", "text", { nullable: false }),
      column("mime_type", "text", { nullable: false }),
      column("size", "bigint", { nullable: false }),
      column("width", "integer"),
      column("height", "integer"),
      column("storage_key", "text", { nullable: false, unique: true }),
      column("checksum", "text"),
      /** Localized alternative text, keyed by locale like any content field. */
      column("alt", "json"),
      column("focal_x", "real"),
      column("focal_y", "real"),
      // active -> orphaned -> purging. A file that lost its last reference
      // keeps serving until `purge_after`, so an accidental delete is
      // recoverable (section 6).
      column("status", "text", { nullable: false, default: "active" }),
      column("orphaned_at", "timestamp"),
      column("purge_after", "timestamp"),
      column("purge_error", "text"),
      column("metadata", "json"),
      column("created_by", "text"),
      createdAt(),
      updatedAt(),
    ],
    [
      index("media", ["storage_key"], { unique: true }),
      index("media", ["status"]),
      index("media", ["status", "purge_after"]),
    ],
  );
}

function mediaUsagesTable(): TableSnapshot {
  return table(
    "media_usages",
    [
      id(),
      column("media_id", "text", {
        nullable: false,
        references: { table: "media", column: "id", onDelete: "cascade" },
      }),
      column("collection", "text", { nullable: false }),
      column("document_id", "text", { nullable: false }),
      column("field", "text", { nullable: false }),
      // Empty rather than null: the uniqueness of a usage must not depend on
      // how an engine treats nulls in a unique index.
      column("locale", "text", { nullable: false, default: "" }),
      createdAt(),
    ],
    [
      index("media_usages", ["media_id"]),
      index("media_usages", ["document_id"]),
      index("media_usages", ["media_id", "document_id", "field", "locale"], {
        unique: true,
        name: "uniq_media_usages_reference",
      }),
    ],
  );
}

function webhooksTable(): TableSnapshot {
  return table(
    "webhooks",
    [
      id(),
      column("url", "text", { nullable: false }),
      column("events", "json", { nullable: false, array: true }),
      column("filters", "json"),
      column("headers", "json"),
      column("secret", "text"),
      column("active", "boolean", { nullable: false, default: true }),
      createdAt(),
      updatedAt(),
    ],
    [index("webhooks", ["active"])],
  );
}

function webhookDeliveriesTable(): TableSnapshot {
  return table(
    "webhook_deliveries",
    [
      id(),
      column("webhook_id", "text", {
        nullable: false,
        references: { table: "webhooks", column: "id", onDelete: "cascade" },
      }),
      column("event_id", "text", { nullable: false }),
      column("event_type", "text", { nullable: false }),
      column("status", "text", { nullable: false, default: "pending" }),
      column("attempt", "integer", { nullable: false, default: 0 }),
      column("request_body", "json"),
      column("response_status", "integer"),
      column("response_body", "text"),
      column("error", "text"),
      column("next_attempt_at", "timestamp"),
      column("delivered_at", "timestamp"),
      createdAt(),
    ],
    [
      index("webhook_deliveries", ["webhook_id", "created_at"]),
      index("webhook_deliveries", ["status", "next_attempt_at"]),
      index("webhook_deliveries", ["event_id"]),
    ],
  );
}

function outboxTable(): TableSnapshot {
  return table(
    "outbox",
    [
      id(),
      // Written inside the transaction that produced the change, delivered
      // afterwards: a rolled back write sends nothing, a committed one sends
      // exactly once per consumer, with retries (section 5).
      column("event_id", "text", { nullable: false, unique: true }),
      column("type", "text", { nullable: false }),
      column("payload", "json", { nullable: false }),
      column("previous", "json"),
      column("actor", "json"),
      column("collection", "text"),
      column("document_id", "text"),
      column("status", "text", { nullable: false, default: "pending" }),
      column("attempts", "integer", { nullable: false, default: 0 }),
      column("available_at", "timestamp", { nullable: false }),
      column("processed_at", "timestamp"),
      column("error", "text"),
      createdAt(),
    ],
    [
      index("outbox", ["event_id"], { unique: true }),
      index("outbox", ["status", "available_at"]),
      // Delivery order is guaranteed per document, not globally (section 7).
      index("outbox", ["document_id", "created_at"]),
    ],
  );
}

function activityTable(): TableSnapshot {
  return table(
    "activity",
    [
      id(),
      column("actor_id", "text"),
      column("actor_source", "text"),
      column("action", "text", { nullable: false }),
      // Where the write came from: `admin`, `rest`, `job`, `ai`. An audit
      // trail that cannot distinguish a form save from an agent save cannot
      // answer the first question anybody asks about an agent save.
      column("source", "text"),
      column("collection", "text"),
      column("document_id", "text"),
      column("locale", "text"),
      column("changes", "json"),
      column("ip", "text"),
      createdAt(),
    ],
    [
      index("activity", ["collection", "document_id"]),
      index("activity", ["actor_id"]),
      index("activity", ["created_at"]),
    ],
  );
}

function jobsTable(): TableSnapshot {
  return table(
    "jobs",
    [
      id(),
      column("type", "text", { nullable: false }),
      column("payload", "json"),
      column("status", "text", { nullable: false, default: "pending" }),
      column("run_at", "timestamp", { nullable: false }),
      column("attempts", "integer", { nullable: false, default: 0 }),
      column("locked_at", "timestamp"),
      column("locked_by", "text"),
      column("completed_at", "timestamp"),
      column("error", "text"),
      createdAt(),
    ],
    [index("jobs", ["status", "run_at"]), index("jobs", ["type"])],
  );
}
