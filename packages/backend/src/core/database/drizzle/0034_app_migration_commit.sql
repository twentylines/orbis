CREATE TABLE "app_migration_commit" (
  "request_id" varchar(36) PRIMARY KEY NOT NULL,
  "app_id" integer NOT NULL,
  "stage_id" varchar(36) NOT NULL,
  "operation_sha256" varchar(64) NOT NULL,
  "ledger_sha256" varchar(64) NOT NULL,
  "version" integer NOT NULL,
  "committed_at" integer NOT NULL,
  CONSTRAINT "app_migration_commit_stage_id_unique" UNIQUE("stage_id")
);
