-- 0000_init
-- create table activity
CREATE TABLE IF NOT EXISTS "activity" (
  "action" text NOT NULL,
  "actor_id" text,
  "actor_source" text,
  "changes" jsonb,
  "collection" text,
  "created_at" timestamptz NOT NULL,
  "document_id" text,
  "id" text NOT NULL,
  "ip" text,
  "locale" text,
  "source" text,
  PRIMARY KEY ("id")
);
-- create table cms_users
CREATE TABLE IF NOT EXISTS "cms_users" (
  "avatar_url" text,
  "created_at" timestamptz NOT NULL,
  "email" text NOT NULL,
  "id" text NOT NULL,
  "last_login_at" timestamptz,
  "locale" text,
  "name" text,
  "password_hash" text,
  "roles" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "two_factor_enabled" boolean NOT NULL DEFAULT false,
  "two_factor_secret" text,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);
-- create table cms_accounts
CREATE TABLE IF NOT EXISTS "cms_accounts" (
  "created_at" timestamptz NOT NULL,
  "email" text,
  "id" text NOT NULL,
  "provider" text NOT NULL,
  "provider_account_id" text NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "user_id" text NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("user_id") REFERENCES "cms_users" ("id") ON DELETE CASCADE
);
-- create table cms_ai_credentials
CREATE TABLE IF NOT EXISTS "cms_ai_credentials" (
  "auth_type" text NOT NULL DEFAULT 'api-key',
  "created_at" timestamptz NOT NULL,
  "hint" text,
  "id" text NOT NULL,
  "provider" text NOT NULL,
  "secret" text NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);
-- create table cms_ai_mutations
CREATE TABLE IF NOT EXISTS "cms_ai_mutations" (
  "collection" text,
  "created_at" timestamptz NOT NULL,
  "document_id" text,
  "id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "result" jsonb,
  "run_id" text NOT NULL,
  PRIMARY KEY ("id")
);
-- create table cms_ai_plans
CREATE TABLE IF NOT EXISTS "cms_ai_plans" (
  "actor_id" text,
  "approved_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "id" text NOT NULL,
  "kind" text NOT NULL,
  "operations" jsonb NOT NULL,
  "result" jsonb,
  "run_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "summary" text NOT NULL,
  PRIMARY KEY ("id")
);
-- create table cms_api_keys
CREATE TABLE IF NOT EXISTS "cms_api_keys" (
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz,
  "id" text NOT NULL,
  "key_hash" text NOT NULL,
  "last_used_at" timestamptz,
  "name" text NOT NULL,
  "prefix" text NOT NULL,
  "revoked_at" timestamptz,
  "scopes" jsonb NOT NULL,
  "user_id" text,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("user_id") REFERENCES "cms_users" ("id") ON DELETE CASCADE
);
-- create table cms_roles
CREATE TABLE IF NOT EXISTS "cms_roles" (
  "created_at" timestamptz NOT NULL,
  "id" text NOT NULL,
  "label" text,
  "name" text NOT NULL,
  "permissions" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);
-- create table cms_sessions
CREATE TABLE IF NOT EXISTS "cms_sessions" (
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "id" text NOT NULL,
  "ip" text,
  "token_hash" text NOT NULL,
  "user_agent" text,
  "user_id" text NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("user_id") REFERENCES "cms_users" ("id") ON DELETE CASCADE
);
-- create table cms_tokens
CREATE TABLE IF NOT EXISTS "cms_tokens" (
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "data" jsonb,
  "email" text,
  "expires_at" timestamptz NOT NULL,
  "id" text NOT NULL,
  "token_hash" text NOT NULL,
  "type" text NOT NULL,
  "user_id" text,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("user_id") REFERENCES "cms_users" ("id") ON DELETE CASCADE
);
-- create table documents
CREATE TABLE IF NOT EXISTS "documents" (
  "collection" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "data" jsonb NOT NULL,
  "deleted_at" timestamptz,
  "id" text NOT NULL,
  "purge_after" timestamptz,
  "revision" integer NOT NULL DEFAULT 1,
  "scheduled_at" timestamptz,
  "scheduled_patch" jsonb,
  "updated_at" timestamptz NOT NULL,
  "updated_by" text,
  PRIMARY KEY ("id")
);
-- create table jobs
CREATE TABLE IF NOT EXISTS "jobs" (
  "attempts" integer NOT NULL DEFAULT 0,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "error" text,
  "id" text NOT NULL,
  "locked_at" timestamptz,
  "locked_by" text,
  "payload" jsonb,
  "run_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "type" text NOT NULL,
  PRIMARY KEY ("id")
);
-- create table media
CREATE TABLE IF NOT EXISTS "media" (
  "alt" jsonb,
  "checksum" text,
  "created_at" timestamptz NOT NULL,
  "created_by" text,
  "filename" text NOT NULL,
  "focal_x" double precision,
  "focal_y" double precision,
  "height" integer,
  "id" text NOT NULL,
  "metadata" jsonb,
  "mime_type" text NOT NULL,
  "orphaned_at" timestamptz,
  "purge_after" timestamptz,
  "purge_error" text,
  "size" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "storage_key" text NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "width" integer,
  PRIMARY KEY ("id")
);
-- create table media_usages
CREATE TABLE IF NOT EXISTS "media_usages" (
  "collection" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "document_id" text NOT NULL,
  "field" text NOT NULL,
  "id" text NOT NULL,
  "locale" text NOT NULL DEFAULT '',
  "media_id" text NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("media_id") REFERENCES "media" ("id") ON DELETE CASCADE
);
-- create table outbox
CREATE TABLE IF NOT EXISTS "outbox" (
  "actor" jsonb,
  "attempts" integer NOT NULL DEFAULT 0,
  "available_at" timestamptz NOT NULL,
  "collection" text,
  "created_at" timestamptz NOT NULL,
  "document_id" text,
  "error" text,
  "event_id" text NOT NULL,
  "id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "previous" jsonb,
  "processed_at" timestamptz,
  "status" text NOT NULL DEFAULT 'pending',
  "type" text NOT NULL,
  PRIMARY KEY ("id")
);
-- create table webhooks
CREATE TABLE IF NOT EXISTS "webhooks" (
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL,
  "events" jsonb NOT NULL,
  "filters" jsonb,
  "headers" jsonb,
  "id" text NOT NULL,
  "secret" text,
  "updated_at" timestamptz NOT NULL,
  "url" text NOT NULL,
  PRIMARY KEY ("id")
);
-- create table webhook_deliveries
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "attempt" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL,
  "delivered_at" timestamptz,
  "error" text,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "id" text NOT NULL,
  "next_attempt_at" timestamptz,
  "request_body" jsonb,
  "response_body" text,
  "response_status" integer,
  "status" text NOT NULL DEFAULT 'pending',
  "webhook_id" text NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("webhook_id") REFERENCES "webhooks" ("id") ON DELETE CASCADE
);
-- create index idx_activity_actor_id
CREATE INDEX IF NOT EXISTS "idx_activity_actor_id" ON "activity" ("actor_id");
-- create index idx_activity_collection_document_id
CREATE INDEX IF NOT EXISTS "idx_activity_collection_document_id" ON "activity" ("collection", "document_id");
-- create index idx_activity_created_at
CREATE INDEX IF NOT EXISTS "idx_activity_created_at" ON "activity" ("created_at");
-- create index idx_cms_accounts_user_id
CREATE INDEX IF NOT EXISTS "idx_cms_accounts_user_id" ON "cms_accounts" ("user_id");
-- create unique index uniq_cms_accounts_provider_account
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cms_accounts_provider_account" ON "cms_accounts" ("provider", "provider_account_id");
-- create unique index uniq_cms_ai_credentials_provider
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cms_ai_credentials_provider" ON "cms_ai_credentials" ("provider");
-- create index idx_cms_ai_mutations_run_id
CREATE INDEX IF NOT EXISTS "idx_cms_ai_mutations_run_id" ON "cms_ai_mutations" ("run_id");
-- create unique index uniq_cms_ai_mutations_idempotency_key
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cms_ai_mutations_idempotency_key" ON "cms_ai_mutations" ("idempotency_key");
-- create index idx_cms_ai_plans_run_id
CREATE INDEX IF NOT EXISTS "idx_cms_ai_plans_run_id" ON "cms_ai_plans" ("run_id");
-- create index idx_cms_ai_plans_status_expires_at
CREATE INDEX IF NOT EXISTS "idx_cms_ai_plans_status_expires_at" ON "cms_ai_plans" ("status", "expires_at");
-- create index idx_cms_api_keys_user_id
CREATE INDEX IF NOT EXISTS "idx_cms_api_keys_user_id" ON "cms_api_keys" ("user_id");
-- create unique index uniq_cms_api_keys_key_hash
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cms_api_keys_key_hash" ON "cms_api_keys" ("key_hash");
-- create unique index uniq_cms_roles_name
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cms_roles_name" ON "cms_roles" ("name");
-- create index idx_cms_sessions_expires_at
CREATE INDEX IF NOT EXISTS "idx_cms_sessions_expires_at" ON "cms_sessions" ("expires_at");
-- create index idx_cms_sessions_user_id
CREATE INDEX IF NOT EXISTS "idx_cms_sessions_user_id" ON "cms_sessions" ("user_id");
-- create unique index uniq_cms_sessions_token_hash
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cms_sessions_token_hash" ON "cms_sessions" ("token_hash");
-- create index idx_cms_tokens_type_expires_at
CREATE INDEX IF NOT EXISTS "idx_cms_tokens_type_expires_at" ON "cms_tokens" ("type", "expires_at");
-- create index idx_cms_tokens_user_id
CREATE INDEX IF NOT EXISTS "idx_cms_tokens_user_id" ON "cms_tokens" ("user_id");
-- create unique index uniq_cms_tokens_token_hash
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cms_tokens_token_hash" ON "cms_tokens" ("token_hash");
-- create unique index uniq_cms_users_email
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cms_users_email" ON "cms_users" ("email");
-- create index idx_documents_collection
CREATE INDEX IF NOT EXISTS "idx_documents_collection" ON "documents" ("collection");
-- create index idx_documents_collection_deleted_at
CREATE INDEX IF NOT EXISTS "idx_documents_collection_deleted_at" ON "documents" ("collection", "deleted_at");
-- create index idx_documents_collection_updated_at
CREATE INDEX IF NOT EXISTS "idx_documents_collection_updated_at" ON "documents" ("collection", "updated_at");
-- create index idx_documents_purge_after
CREATE INDEX IF NOT EXISTS "idx_documents_purge_after" ON "documents" ("purge_after");
-- create index idx_documents_scheduled_at
CREATE INDEX IF NOT EXISTS "idx_documents_scheduled_at" ON "documents" ("scheduled_at");
-- create unique index uniq_documents_pages_handle
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_documents_pages_handle" ON "documents" ((("data" #>> '{handle}'))) WHERE "collection" = 'pages';
-- create unique index uniq_documents_posts_handle
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_documents_posts_handle" ON "documents" ((("data" #>> '{handle}'))) WHERE "collection" = 'posts';
-- create index idx_jobs_status_run_at
CREATE INDEX IF NOT EXISTS "idx_jobs_status_run_at" ON "jobs" ("status", "run_at");
-- create index idx_jobs_type
CREATE INDEX IF NOT EXISTS "idx_jobs_type" ON "jobs" ("type");
-- create index idx_media_status
CREATE INDEX IF NOT EXISTS "idx_media_status" ON "media" ("status");
-- create index idx_media_status_purge_after
CREATE INDEX IF NOT EXISTS "idx_media_status_purge_after" ON "media" ("status", "purge_after");
-- create unique index uniq_media_storage_key
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_media_storage_key" ON "media" ("storage_key");
-- create index idx_media_usages_document_id
CREATE INDEX IF NOT EXISTS "idx_media_usages_document_id" ON "media_usages" ("document_id");
-- create index idx_media_usages_media_id
CREATE INDEX IF NOT EXISTS "idx_media_usages_media_id" ON "media_usages" ("media_id");
-- create unique index uniq_media_usages_reference
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_media_usages_reference" ON "media_usages" ("media_id", "document_id", "field", "locale");
-- create index idx_outbox_document_id_created_at
CREATE INDEX IF NOT EXISTS "idx_outbox_document_id_created_at" ON "outbox" ("document_id", "created_at");
-- create index idx_outbox_status_available_at
CREATE INDEX IF NOT EXISTS "idx_outbox_status_available_at" ON "outbox" ("status", "available_at");
-- create unique index uniq_outbox_event_id
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_outbox_event_id" ON "outbox" ("event_id");
-- create index idx_webhook_deliveries_event_id
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_event_id" ON "webhook_deliveries" ("event_id");
-- create index idx_webhook_deliveries_status_next_attempt_at
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_status_next_attempt_at" ON "webhook_deliveries" ("status", "next_attempt_at");
-- create index idx_webhook_deliveries_webhook_id_created_at
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_webhook_id_created_at" ON "webhook_deliveries" ("webhook_id", "created_at");
-- create index idx_webhooks_active
CREATE INDEX IF NOT EXISTS "idx_webhooks_active" ON "webhooks" ("active");
-- backfill posts.status = "draft"
UPDATE "documents" SET "data" = jsonb_set("data", '{status}', '"draft"'::jsonb, true) WHERE "collection" = 'posts' AND "data" #> '{status}' IS NULL;
-- backfill settings.siteName = "template-postgres"
UPDATE "documents" SET "data" = jsonb_set("data", '{siteName}', '"template-postgres"'::jsonb, true) WHERE "collection" = 'settings' AND "data" #> '{siteName}' IS NULL;
