CREATE TYPE "public"."creative_variant_status" AS ENUM('pending', 'good', 'bad');--> statement-breakpoint
CREATE TABLE "creative_variant_batch" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_creative_id" text NOT NULL,
	"source_ad_id" text,
	"window_from" text NOT NULL,
	"window_to" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"performance_snapshot" jsonb NOT NULL,
	"generated_count" integer NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"position" integer NOT NULL,
	"status" "creative_variant_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp,
	"copy" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creative_variant_batch" ADD CONSTRAINT "creative_variant_batch_source_creative_id_ad_creative_id_fk" FOREIGN KEY ("source_creative_id") REFERENCES "public"."ad_creative"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_variant_batch" ADD CONSTRAINT "creative_variant_batch_source_ad_id_ad_id_fk" FOREIGN KEY ("source_ad_id") REFERENCES "public"."ad"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_variant" ADD CONSTRAINT "creative_variant_batch_id_creative_variant_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."creative_variant_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creative_variant_batch_org_idx" ON "creative_variant_batch" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "creative_variant_batch_source_creative_idx" ON "creative_variant_batch" USING btree ("source_creative_id");--> statement-breakpoint
CREATE INDEX "creative_variant_batch_source_ad_idx" ON "creative_variant_batch" USING btree ("source_ad_id");--> statement-breakpoint
CREATE INDEX "creative_variant_batch_created_at_idx" ON "creative_variant_batch" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "creative_variant_batch_idx" ON "creative_variant" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "creative_variant_org_idx" ON "creative_variant" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "creative_variant_status_idx" ON "creative_variant" USING btree ("status");