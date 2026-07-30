ALTER TABLE "shopify_order" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "shopify_refund" ADD COLUMN "kind" text DEFAULT 'refund' NOT NULL;