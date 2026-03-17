ALTER TABLE "ad_set" DROP CONSTRAINT "ad_set_ad_creative_id_ad_creative_id_fk";
--> statement-breakpoint
ALTER TABLE "ad_set" DROP CONSTRAINT "ad_set_landing_page_version_id_landing_page_version_id_fk";
--> statement-breakpoint
ALTER TABLE "ad_set" DROP CONSTRAINT "ad_set_campaign_config_id_campaign_config_id_fk";
--> statement-breakpoint
ALTER TABLE "ad_creative" ALTER COLUMN "name" SET DEFAULT 'Untitled Creative';--> statement-breakpoint
ALTER TABLE "ad_creative" ALTER COLUMN "format" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_creative" ALTER COLUMN "angle" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_creative" ALTER COLUMN "persona" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_creative" ALTER COLUMN "awareness_level" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_creative" ALTER COLUMN "hook" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_creative" ALTER COLUMN "tone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_creative" ALTER COLUMN "cta" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_set" ALTER COLUMN "name" SET DEFAULT 'Untitled Ad Set';--> statement-breakpoint
ALTER TABLE "ad_set" ALTER COLUMN "ad_creative_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_set" ALTER COLUMN "landing_page_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_set" ALTER COLUMN "campaign_config_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_config" ALTER COLUMN "name" SET DEFAULT 'Untitled Campaign';--> statement-breakpoint
ALTER TABLE "campaign_config" ALTER COLUMN "objective" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_config" ALTER COLUMN "targeting_method" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_config" ALTER COLUMN "geos" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_config" ALTER COLUMN "daily_budget" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_ad_creative_id_ad_creative_id_fk" FOREIGN KEY ("ad_creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_landing_page_version_id_landing_page_version_id_fk" FOREIGN KEY ("landing_page_version_id") REFERENCES "public"."landing_page_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_campaign_config_id_campaign_config_id_fk" FOREIGN KEY ("campaign_config_id") REFERENCES "public"."campaign_config"("id") ON DELETE set null ON UPDATE no action;