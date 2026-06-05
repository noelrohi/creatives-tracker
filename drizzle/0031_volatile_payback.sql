CREATE TYPE "public"."launchpad_source_template_status" AS ENUM('approved', 'disabled', 'needs_review');--> statement-breakpoint
CREATE TABLE "launchpad_source_template" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text,
	"source_campaign_id" text,
	"source_campaign_meta_id" text NOT NULL,
	"source_ad_set_id" text,
	"source_ad_set_meta_id" text NOT NULL,
	"label" text NOT NULL,
	"notes" text,
	"status" "launchpad_source_template_status" DEFAULT 'needs_review' NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp,
	"last_validated_at" timestamp,
	"expires_at" timestamp,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "launchpad_source_template" ADD CONSTRAINT "launchpad_source_template_account_id_ad_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launchpad_source_template" ADD CONSTRAINT "launchpad_source_template_source_campaign_id_campaign_id_fk" FOREIGN KEY ("source_campaign_id") REFERENCES "public"."campaign"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launchpad_source_template" ADD CONSTRAINT "launchpad_source_template_source_ad_set_id_ad_set_id_fk" FOREIGN KEY ("source_ad_set_id") REFERENCES "public"."ad_set"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "launchpad_source_template_org_status_idx" ON "launchpad_source_template" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "launchpad_source_template_account_idx" ON "launchpad_source_template" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "launchpad_source_template_source_campaign_idx" ON "launchpad_source_template" USING btree ("source_campaign_id");--> statement-breakpoint
CREATE INDEX "launchpad_source_template_source_ad_set_idx" ON "launchpad_source_template" USING btree ("source_ad_set_id");--> statement-breakpoint
CREATE INDEX "launchpad_source_template_expires_at_idx" ON "launchpad_source_template" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_account_id_ad_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_account_id_idx" ON "campaign" USING btree ("account_id");