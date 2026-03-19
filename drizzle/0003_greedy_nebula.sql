ALTER TABLE "performance_log" ADD COLUMN "impressions" integer;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "reach" integer;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "frequency" numeric;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "cpm" numeric;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "quality_ranking" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "engagement_rate_ranking" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "conversion_rate_ranking" text;