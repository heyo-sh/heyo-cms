-- 0000_init
-- create table activity
CREATE TABLE IF NOT EXISTS "activity" (
  "action" TEXT NOT NULL,
  "actor_id" TEXT,
  "actor_source" TEXT,
  "changes" TEXT,
  "collection" TEXT,
  "created_at" INTEGER NOT NULL,
  "document_id" TEXT,
  "id" TEXT NOT NULL,
  "ip" TEXT,
  "locale" TEXT,
  "source" TEXT,
  PRIMARY KEY ("id")
);
-- create table cms_users
CREATE TABLE IF NOT EXISTS "cms_users" (
  "avatar_url" TEXT,
  "created_at" INTEGER NOT NULL,
  "email" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "last_login_at" INTEGER,
  "locale" TEXT,
  "name" TEXT,
  "password_hash" TEXT,
  "roles" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "two_factor_enabled" INTEGER NOT NULL DEFAULT 0,
  "two_factor_secret" TEXT,
  "updated_at" INTEGER NOT NULL,
  PRIMARY KEY ("id")
);
-- create table cms_accounts
CREATE TABLE IF NOT EXISTS "cms_accounts" (
  "created_at" INTEGER NOT NULL,
  "email" TEXT,
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_account_id" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "user_id" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("user_id") REFERENCES "cms_users" ("id") ON DELETE CASCADE
);
-- create table cms_ai_credentials
CREATE TABLE IF NOT EXISTS "cms_ai_credentials" (
  "auth_type" TEXT NOT NULL DEFAULT 'api-key',
  "created_at" INTEGER NOT NULL,
  "hint" TEXT,
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  PRIMARY KEY ("id")
);
-- create table cms_ai_mutations
CREATE TABLE IF NOT EXISTS "cms_ai_mutations" (
  "collection" TEXT,
  "created_at" INTEGER NOT NULL,
  "document_id" TEXT,
  "id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "result" TEXT,
  "run_id" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
-- create table cms_ai_plans
CREATE TABLE IF NOT EXISTS "cms_ai_plans" (
  "actor_id" TEXT,
  "approved_at" INTEGER,
  "created_at" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "operations" TEXT NOT NULL,
  "result" TEXT,
  "run_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "summary" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
-- create table cms_api_keys
CREATE TABLE IF NOT EXISTS "cms_api_keys" (
  "created_at" INTEGER NOT NULL,
  "expires_at" INTEGER,
  "id" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "last_used_at" INTEGER,
  "name" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "revoked_at" INTEGER,
  "scopes" TEXT NOT NULL,
  "user_id" TEXT,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("user_id") REFERENCES "cms_users" ("id") ON DELETE CASCADE
);
-- create table cms_roles
CREATE TABLE IF NOT EXISTS "cms_roles" (
  "created_at" INTEGER NOT NULL,
  "id" TEXT NOT NULL,
  "label" TEXT,
  "name" TEXT NOT NULL,
  "permissions" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  PRIMARY KEY ("id")
);
-- create table cms_sessions
CREATE TABLE IF NOT EXISTS "cms_sessions" (
  "created_at" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "id" TEXT NOT NULL,
  "ip" TEXT,
  "token_hash" TEXT NOT NULL,
  "user_agent" TEXT,
  "user_id" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("user_id") REFERENCES "cms_users" ("id") ON DELETE CASCADE
);
-- create table cms_tokens
CREATE TABLE IF NOT EXISTS "cms_tokens" (
  "consumed_at" INTEGER,
  "created_at" INTEGER NOT NULL,
  "data" TEXT,
  "email" TEXT,
  "expires_at" INTEGER NOT NULL,
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "user_id" TEXT,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("user_id") REFERENCES "cms_users" ("id") ON DELETE CASCADE
);
-- create table documents
CREATE TABLE IF NOT EXISTS "documents" (
  "collection" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  "data" TEXT NOT NULL,
  "deleted_at" INTEGER,
  "id" TEXT NOT NULL,
  "purge_after" INTEGER,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "scheduled_at" INTEGER,
  "scheduled_patch" TEXT,
  "updated_at" INTEGER NOT NULL,
  "updated_by" TEXT,
  PRIMARY KEY ("id")
);
-- create table jobs
CREATE TABLE IF NOT EXISTS "jobs" (
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "completed_at" INTEGER,
  "created_at" INTEGER NOT NULL,
  "error" TEXT,
  "id" TEXT NOT NULL,
  "locked_at" INTEGER,
  "locked_by" TEXT,
  "payload" TEXT,
  "run_at" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "type" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
-- create table media
CREATE TABLE IF NOT EXISTS "media" (
  "alt" TEXT,
  "checksum" TEXT,
  "created_at" INTEGER NOT NULL,
  "created_by" TEXT,
  "filename" TEXT NOT NULL,
  "focal_x" REAL,
  "focal_y" REAL,
  "height" INTEGER,
  "id" TEXT NOT NULL,
  "metadata" TEXT,
  "mime_type" TEXT NOT NULL,
  "orphaned_at" INTEGER,
  "purge_after" INTEGER,
  "purge_error" TEXT,
  "size" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "storage_key" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "width" INTEGER,
  PRIMARY KEY ("id")
);
-- create table media_usages
CREATE TABLE IF NOT EXISTS "media_usages" (
  "collection" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  "document_id" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT '',
  "media_id" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("media_id") REFERENCES "media" ("id") ON DELETE CASCADE
);
-- create table outbox
CREATE TABLE IF NOT EXISTS "outbox" (
  "actor" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" INTEGER NOT NULL,
  "collection" TEXT,
  "created_at" INTEGER NOT NULL,
  "document_id" TEXT,
  "error" TEXT,
  "event_id" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "previous" TEXT,
  "processed_at" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "type" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
-- create table webhooks
CREATE TABLE IF NOT EXISTS "webhooks" (
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_at" INTEGER NOT NULL,
  "events" TEXT NOT NULL,
  "filters" TEXT,
  "headers" TEXT,
  "id" TEXT NOT NULL,
  "secret" TEXT,
  "updated_at" INTEGER NOT NULL,
  "url" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
-- create table webhook_deliveries
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "created_at" INTEGER NOT NULL,
  "delivered_at" INTEGER,
  "error" TEXT,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "next_attempt_at" INTEGER,
  "request_body" TEXT,
  "response_body" TEXT,
  "response_status" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "webhook_id" TEXT NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_documents_pages_handle" ON "documents" ((json_extract("data", '$."handle"'))) WHERE "collection" = 'pages';
-- create unique index uniq_documents_posts_handle
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_documents_posts_handle" ON "documents" ((json_extract("data", '$."handle"'))) WHERE "collection" = 'posts';
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
UPDATE "documents" SET "data" = json_set("data", '$.status', json('"draft"')) WHERE "collection" = 'posts' AND json_extract("data", '$.status') IS NULL;
-- backfill settings.siteName = "template-d1"
UPDATE "documents" SET "data" = json_set("data", '$.siteName', json('"template-d1"')) WHERE "collection" = 'settings' AND json_extract("data", '$.siteName') IS NULL;
