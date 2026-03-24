ALTER TABLE "performance_log" ADD COLUMN "add_to_cart" integer;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "initiate_checkout" integer;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "cost_per_add_to_cart" numeric;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "video_views_3s" integer;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "video_thruplay" integer;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "video_avg_watch_time" numeric;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "placement" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "device" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "age" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "gender" text;