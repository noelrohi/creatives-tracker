ALTER TABLE "account_sync_run" ADD COLUMN "dispatched_at" timestamp;--> statement-breakpoint
CREATE INDEX "account_sync_run_dispatched_at_idx" ON "account_sync_run" USING btree ("dispatched_at");