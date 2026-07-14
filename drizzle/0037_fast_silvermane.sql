ALTER TABLE "studio_generation" ADD COLUMN "format" text DEFAULT 'portrait' NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_generation" ADD COLUMN "source_creative_id" text;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD COLUMN "starred_at" timestamp;--> statement-breakpoint
ALTER TABLE "studio_generation" ADD CONSTRAINT "studio_generation_source_creative_id_ad_creative_id_fk" FOREIGN KEY ("source_creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE set null ON UPDATE no action;