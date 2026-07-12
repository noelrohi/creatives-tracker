CREATE TABLE "studio_generation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text,
	"brief" text NOT NULL,
	"angle" text,
	"persona" text,
	"awareness_level" "awareness_level",
	"count" integer NOT NULL,
	"reference_image_urls" jsonb,
	"status" text DEFAULT 'generating' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"index" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"image_url" text,
	"saved_creative_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_variant" ADD CONSTRAINT "studio_variant_generation_id_studio_generation_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."studio_generation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD CONSTRAINT "studio_variant_saved_creative_id_ad_creative_id_fk" FOREIGN KEY ("saved_creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_generation_organization_id_idx" ON "studio_generation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "studio_generation_created_at_idx" ON "studio_generation" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "studio_variant_generation_id_idx" ON "studio_variant" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "studio_variant_organization_id_idx" ON "studio_variant" USING btree ("organization_id");