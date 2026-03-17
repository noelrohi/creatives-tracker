CREATE TYPE "public"."awareness_level" AS ENUM('unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware');--> statement-breakpoint
CREATE TYPE "public"."format" AS ENUM('static', 'video', 'ugc', 'carousel');--> statement-breakpoint
CREATE TYPE "public"."funnel_position" AS ENUM('cold_traffic_entry', 'retarget', 'upsell');--> statement-breakpoint
CREATE TYPE "public"."objective" AS ENUM('conversions', 'traffic', 'engagement', 'awareness', 'leads', 'app_installs');--> statement-breakpoint
CREATE TYPE "public"."page_type" AS ENUM('product_page', 'advertorial', 'listicle', 'quiz', 'other');--> statement-breakpoint
CREATE TABLE "ad_creative" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Untitled Creative' NOT NULL,
	"asset_url" text,
	"format" "format",
	"angle" text,
	"persona" text,
	"awareness_level" "awareness_level",
	"hook" text,
	"tone" text[],
	"cta" text,
	"landing_page_id" text,
	"notes" text,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_set" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Untitled Ad Set' NOT NULL,
	"ad_creative_id" text,
	"landing_page_version_id" text,
	"campaign_config_id" text,
	"notes" text,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_config" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Untitled Campaign' NOT NULL,
	"objective" "objective",
	"cost_cap" text,
	"targeting_method" text[],
	"demographics" text,
	"geos" text[],
	"daily_budget" numeric,
	"placements" text[],
	"notes" text,
	"organization_id" text NOT NULL,
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
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landing_page" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"organization_id" text NOT NULL,
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
	"organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_creative" ADD CONSTRAINT "ad_creative_landing_page_id_landing_page_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_page"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creative" ADD CONSTRAINT "ad_creative_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creative" ADD CONSTRAINT "ad_creative_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_ad_creative_id_ad_creative_id_fk" FOREIGN KEY ("ad_creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_landing_page_version_id_landing_page_version_id_fk" FOREIGN KEY ("landing_page_version_id") REFERENCES "public"."landing_page_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_campaign_config_id_campaign_config_id_fk" FOREIGN KEY ("campaign_config_id") REFERENCES "public"."campaign_config"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_set" ADD CONSTRAINT "ad_set_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_config" ADD CONSTRAINT "campaign_config_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_config" ADD CONSTRAINT "campaign_config_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page_version" ADD CONSTRAINT "landing_page_version_landing_page_id_landing_page_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page_version" ADD CONSTRAINT "landing_page_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page_version" ADD CONSTRAINT "landing_page_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_log" ADD CONSTRAINT "performance_log_ad_set_id_ad_set_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_log" ADD CONSTRAINT "performance_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_creative_organization_id_idx" ON "ad_creative" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_creative_created_by_idx" ON "ad_creative" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "ad_creative_landing_page_id_idx" ON "ad_creative" USING btree ("landing_page_id");--> statement-breakpoint
CREATE INDEX "ad_creative_format_idx" ON "ad_creative" USING btree ("format");--> statement-breakpoint
CREATE INDEX "ad_creative_awareness_level_idx" ON "ad_creative" USING btree ("awareness_level");--> statement-breakpoint
CREATE INDEX "ad_set_organization_id_idx" ON "ad_set" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_set_created_by_idx" ON "ad_set" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "ad_set_ad_creative_id_idx" ON "ad_set" USING btree ("ad_creative_id");--> statement-breakpoint
CREATE INDEX "ad_set_lp_version_id_idx" ON "ad_set" USING btree ("landing_page_version_id");--> statement-breakpoint
CREATE INDEX "ad_set_campaign_config_id_idx" ON "ad_set" USING btree ("campaign_config_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "campaign_config_organization_id_idx" ON "campaign_config" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "campaign_config_created_by_idx" ON "campaign_config" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "lp_version_landing_page_id_idx" ON "landing_page_version" USING btree ("landing_page_id");--> statement-breakpoint
CREATE INDEX "lp_version_organization_id_idx" ON "landing_page_version" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lp_version_created_by_idx" ON "landing_page_version" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "landing_page_organization_id_idx" ON "landing_page" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "landing_page_created_by_idx" ON "landing_page" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "performance_log_ad_set_id_idx" ON "performance_log" USING btree ("ad_set_id");--> statement-breakpoint
CREATE INDEX "performance_log_organization_id_idx" ON "performance_log" USING btree ("organization_id");