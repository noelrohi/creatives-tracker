CREATE TYPE "public"."ab_test_status" AS ENUM('running', 'completed', 'paused');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('ad_creative', 'landing_page', 'campaign_config', 'ad_set');--> statement-breakpoint
CREATE TABLE "ab_test_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"ab_test_id" text NOT NULL,
	"ad_set_id" text NOT NULL,
	"label" text DEFAULT 'variant' NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE TABLE "entity_tag" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "entity_tag_unique" UNIQUE("entity_type","entity_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"organization_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tag_name_org_unique" UNIQUE("name","organization_id")
);
--> statement-breakpoint
ALTER TABLE "ab_test_variant" ADD CONSTRAINT "ab_test_variant_ab_test_id_ab_test_id_fk" FOREIGN KEY ("ab_test_id") REFERENCES "public"."ab_test"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_test_variant" ADD CONSTRAINT "ab_test_variant_ad_set_id_ad_set_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_test_variant" ADD CONSTRAINT "ab_test_variant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_test" ADD CONSTRAINT "ab_test_winner_variant_id_ad_set_id_fk" FOREIGN KEY ("winner_variant_id") REFERENCES "public"."ad_set"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_test" ADD CONSTRAINT "ab_test_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ab_test" ADD CONSTRAINT "ab_test_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ab_test_variant_ab_test_id_idx" ON "ab_test_variant" USING btree ("ab_test_id");--> statement-breakpoint
CREATE INDEX "ab_test_variant_ad_set_id_idx" ON "ab_test_variant" USING btree ("ad_set_id");--> statement-breakpoint
CREATE INDEX "ab_test_variant_organization_id_idx" ON "ab_test_variant" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ab_test_organization_id_idx" ON "ab_test" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ab_test_created_by_idx" ON "ab_test" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "entity_tag_entity_idx" ON "entity_tag" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "entity_tag_tag_id_idx" ON "entity_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "entity_tag_organization_id_idx" ON "entity_tag" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tag_organization_id_idx" ON "tag" USING btree ("organization_id");