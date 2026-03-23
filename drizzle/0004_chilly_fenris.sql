-- Clean wipe migration: Meta-aligned hierarchy (Campaign → Ad Set → Ad)
-- Drops all affected tables and recreates from scratch.

-- Drop dependent tables first (order matters for FK constraints)
DROP TABLE IF EXISTS "performance_log" CASCADE;
DROP TABLE IF EXISTS "ab_test_variant" CASCADE;
DROP TABLE IF EXISTS "ab_test" CASCADE;
DROP TABLE IF EXISTS "entity_tag" CASCADE;
DROP TABLE IF EXISTS "ad_set" CASCADE;
DROP TABLE IF EXISTS "ad" CASCADE;
DROP TABLE IF EXISTS "campaign_config" CASCADE;
DROP TABLE IF EXISTS "campaign" CASCADE;
DROP TABLE IF EXISTS "tag" CASCADE;

-- Drop and recreate enums
DROP TYPE IF EXISTS "public"."entity_type";
DROP TYPE IF EXISTS "public"."status";
DROP TYPE IF EXISTS "public"."ab_test_status";

CREATE TYPE "public"."status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('ad_creative', 'landing_page', 'campaign', 'ad_set', 'ad');--> statement-breakpoint
CREATE TYPE "public"."ab_test_status" AS ENUM('running', 'completed', 'paused');--> statement-breakpoint

-- Campaign (slimmed down, no budget/targeting)
CREATE TABLE "campaign" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Untitled Campaign' NOT NULL,
	"objective" "objective",
	"status" "status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Ad Set (new grouping entity with budget/targeting)
CREATE TABLE "ad_set" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Untitled Ad Set' NOT NULL,
	"campaign_id" text NOT NULL,
	"cost_cap" text,
	"daily_budget" numeric,
	"targeting_method" text[],
	"geos" text[],
	"placements" text[],
	"demographics" text,
	"schedule_start" timestamp,
	"schedule_end" timestamp,
	"status" "status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Ad (leaf entity linking creative + LP)
CREATE TABLE "ad" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Untitled Ad' NOT NULL,
	"ad_set_id" text NOT NULL,
	"ad_creative_id" text,
	"landing_page_version_id" text,
	"status" "status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Performance Log (now linked to ad, not ad_set)
CREATE TABLE "performance_log" (
	"id" text PRIMARY KEY NOT NULL,
	"ad_id" text NOT NULL,
	"roas" numeric,
	"cpa" numeric,
	"ctr" numeric,
	"conversion_rate" numeric,
	"spend" numeric,
	"conversions" integer,
	"impressions" integer,
	"reach" integer,
	"frequency" numeric,
	"cpm" numeric,
	"quality_ranking" text,
	"engagement_rate_ranking" text,
	"conversion_rate_ranking" text,
	"date_start" date NOT NULL,
	"date_end" date NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- A/B Test
CREATE TABLE "ab_test" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Untitled Test' NOT NULL,
	"hypothesis" text,
	"status" "ab_test_status" DEFAULT 'running' NOT NULL,
	"winner_variant_id" text,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- A/B Test Variant (now linked to ad, not ad_set)
CREATE TABLE "ab_test_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"ab_test_id" text NOT NULL,
	"ad_id" text NOT NULL,
	"label" text DEFAULT 'variant' NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Tag
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Entity Tag
CREATE TABLE "entity_tag" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Foreign keys: campaign
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Foreign keys: ad_set
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Foreign keys: ad
ALTER TABLE "ad" ADD CONSTRAINT "ad_ad_set_id_ad_set_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad" ADD CONSTRAINT "ad_ad_creative_id_ad_creative_id_fk" FOREIGN KEY ("ad_creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad" ADD CONSTRAINT "ad_landing_page_version_id_landing_page_version_id_fk" FOREIGN KEY ("landing_page_version_id") REFERENCES "public"."landing_page_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad" ADD CONSTRAINT "ad_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad" ADD CONSTRAINT "ad_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Foreign keys: performance_log
ALTER TABLE "performance_log" ADD CONSTRAINT "performance_log_ad_id_ad_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ad"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_log" ADD CONSTRAINT "performance_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Foreign keys: ab_test
ALTER TABLE "ab_test" ADD CONSTRAINT "ab_test_winner_variant_id_ad_id_fk" FOREIGN KEY ("winner_variant_id") REFERENCES "public"."ad"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_test" ADD CONSTRAINT "ab_test_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_test" ADD CONSTRAINT "ab_test_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Foreign keys: ab_test_variant
ALTER TABLE "ab_test_variant" ADD CONSTRAINT "ab_test_variant_ab_test_id_ab_test_id_fk" FOREIGN KEY ("ab_test_id") REFERENCES "public"."ab_test"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_test_variant" ADD CONSTRAINT "ab_test_variant_ad_id_ad_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ad"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_test_variant" ADD CONSTRAINT "ab_test_variant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Foreign keys: tag
ALTER TABLE "tag" ADD CONSTRAINT "tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Foreign keys: entity_tag
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Indexes: campaign
CREATE INDEX "campaign_organization_id_idx" ON "campaign" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "campaign_created_by_idx" ON "campaign" USING btree ("created_by");--> statement-breakpoint

-- Indexes: ad_set
CREATE INDEX "ad_set_organization_id_idx" ON "ad_set" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_set_created_by_idx" ON "ad_set" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "ad_set_campaign_id_idx" ON "ad_set" USING btree ("campaign_id");--> statement-breakpoint

-- Indexes: ad
CREATE INDEX "ad_organization_id_idx" ON "ad" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_created_by_idx" ON "ad" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "ad_ad_set_id_idx" ON "ad" USING btree ("ad_set_id");--> statement-breakpoint
CREATE INDEX "ad_creative_id_idx" ON "ad" USING btree ("ad_creative_id");--> statement-breakpoint
CREATE INDEX "ad_lp_version_id_idx" ON "ad" USING btree ("landing_page_version_id");--> statement-breakpoint

-- Indexes: performance_log
CREATE INDEX "performance_log_ad_id_idx" ON "performance_log" USING btree ("ad_id");--> statement-breakpoint
CREATE INDEX "performance_log_organization_id_idx" ON "performance_log" USING btree ("organization_id");--> statement-breakpoint

-- Indexes: ab_test
CREATE INDEX "ab_test_organization_id_idx" ON "ab_test" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ab_test_created_by_idx" ON "ab_test" USING btree ("created_by");--> statement-breakpoint

-- Indexes: ab_test_variant
CREATE INDEX "ab_test_variant_ab_test_id_idx" ON "ab_test_variant" USING btree ("ab_test_id");--> statement-breakpoint
CREATE INDEX "ab_test_variant_ad_id_idx" ON "ab_test_variant" USING btree ("ad_id");--> statement-breakpoint
CREATE INDEX "ab_test_variant_organization_id_idx" ON "ab_test_variant" USING btree ("organization_id");--> statement-breakpoint

-- Indexes: tag
CREATE INDEX "tag_organization_id_idx" ON "tag" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_name_org_unique" UNIQUE("name", "organization_id");--> statement-breakpoint

-- Indexes: entity_tag
CREATE INDEX "entity_tag_entity_idx" ON "entity_tag" USING btree ("entity_type", "entity_id");--> statement-breakpoint
CREATE INDEX "entity_tag_tag_id_idx" ON "entity_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "entity_tag_organization_id_idx" ON "entity_tag" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_unique" UNIQUE("entity_type", "entity_id", "tag_id");
