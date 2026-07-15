ALTER TABLE "studio_brand_profile" ADD COLUMN "prohibited_claims" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_brand_profile" ADD COLUMN "required_disclaimers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "evidence" text;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "hook_type_id" text;--> statement-breakpoint
ALTER TABLE "studio_swipe" ADD COLUMN "image_hash" text;--> statement-breakpoint
ALTER TABLE "studio_swipe" ADD COLUMN "hook_type_id" text;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD CONSTRAINT "studio_suggestion_hook_type_id_studio_taxonomy_value_id_fk" FOREIGN KEY ("hook_type_id") REFERENCES "public"."studio_taxonomy_value"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_swipe" ADD CONSTRAINT "studio_swipe_hook_type_id_studio_taxonomy_value_id_fk" FOREIGN KEY ("hook_type_id") REFERENCES "public"."studio_taxonomy_value"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_suggestion_hook_type_id_idx" ON "studio_suggestion" USING btree ("hook_type_id");--> statement-breakpoint
CREATE INDEX "studio_swipe_org_image_hash_idx" ON "studio_swipe" USING btree ("organization_id","image_hash");--> statement-breakpoint
CREATE INDEX "studio_swipe_hook_type_id_idx" ON "studio_swipe" USING btree ("hook_type_id");