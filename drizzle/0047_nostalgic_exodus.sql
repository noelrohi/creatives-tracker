ALTER TABLE "performance_log" ADD COLUMN "meta_ad_id" text;--> statement-breakpoint
CREATE INDEX "performance_log_meta_ad_id_idx" ON "performance_log" USING btree ("meta_ad_id");