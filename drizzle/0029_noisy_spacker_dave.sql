ALTER TABLE "launchpad_publish_item" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "launchpad_publish_item" ADD COLUMN "last_retry_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "launchpad_publish_item" ADD COLUMN "last_retry_requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "launchpad_publish_item" ADD COLUMN "last_retry_requested_by_principal_type" "launchpad_principal_type";--> statement-breakpoint
ALTER TABLE "launchpad_publish_item" ADD COLUMN "last_retry_requested_by_role" text;--> statement-breakpoint
ALTER TABLE "launchpad_publish_run" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "launchpad_publish_run" ADD COLUMN "last_retry_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "launchpad_publish_run" ADD COLUMN "last_retry_requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "launchpad_publish_run" ADD COLUMN "last_retry_requested_by_principal_type" "launchpad_principal_type";--> statement-breakpoint
ALTER TABLE "launchpad_publish_run" ADD COLUMN "last_retry_requested_by_role" text;