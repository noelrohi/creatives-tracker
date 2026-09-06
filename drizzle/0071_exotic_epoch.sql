ALTER TABLE "shopify_order" ADD COLUMN "fulfillment_status" text;--> statement-breakpoint
ALTER TABLE "shopify_order" ADD COLUMN "fulfillment_status_observed_at" timestamp;