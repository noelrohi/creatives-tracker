CREATE TABLE "performance_monthly_summary" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"month" date NOT NULL,
	"spend" numeric,
	"purchase_value" numeric,
	"purchase_value_7d_click" numeric,
	"purchase_value_1d_view" numeric,
	"conversions" integer,
	"impressions" integer,
	"link_clicks" integer,
	"clicks_all" integer,
	"landing_page_views" integer,
	"add_to_cart" integer,
	"initiate_checkout" integer,
	"video_views_3s" integer,
	"video_thruplay" integer,
	"days_with_data" integer DEFAULT 0 NOT NULL,
	"source_row_count" integer DEFAULT 0 NOT NULL,
	"rolled_up_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "performance_monthly_summary_org_month_uniq" UNIQUE("organization_id","month")
);
--> statement-breakpoint
CREATE INDEX "performance_monthly_summary_org_idx" ON "performance_monthly_summary" USING btree ("organization_id");