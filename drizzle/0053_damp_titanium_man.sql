CREATE TYPE "public"."funnel_stage" AS ENUM('tof', 'mof', 'bof');--> statement-breakpoint
CREATE TYPE "public"."lp_classification_status" AS ENUM('suggested', 'confirmed', 'stale');--> statement-breakpoint
CREATE TYPE "public"."meta_ad_match_method" AS ENUM('id', 'name', 'unmatched');--> statement-breakpoint
ALTER TYPE "public"."finding_type" ADD VALUE 'ad_lp_funnel_mismatch';--> statement-breakpoint
ALTER TYPE "public"."finding_type" ADD VALUE 'untagged_spend';--> statement-breakpoint
ALTER TYPE "public"."finding_type" ADD VALUE 'utm_template_drift';--> statement-breakpoint
CREATE TABLE "landing_page" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"normalized_url" text NOT NULL,
	"family" text,
	"first_seen_in_ads_at" timestamp,
	"first_seen_in_journeys_at" timestamp,
	"page_type" "page_type",
	"funnel_stage" "funnel_stage",
	"awareness_fit" "awareness_level",
	"classification_status" "lp_classification_status",
	"classification_source" text,
	"classification_confidence" numeric,
	"content_hash" text,
	"classified_at" timestamp,
	"confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "landing_page_org_normalized_url_uniq" UNIQUE("organization_id","normalized_url")
);
--> statement-breakpoint
ALTER TABLE "ad_creative" ADD COLUMN "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_creative" ADD COLUMN "attributes_meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "ad_creative" SET "attributes" = jsonb_strip_nulls("attributes" || jsonb_build_object('hook', "hook", 'cta', "cta"));--> statement-breakpoint
ALTER TABLE "ad" ADD COLUMN "funnel_stage" "funnel_stage";--> statement-breakpoint
ALTER TABLE "ad" ADD COLUMN "funnel_stage_source" text;--> statement-breakpoint
ALTER TABLE "ad" ADD COLUMN "funnel_stage_confidence" numeric;--> statement-breakpoint
ALTER TABLE "ad" ADD COLUMN "landing_page_id" text;--> statement-breakpoint
ALTER TABLE "shopify_order" ADD COLUMN "meta_ad_set_id" text;--> statement-breakpoint
ALTER TABLE "shopify_order" ADD COLUMN "meta_ad_id" text;--> statement-breakpoint
ALTER TABLE "shopify_order" ADD COLUMN "meta_ad_match_method" "meta_ad_match_method";--> statement-breakpoint
ALTER TABLE "shopify_order" ADD COLUMN "landing_page_id" text;--> statement-breakpoint
CREATE INDEX "landing_page_org_family_idx" ON "landing_page" USING btree ("organization_id","family");--> statement-breakpoint
ALTER TABLE "ad" ADD CONSTRAINT "ad_landing_page_id_landing_page_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_page"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_order" ADD CONSTRAINT "shopify_order_landing_page_id_landing_page_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_page"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_funnel_stage_idx" ON "ad" USING btree ("funnel_stage");--> statement-breakpoint
CREATE INDEX "ad_landing_page_id_idx" ON "ad" USING btree ("landing_page_id");--> statement-breakpoint
CREATE INDEX "shopify_order_org_store_meta_ad_id_idx" ON "shopify_order" USING btree ("organization_id","store_id","meta_ad_id");--> statement-breakpoint
ALTER TABLE "ad_creative" DROP COLUMN "hook";--> statement-breakpoint
ALTER TABLE "ad_creative" DROP COLUMN "cta";--> statement-breakpoint
UPDATE "studio_taxonomy_value" SET "kind" = 'message' WHERE "kind" = 'angle';--> statement-breakpoint
UPDATE "studio_taxonomy_value" SET "kind" = 'concept' WHERE "kind" = 'visual_style';--> statement-breakpoint
DROP TYPE "public"."funnel_position";