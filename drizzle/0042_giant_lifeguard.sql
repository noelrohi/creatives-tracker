ALTER TABLE "studio_suggestion" ADD COLUMN "hypothesis" text;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD COLUMN "linked_creative_id" text;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD CONSTRAINT "studio_variant_linked_creative_id_ad_creative_id_fk" FOREIGN KEY ("linked_creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE set null ON UPDATE no action;