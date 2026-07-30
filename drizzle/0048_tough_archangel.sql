CREATE TYPE "public"."finding_type" AS ENUM('meta_overclaim', 'unattributed_spike', 'broken_utm_template', 'sync_failure', 'roas_below_target');--> statement-breakpoint
CREATE TYPE "public"."attribution_bucket" AS ENUM('meta', 'google', 'klaviyo', 'tiktok', 'organic_direct', 'unattributed', 'untracked');--> statement-breakpoint
CREATE TABLE "finding_mute" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"type" "finding_type" NOT NULL,
	"muted_until" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "finding_mute_org_type_uniq" UNIQUE("organization_id","type")
);
--> statement-breakpoint
CREATE TABLE "finding" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text,
	"type" "finding_type" NOT NULL,
	"fired_at" timestamp DEFAULT now() NOT NULL,
	"period_start" date,
	"period_end" date,
	"payload" jsonb NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"roas_target" numeric DEFAULT '1.5' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_settings_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "shopify_order" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"shopify_order_id" text NOT NULL,
	"order_created_at" timestamp NOT NULL,
	"order_updated_at" timestamp,
	"order_day" date NOT NULL,
	"net_sales" numeric NOT NULL,
	"taxes_included" boolean,
	"customer_journey" jsonb,
	"journey_ready" boolean DEFAULT false NOT NULL,
	"pending_since" timestamp,
	"last_click_utm_source" text,
	"last_click_utm_medium" text,
	"last_click_utm_campaign" text,
	"bucket" "attribution_bucket",
	"bucket_rule_version" integer,
	"meta_verified" boolean DEFAULT false NOT NULL,
	"meta_campaign_id" text,
	"verification_pending" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp,
	"order_source_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_order_store_order_uniq" UNIQUE("store_id","shopify_order_id")
);
--> statement-breakpoint
CREATE TABLE "shopify_refund" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"order_id" text NOT NULL,
	"shopify_refund_id" text NOT NULL,
	"refund_day" date NOT NULL,
	"amount" numeric NOT NULL,
	"refund_created_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_refund_store_refund_uniq" UNIQUE("store_id","shopify_refund_id")
);
--> statement-breakpoint
CREATE TABLE "shopify_store" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shop_domain" text NOT NULL,
	"access_token" text,
	"iana_timezone" text NOT NULL,
	"currency" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_store_shop_domain_unique" UNIQUE("shop_domain")
);
--> statement-breakpoint
CREATE TABLE "shopify_sync_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"trigger_type" text NOT NULL,
	"phase" text NOT NULL,
	"date_from" date,
	"date_to" date,
	"result" text,
	"orders_synced" integer,
	"error" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"meta" jsonb
);
--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "purchase_value_7d_click" numeric;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "purchase_value_1d_view" numeric;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "attribution_windows" text;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_store_id_shopify_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopify_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_order" ADD CONSTRAINT "shopify_order_store_id_shopify_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopify_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_refund" ADD CONSTRAINT "shopify_refund_store_id_shopify_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopify_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_refund" ADD CONSTRAINT "shopify_refund_order_id_shopify_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shopify_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_sync_run" ADD CONSTRAINT "shopify_sync_run_store_id_shopify_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopify_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_organization_id_idx" ON "finding" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "finding_org_store_fired_at_idx" ON "finding" USING btree ("organization_id","store_id","fired_at");--> statement-breakpoint
CREATE INDEX "shopify_order_organization_id_idx" ON "shopify_order" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "shopify_order_org_store_day_idx" ON "shopify_order" USING btree ("organization_id","store_id","order_day");--> statement-breakpoint
CREATE INDEX "shopify_order_org_store_bucket_idx" ON "shopify_order" USING btree ("organization_id","store_id","bucket");--> statement-breakpoint
CREATE INDEX "shopify_refund_organization_id_idx" ON "shopify_refund" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "shopify_refund_org_store_day_idx" ON "shopify_refund" USING btree ("organization_id","store_id","refund_day");--> statement-breakpoint
CREATE INDEX "shopify_store_organization_id_idx" ON "shopify_store" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "shopify_sync_run_organization_id_idx" ON "shopify_sync_run" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "shopify_sync_run_org_store_requested_at_idx" ON "shopify_sync_run" USING btree ("organization_id","store_id","requested_at");