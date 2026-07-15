CREATE TABLE "studio_copy_package" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"angle_id" text,
	"primary_text" text NOT NULL,
	"headline" text NOT NULL,
	"description" text NOT NULL,
	"source_creative_id" text,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_swipe" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"image_url" text NOT NULL,
	"source_url" text,
	"brand_name" text,
	"angle_id" text,
	"visual_style_id" text,
	"why_it_works" text,
	"elements" jsonb,
	"added_by" text,
	"archived_at" timestamp,
	"last_tried_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_taxonomy_value" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_variant" DROP CONSTRAINT "studio_variant_saved_creative_id_ad_creative_id_fk";
--> statement-breakpoint
ALTER TABLE "studio_suggestion" ALTER COLUMN "status" SET DEFAULT 'proposed';--> statement-breakpoint
UPDATE "studio_suggestion" SET "status" = CASE WHEN "status" = 'active' THEN 'proposed' WHEN "status" = 'archived' THEN 'expired' ELSE "status" END;--> statement-breakpoint
ALTER TABLE "studio_generation" ADD COLUMN "swipe_id" text;--> statement-breakpoint
ALTER TABLE "studio_generation" ADD COLUMN "copy_package_id" text;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "swipe_id" text;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "brief" text;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "elements" jsonb;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "angle_id" text;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "visual_style_id" text;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "format" text DEFAULT 'square' NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "count" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "copy_package_id" text;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "generation_id" text;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD COLUMN "actioned_at" timestamp;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD COLUMN "mark" text;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD COLUMN "published_at" timestamp;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD COLUMN "copy_package_id" text;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD COLUMN "moderation_reason" text;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD COLUMN "retry_without_image_at" timestamp;--> statement-breakpoint
UPDATE "studio_variant" SET "mark" = 'good' WHERE "starred_at" IS NOT NULL;--> statement-breakpoint
INSERT INTO "studio_taxonomy_value" ("id", "organization_id", "kind", "name", "slug")
SELECT "organization_id" || ':angle:' || seed.slug, "organization_id", 'angle', seed.name, seed.slug
FROM (SELECT DISTINCT "organization_id" FROM "member") org
CROSS JOIN (VALUES
  ('vs. the expensive fix', 'vs-the-expensive-fix'),
  ('creams don''t work', 'creams-dont-work'),
  ('week-by-week timeline', 'week-by-week-timeline'),
  ('nobody talks about this', 'nobody-talks-about-this'),
  ('clothing freedom', 'clothing-freedom'),
  ('feel like yourself again', 'feel-like-yourself-again'),
  ('offer/bundle', 'offer-bundle')
) AS seed(name, slug)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "studio_taxonomy_value" ("id", "organization_id", "kind", "name", "slug")
SELECT "organization_id" || ':visual-style:' || seed.slug, "organization_id", 'visual_style', seed.name, seed.slug
FROM (SELECT DISTINCT "organization_id" FROM "member") org
CROSS JOIN (VALUES
  ('before/after', 'before-after'),
  ('us vs. them', 'us-vs-them'),
  ('testimonial', 'testimonial'),
  ('facts & stats', 'facts-stats'),
  ('features & benefits', 'features-benefits'),
  ('native/screenshot', 'native-screenshot')
) AS seed(name, slug)
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "studio_copy_package" ADD CONSTRAINT "studio_copy_package_angle_id_studio_taxonomy_value_id_fk" FOREIGN KEY ("angle_id") REFERENCES "public"."studio_taxonomy_value"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_copy_package" ADD CONSTRAINT "studio_copy_package_source_creative_id_ad_creative_id_fk" FOREIGN KEY ("source_creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_swipe" ADD CONSTRAINT "studio_swipe_angle_id_studio_taxonomy_value_id_fk" FOREIGN KEY ("angle_id") REFERENCES "public"."studio_taxonomy_value"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_swipe" ADD CONSTRAINT "studio_swipe_visual_style_id_studio_taxonomy_value_id_fk" FOREIGN KEY ("visual_style_id") REFERENCES "public"."studio_taxonomy_value"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_copy_package_organization_id_idx" ON "studio_copy_package" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "studio_copy_package_angle_id_idx" ON "studio_copy_package" USING btree ("angle_id");--> statement-breakpoint
CREATE INDEX "studio_swipe_organization_id_idx" ON "studio_swipe" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_swipe_org_source_url_uidx" ON "studio_swipe" USING btree ("organization_id","source_url");--> statement-breakpoint
CREATE INDEX "studio_swipe_angle_id_idx" ON "studio_swipe" USING btree ("angle_id");--> statement-breakpoint
CREATE INDEX "studio_swipe_visual_style_id_idx" ON "studio_swipe" USING btree ("visual_style_id");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_taxonomy_value_org_kind_slug_uidx" ON "studio_taxonomy_value" USING btree ("organization_id","kind","slug");--> statement-breakpoint
CREATE INDEX "studio_taxonomy_value_org_kind_idx" ON "studio_taxonomy_value" USING btree ("organization_id","kind");--> statement-breakpoint
ALTER TABLE "studio_generation" ADD CONSTRAINT "studio_generation_swipe_id_studio_swipe_id_fk" FOREIGN KEY ("swipe_id") REFERENCES "public"."studio_swipe"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_generation" ADD CONSTRAINT "studio_generation_copy_package_id_studio_copy_package_id_fk" FOREIGN KEY ("copy_package_id") REFERENCES "public"."studio_copy_package"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD CONSTRAINT "studio_suggestion_swipe_id_studio_swipe_id_fk" FOREIGN KEY ("swipe_id") REFERENCES "public"."studio_swipe"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD CONSTRAINT "studio_suggestion_angle_id_studio_taxonomy_value_id_fk" FOREIGN KEY ("angle_id") REFERENCES "public"."studio_taxonomy_value"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD CONSTRAINT "studio_suggestion_visual_style_id_studio_taxonomy_value_id_fk" FOREIGN KEY ("visual_style_id") REFERENCES "public"."studio_taxonomy_value"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD CONSTRAINT "studio_suggestion_copy_package_id_studio_copy_package_id_fk" FOREIGN KEY ("copy_package_id") REFERENCES "public"."studio_copy_package"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_suggestion" ADD CONSTRAINT "studio_suggestion_generation_id_studio_generation_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."studio_generation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD CONSTRAINT "studio_variant_copy_package_id_studio_copy_package_id_fk" FOREIGN KEY ("copy_package_id") REFERENCES "public"."studio_copy_package"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_suggestion_status_idx" ON "studio_suggestion" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "studio_variant_mark_idx" ON "studio_variant" USING btree ("organization_id","mark");--> statement-breakpoint
ALTER TABLE "studio_variant" DROP COLUMN "starred_at";--> statement-breakpoint
ALTER TABLE "studio_variant" DROP COLUMN "saved_creative_id";