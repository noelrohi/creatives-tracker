CREATE TYPE "public"."launchpad_error_category" AS ENUM('retryable', 'terminal', 'ambiguous', 'manual_intervention');--> statement-breakpoint
CREATE TYPE "public"."launchpad_item_status" AS ENUM('validation', 'validated', 'queued', 'publishing', 'success', 'partial_success', 'failed', 'ambiguous', 'skipped', 'cancelled', 'manual_intervention');--> statement-breakpoint
CREATE TYPE "public"."launchpad_principal_type" AS ENUM('session', 'apiKey', 'worker', 'anonymous');--> statement-breakpoint
CREATE TYPE "public"."launchpad_reconciliation_status" AS ENUM('not_required', 'pending', 'checking', 'reconciled', 'mismatched', 'manual_intervention');--> statement-breakpoint
CREATE TYPE "public"."launchpad_run_status" AS ENUM('validation', 'validated', 'queued', 'publishing', 'success', 'partial_success', 'failed', 'ambiguous', 'skipped', 'cancelled', 'manual_intervention');--> statement-breakpoint
CREATE TABLE "launchpad_publish_item" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"position" integer NOT NULL,
	"status" "launchpad_item_status" DEFAULT 'validation' NOT NULL,
	"requested_status" text DEFAULT 'PAUSED' NOT NULL,
	"creative_id" text,
	"local_ad_id" text,
	"account_id" text,
	"ad_set_id" text,
	"actor_page_id" text,
	"actor_instagram_id" text,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_locked_at" timestamp DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"requested_ad_name" text,
	"external_meta_image_hash" text,
	"external_meta_creative_id" text,
	"external_meta_ad_id" text,
	"raw_meta_configured_status" text,
	"raw_meta_effective_status" text,
	"created_by_user_id" text,
	"created_by_principal_type" "launchpad_principal_type" NOT NULL,
	"created_by_role" text,
	"error_category" "launchpad_error_category",
	"error_code" text,
	"error_message" text,
	"error_details" jsonb,
	"reconciliation_status" "launchpad_reconciliation_status" DEFAULT 'not_required' NOT NULL,
	"reconciliation_checked_at" timestamp,
	"manual_intervention_reason" text,
	"validated_at" timestamp,
	"queued_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"skipped_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launchpad_publish_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"status" "launchpad_run_status" DEFAULT 'validation' NOT NULL,
	"mode" text DEFAULT 'validation' NOT NULL,
	"requested_status" text DEFAULT 'PAUSED' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"max_item_cap" integer DEFAULT 25 NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"manifest_locked_at" timestamp DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"requested_by_user_id" text,
	"requested_by_principal_type" "launchpad_principal_type" NOT NULL,
	"requested_by_role" text,
	"actor_account_id" text,
	"actor_account_meta_id" text,
	"actor_page_id" text,
	"actor_instagram_id" text,
	"destination_ad_set_id" text,
	"destination_ad_set_meta_id" text,
	"live_publish_enabled_at_validation" boolean DEFAULT false NOT NULL,
	"external_trigger_run_id" text,
	"error_category" "launchpad_error_category",
	"error_code" text,
	"error_message" text,
	"error_details" jsonb,
	"reconciliation_status" "launchpad_reconciliation_status" DEFAULT 'not_required' NOT NULL,
	"reconciliation_checked_at" timestamp,
	"manual_intervention_reason" text,
	"validated_at" timestamp,
	"queued_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "launchpad_publish_item" ADD CONSTRAINT "launchpad_publish_item_run_id_launchpad_publish_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."launchpad_publish_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launchpad_publish_item" ADD CONSTRAINT "launchpad_publish_item_creative_id_ad_creative_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launchpad_publish_item" ADD CONSTRAINT "launchpad_publish_item_local_ad_id_ad_id_fk" FOREIGN KEY ("local_ad_id") REFERENCES "public"."ad"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launchpad_publish_item" ADD CONSTRAINT "launchpad_publish_item_account_id_ad_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launchpad_publish_item" ADD CONSTRAINT "launchpad_publish_item_ad_set_id_ad_set_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_set"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launchpad_publish_run" ADD CONSTRAINT "launchpad_publish_run_actor_account_id_ad_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."ad_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launchpad_publish_run" ADD CONSTRAINT "launchpad_publish_run_destination_ad_set_id_ad_set_id_fk" FOREIGN KEY ("destination_ad_set_id") REFERENCES "public"."ad_set"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "launchpad_item_run_idx" ON "launchpad_publish_item" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "launchpad_item_org_idx" ON "launchpad_publish_item" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "launchpad_item_status_idx" ON "launchpad_publish_item" USING btree ("status");--> statement-breakpoint
CREATE INDEX "launchpad_item_creative_idx" ON "launchpad_publish_item" USING btree ("creative_id");--> statement-breakpoint
CREATE INDEX "launchpad_item_local_ad_idx" ON "launchpad_publish_item" USING btree ("local_ad_id");--> statement-breakpoint
CREATE INDEX "launchpad_item_external_meta_ad_idx" ON "launchpad_publish_item" USING btree ("external_meta_ad_id");--> statement-breakpoint
CREATE INDEX "launchpad_item_reconciliation_idx" ON "launchpad_publish_item" USING btree ("reconciliation_status");--> statement-breakpoint
CREATE UNIQUE INDEX "launchpad_item_run_position_uidx" ON "launchpad_publish_item" USING btree ("run_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "launchpad_item_run_idempotency_uidx" ON "launchpad_publish_item" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "launchpad_item_run_dedupe_uidx" ON "launchpad_publish_item" USING btree ("run_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "launchpad_run_org_idx" ON "launchpad_publish_run" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "launchpad_run_status_idx" ON "launchpad_publish_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "launchpad_run_created_at_idx" ON "launchpad_publish_run" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "launchpad_run_actor_account_idx" ON "launchpad_publish_run" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "launchpad_run_destination_ad_set_idx" ON "launchpad_publish_run" USING btree ("destination_ad_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "launchpad_run_org_idempotency_uidx" ON "launchpad_publish_run" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "launchpad_run_org_dedupe_uidx" ON "launchpad_publish_run" USING btree ("organization_id","dedupe_key");