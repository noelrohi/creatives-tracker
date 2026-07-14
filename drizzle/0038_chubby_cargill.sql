CREATE TABLE "studio_suggestion_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"suggestion_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"index" integer NOT NULL,
	"headline" text NOT NULL,
	"diff_summary" text NOT NULL,
	"copy_line" text NOT NULL,
	"elements" jsonb NOT NULL,
	"format" text DEFAULT 'square' NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"generation_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_suggestion" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_creative_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"why_line" text NOT NULL,
	"angle" text,
	"persona" text,
	"awareness_level" "awareness_level",
	"roas" text,
	"purchases" integer,
	"spend" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_suggestion_variant" ADD CONSTRAINT "studio_suggestion_variant_suggestion_id_studio_suggestion_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."studio_suggestion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_suggestion_variant" ADD CONSTRAINT "studio_suggestion_variant_generation_id_studio_generation_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."studio_generation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD CONSTRAINT "studio_suggestion_source_creative_id_ad_creative_id_fk" FOREIGN KEY ("source_creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_suggestion_variant_suggestion_id_idx" ON "studio_suggestion_variant" USING btree ("suggestion_id");--> statement-breakpoint
CREATE INDEX "studio_suggestion_variant_organization_id_idx" ON "studio_suggestion_variant" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "studio_suggestion_organization_id_idx" ON "studio_suggestion" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "studio_suggestion_created_at_idx" ON "studio_suggestion" USING btree ("created_at");