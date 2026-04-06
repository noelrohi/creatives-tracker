ALTER TABLE "ad_creative" DROP CONSTRAINT IF EXISTS "ad_creative_landing_page_id_landing_page_id_fk";
--> statement-breakpoint
ALTER TABLE "ad" DROP CONSTRAINT IF EXISTS "ad_landing_page_version_id_landing_page_version_id_fk";
--> statement-breakpoint
ALTER TABLE "landing_page_version" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "landing_page" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "landing_page_version" CASCADE;--> statement-breakpoint
DROP TABLE "landing_page" CASCADE;--> statement-breakpoint
ALTER TABLE "entity_tag" ALTER COLUMN "entity_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."entity_type";--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('ad_creative', 'campaign', 'ad_set', 'ad');--> statement-breakpoint
ALTER TABLE "entity_tag" ALTER COLUMN "entity_type" SET DATA TYPE "public"."entity_type" USING "entity_type"::"public"."entity_type";--> statement-breakpoint
DROP INDEX IF EXISTS "ad_creative_landing_page_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "ad_lp_version_id_idx";--> statement-breakpoint
ALTER TABLE "ad_creative" DROP COLUMN IF EXISTS "landing_page_id";--> statement-breakpoint
ALTER TABLE "ad" DROP COLUMN IF EXISTS "landing_page_version_id";
