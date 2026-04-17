DROP INDEX "account_sync_run_dispatched_at_idx";--> statement-breakpoint
ALTER TABLE "account_sync_run" DROP COLUMN "dispatched_at";--> statement-breakpoint
ALTER TABLE "account_sync_run" DROP COLUMN "inngest_function_id";--> statement-breakpoint
ALTER TABLE "account_sync_run" DROP COLUMN "inngest_run_id";