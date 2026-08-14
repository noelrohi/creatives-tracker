CREATE TYPE "public"."cluster_tier" AS ENUM('high', 'moderate', 'watch');--> statement-breakpoint
CREATE TYPE "public"."cluster_verdict" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."competitor_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."intel_pipeline_status" AS ENUM('received', 'mirroring', 'scoring', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."intel_source" AS ENUM('meta_ads_collector', 'scrapecreators');--> statement-breakpoint
CREATE TYPE "public"."test_plan_ad_status" AS ENUM('proposed', 'approved', 'testing', 'done', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."test_plan_format" AS ENUM('static', 'video');--> statement-breakpoint
CREATE TABLE "competitor_ad" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"competitor_id" text NOT NULL,
	"archive_id" text NOT NULL,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp,
	"body_text" text NOT NULL,
	"title" text,
	"link_url" text NOT NULL,
	"link_description" text,
	"cta_text" text,
	"cta_type" text,
	"display_format" text NOT NULL,
	"publisher_platforms" jsonb NOT NULL,
	"collation_id" text,
	"collation_count" integer,
	"variants" jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"mirrored_image_url" text,
	"mirrored_video_url" text,
	"mirrored_preview_url" text,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"no_longer_seen_at" timestamp,
	"copy_cluster_id" text,
	"last_snapshot_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"meta_page_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "competitor_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_cluster" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"competitor_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"label" text NOT NULL,
	"angle" text,
	"summary" text NOT NULL,
	"ad_count" integer NOT NULL,
	"score" double precision,
	"tier" "cluster_tier",
	"longevity_points" double precision,
	"variant_points" double precision,
	"strategic_points" double precision,
	"format_points" double precision,
	"landing_points" double precision,
	"verdict" "cluster_verdict",
	"verdict_rationale" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intel_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"competitor_id" text NOT NULL,
	"source" "intel_source" NOT NULL,
	"ad_count" integer NOT NULL,
	"pipeline_status" "intel_pipeline_status" DEFAULT 'received' NOT NULL,
	"error" text,
	"mirrored_count" integer DEFAULT 0 NOT NULL,
	"filled_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_plan_ad" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"concept_id" text NOT NULL,
	"hook" text NOT NULL,
	"format" "test_plan_format" NOT NULL,
	"status" "test_plan_ad_status" DEFAULT 'proposed' NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_plan_concept" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"title" text NOT NULL,
	"angle" text NOT NULL,
	"audience" text NOT NULL,
	"evidence_cluster_ids" jsonb NOT NULL,
	"evidence_citation" text NOT NULL,
	"measurement_plan" text NOT NULL,
	"claim_guardrail" text,
	"hooks" jsonb NOT NULL,
	"generated_snapshot_id" text,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competitor_ad" ADD CONSTRAINT "competitor_ad_competitor_id_competitor_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_ad" ADD CONSTRAINT "competitor_ad_copy_cluster_id_copy_cluster_id_fk" FOREIGN KEY ("copy_cluster_id") REFERENCES "public"."copy_cluster"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_ad" ADD CONSTRAINT "competitor_ad_last_snapshot_id_intel_snapshot_id_fk" FOREIGN KEY ("last_snapshot_id") REFERENCES "public"."intel_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_cluster" ADD CONSTRAINT "copy_cluster_competitor_id_competitor_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_cluster" ADD CONSTRAINT "copy_cluster_snapshot_id_intel_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."intel_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intel_snapshot" ADD CONSTRAINT "intel_snapshot_competitor_id_competitor_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_ad" ADD CONSTRAINT "test_plan_ad_concept_id_test_plan_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."test_plan_concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_concept" ADD CONSTRAINT "test_plan_concept_generated_snapshot_id_intel_snapshot_id_fk" FOREIGN KEY ("generated_snapshot_id") REFERENCES "public"."intel_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_ad_organization_id_archive_id_uidx" ON "competitor_ad" USING btree ("organization_id","archive_id");--> statement-breakpoint
CREATE INDEX "competitor_ad_organization_id_idx" ON "competitor_ad" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "competitor_ad_competitor_id_idx" ON "competitor_ad" USING btree ("competitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_organization_id_meta_page_id_uidx" ON "competitor" USING btree ("organization_id","meta_page_id");--> statement-breakpoint
CREATE INDEX "competitor_organization_id_idx" ON "competitor" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "copy_cluster_organization_id_idx" ON "copy_cluster" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "copy_cluster_competitor_id_idx" ON "copy_cluster" USING btree ("competitor_id");--> statement-breakpoint
CREATE INDEX "intel_snapshot_organization_id_idx" ON "intel_snapshot" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "intel_snapshot_competitor_id_idx" ON "intel_snapshot" USING btree ("competitor_id");--> statement-breakpoint
CREATE INDEX "test_plan_ad_organization_id_idx" ON "test_plan_ad" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "test_plan_concept_organization_id_idx" ON "test_plan_concept" USING btree ("organization_id");