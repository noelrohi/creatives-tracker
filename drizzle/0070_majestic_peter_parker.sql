CREATE TYPE "public"."shopify_evidence_refresh_strategy" AS ENUM('full', 'changed');--> statement-breakpoint
ALTER TABLE "shopify_evidence_run_observation" ADD COLUMN "source_order_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "shopify_evidence_sync_run" ADD COLUMN "refresh_strategy" "shopify_evidence_refresh_strategy" DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "shopify_evidence_sync_run" ADD COLUMN "baseline_evidence_run_id" text;--> statement-breakpoint
ALTER TABLE "shopify_evidence_sync_run" ADD COLUMN "matching_key_version" text;--> statement-breakpoint
ALTER TABLE "shopify_evidence_sync_run" ADD COLUMN "suppression_key_version" text;--> statement-breakpoint
ALTER TABLE "shopify_evidence_sync_run" ADD COLUMN "orders_carried_forward" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shopify_evidence_sync_run" ADD COLUMN "snapshot_order_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "shopify_evidence_sync_run_baseline_idx" ON "shopify_evidence_sync_run" USING btree ("baseline_evidence_run_id");--> statement-breakpoint
ALTER TABLE "shopify_evidence_sync_run" ADD CONSTRAINT "shopify_evidence_sync_run_snapshot_counts_nonnegative" CHECK ("shopify_evidence_sync_run"."orders_carried_forward" >= 0 AND "shopify_evidence_sync_run"."snapshot_order_count" >= 0);