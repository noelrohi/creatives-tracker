CREATE TYPE "public"."awareness_level" AS ENUM('unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware');--> statement-breakpoint
CREATE TYPE "public"."format" AS ENUM('static', 'video', 'ugc', 'carousel');--> statement-breakpoint
CREATE TYPE "public"."funnel_position" AS ENUM('cold_traffic_entry', 'retarget', 'upsell');--> statement-breakpoint
CREATE TYPE "public"."objective" AS ENUM('conversions', 'traffic', 'engagement', 'awareness', 'leads', 'app_installs');--> statement-breakpoint
CREATE TYPE "public"."page_type" AS ENUM('product_page', 'advertorial', 'listicle', 'quiz', 'other');--> statement-breakpoint
CREATE TABLE "ad_creative" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"asset_url" text,
	"format" "format" NOT NULL,
	"angle" text NOT NULL,
	"persona" text NOT NULL,
	"awareness_level" "awareness_level" NOT NULL,
	"hook" text NOT NULL,
	"tone" text[] NOT NULL,
	"cta" text NOT NULL,
	"landing_page_id" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_set" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ad_creative_id" text NOT NULL,
	"landing_page_version_id" text NOT NULL,
	"campaign_config_id" text NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_config" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"objective" "objective" NOT NULL,
	"cost_cap" text,
	"targeting_method" text[] NOT NULL,
	"demographics" text,
	"geos" text[] NOT NULL,
	"daily_budget" numeric NOT NULL,
	"placements" text[],
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landing_page_version" (
	"id" text PRIMARY KEY NOT NULL,
	"landing_page_id" text NOT NULL,
	"version" integer NOT NULL,
	"screenshot_url" text,
	"page_type" "page_type" NOT NULL,
	"hero_copy" text NOT NULL,
	"benefits" text[] NOT NULL,
	"social_proof_type" text[] NOT NULL,
	"funnel_position" "funnel_position" NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landing_page" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_log" (
	"id" text PRIMARY KEY NOT NULL,
	"ad_set_id" text NOT NULL,
	"roas" numeric,
	"cpa" numeric,
	"ctr" numeric,
	"conversion_rate" numeric,
	"spend" numeric,
	"conversions" integer,
	"date_start" date NOT NULL,
	"date_end" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "todo" CASCADE;--> statement-breakpoint
ALTER TABLE "ad_creative" ADD CONSTRAINT "ad_creative_landing_page_id_landing_page_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_page"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creative" ADD CONSTRAINT "ad_creative_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_ad_creative_id_ad_creative_id_fk" FOREIGN KEY ("ad_creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_landing_page_version_id_landing_page_version_id_fk" FOREIGN KEY ("landing_page_version_id") REFERENCES "public"."landing_page_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_campaign_config_id_campaign_config_id_fk" FOREIGN KEY ("campaign_config_id") REFERENCES "public"."campaign_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_config" ADD CONSTRAINT "campaign_config_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page_version" ADD CONSTRAINT "landing_page_version_landing_page_id_landing_page_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page_version" ADD CONSTRAINT "landing_page_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_log" ADD CONSTRAINT "performance_log_ad_set_id_ad_set_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_creative_created_by_idx" ON "ad_creative" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "ad_creative_landing_page_id_idx" ON "ad_creative" USING btree ("landing_page_id");--> statement-breakpoint
CREATE INDEX "ad_creative_format_idx" ON "ad_creative" USING btree ("format");--> statement-breakpoint
CREATE INDEX "ad_creative_awareness_level_idx" ON "ad_creative" USING btree ("awareness_level");--> statement-breakpoint
CREATE INDEX "ad_set_created_by_idx" ON "ad_set" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "ad_set_ad_creative_id_idx" ON "ad_set" USING btree ("ad_creative_id");--> statement-breakpoint
CREATE INDEX "ad_set_lp_version_id_idx" ON "ad_set" USING btree ("landing_page_version_id");--> statement-breakpoint
CREATE INDEX "ad_set_campaign_config_id_idx" ON "ad_set" USING btree ("campaign_config_id");--> statement-breakpoint
CREATE INDEX "campaign_config_created_by_idx" ON "campaign_config" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "lp_version_landing_page_id_idx" ON "landing_page_version" USING btree ("landing_page_id");--> statement-breakpoint
CREATE INDEX "lp_version_created_by_idx" ON "landing_page_version" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "landing_page_created_by_idx" ON "landing_page" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "performance_log_ad_set_id_idx" ON "performance_log" USING btree ("ad_set_id");