-- Drop FK constraints referencing auth tables FIRST (before dropping the tables)
ALTER TABLE "ab_test_variant" DROP CONSTRAINT IF EXISTS "ab_test_variant_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "ab_test" DROP CONSTRAINT IF EXISTS "ab_test_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "ab_test" DROP CONSTRAINT IF EXISTS "ab_test_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "ad_creative" DROP CONSTRAINT IF EXISTS "ad_creative_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "ad_creative" DROP CONSTRAINT IF EXISTS "ad_creative_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "ad_set" DROP CONSTRAINT IF EXISTS "ad_set_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "ad_set" DROP CONSTRAINT IF EXISTS "ad_set_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "ad" DROP CONSTRAINT IF EXISTS "ad_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "ad" DROP CONSTRAINT IF EXISTS "ad_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "campaign" DROP CONSTRAINT IF EXISTS "campaign_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "campaign" DROP CONSTRAINT IF EXISTS "campaign_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "landing_page_version" DROP CONSTRAINT IF EXISTS "landing_page_version_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "landing_page_version" DROP CONSTRAINT IF EXISTS "landing_page_version_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "landing_page" DROP CONSTRAINT IF EXISTS "landing_page_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "landing_page" DROP CONSTRAINT IF EXISTS "landing_page_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "performance_log" DROP CONSTRAINT IF EXISTS "performance_log_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "entity_tag" DROP CONSTRAINT IF EXISTS "entity_tag_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "tag" DROP CONSTRAINT IF EXISTS "tag_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "tag" DROP CONSTRAINT IF EXISTS "tag_name_org_unique";
--> statement-breakpoint
-- Now drop auth tables
ALTER TABLE "account" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitation" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verification" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "account" CASCADE;--> statement-breakpoint
DROP TABLE "invitation" CASCADE;--> statement-breakpoint
DROP TABLE "member" CASCADE;--> statement-breakpoint
DROP TABLE "organization" CASCADE;--> statement-breakpoint
DROP TABLE "session" CASCADE;--> statement-breakpoint
DROP TABLE "user" CASCADE;--> statement-breakpoint
DROP TABLE "verification" CASCADE;--> statement-breakpoint
-- Drop indexes
DROP INDEX IF EXISTS "ab_test_variant_organization_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "ab_test_organization_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "ab_test_created_by_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "ad_creative_organization_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "ad_creative_created_by_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "ad_set_organization_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "ad_set_created_by_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "ad_organization_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "ad_created_by_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "campaign_organization_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "campaign_created_by_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "lp_version_organization_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "lp_version_created_by_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "landing_page_organization_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "landing_page_created_by_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "performance_log_organization_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "entity_tag_organization_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "tag_organization_id_idx";--> statement-breakpoint
-- Add new columns
ALTER TABLE "ad_set" ADD COLUMN "meta_id" text;--> statement-breakpoint
ALTER TABLE "ad" ADD COLUMN "meta_id" text;--> statement-breakpoint
ALTER TABLE "campaign" ADD COLUMN "meta_id" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "link_clicks" integer;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "clicks_all" integer;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "cpc" numeric;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "ctr_link_click" numeric;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "landing_page_views" integer;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "cost_per_lpv" numeric;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "purchase_value" numeric;--> statement-breakpoint
-- Drop org/user columns from data tables
ALTER TABLE "ab_test_variant" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
ALTER TABLE "ab_test" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
ALTER TABLE "ab_test" DROP COLUMN IF EXISTS "created_by";--> statement-breakpoint
ALTER TABLE "ad_creative" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
ALTER TABLE "ad_creative" DROP COLUMN IF EXISTS "created_by";--> statement-breakpoint
ALTER TABLE "ad_set" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
ALTER TABLE "ad_set" DROP COLUMN IF EXISTS "created_by";--> statement-breakpoint
ALTER TABLE "ad" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
ALTER TABLE "ad" DROP COLUMN IF EXISTS "created_by";--> statement-breakpoint
ALTER TABLE "campaign" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
ALTER TABLE "campaign" DROP COLUMN IF EXISTS "created_by";--> statement-breakpoint
ALTER TABLE "landing_page_version" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
ALTER TABLE "landing_page_version" DROP COLUMN IF EXISTS "created_by";--> statement-breakpoint
ALTER TABLE "landing_page" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
ALTER TABLE "landing_page" DROP COLUMN IF EXISTS "created_by";--> statement-breakpoint
ALTER TABLE "performance_log" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
ALTER TABLE "entity_tag" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
ALTER TABLE "tag" DROP COLUMN IF EXISTS "organization_id";--> statement-breakpoint
-- Add new constraints
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_meta_id_unique" UNIQUE("meta_id");--> statement-breakpoint
ALTER TABLE "ad" ADD CONSTRAINT "ad_meta_id_unique" UNIQUE("meta_id");--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_meta_id_unique" UNIQUE("meta_id");--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_name_unique" UNIQUE("name");
