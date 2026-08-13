CREATE TABLE "gclid_probe_report" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text,
	"window_from_day" date NOT NULL,
	"window_to_day" date NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"orders_scanned" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"checksum" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "gclid_probe_report_status_check" CHECK ("gclid_probe_report"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "gclid_probe_report_window_check" CHECK ("gclid_probe_report"."window_from_day" <= "gclid_probe_report"."window_to_day")
);
--> statement-breakpoint
CREATE TABLE "google_ads_campaign_fact" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"campaign_name" text NOT NULL,
	"campaign_status" text,
	"channel_type" text,
	"fact_date" date NOT NULL,
	"cost_micros" bigint NOT NULL,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"conversions" numeric NOT NULL,
	"conversions_value" numeric NOT NULL,
	"currency_code" text,
	"api_version" text NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "google_ads_campaign_fact_day_uniq" UNIQUE("connection_id","campaign_id","fact_date"),
	CONSTRAINT "google_ads_campaign_fact_nonnegative_check" CHECK ("google_ads_campaign_fact"."cost_micros" >= 0 and "google_ads_campaign_fact"."impressions" >= 0 and "google_ads_campaign_fact"."clicks" >= 0)
);
--> statement-breakpoint
CREATE TABLE "google_ads_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"google_customer_id" text,
	"descriptive_name" text,
	"currency_code" text,
	"timezone" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"authentication_mode" text DEFAULT 'environment' NOT NULL,
	"credential_reference" text DEFAULT 'reviv_environment' NOT NULL,
	"last_discovery_synced_at" timestamp,
	"last_facts_synced_at" timestamp,
	"backfill_completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "google_ads_connection_org_store_uniq" UNIQUE("organization_id","shopify_store_id"),
	CONSTRAINT "google_ads_connection_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","id"),
	CONSTRAINT "google_ads_connection_status_check" CHECK ("google_ads_connection"."status" in ('pending', 'ready', 'degraded', 'disabled')),
	CONSTRAINT "google_ads_connection_auth_mode_check" CHECK ("google_ads_connection"."authentication_mode" = 'environment'),
	CONSTRAINT "google_ads_connection_credential_ref_check" CHECK ("google_ads_connection"."credential_reference" = 'reviv_environment')
);
--> statement-breakpoint
CREATE TABLE "google_ads_sync_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"operation" text NOT NULL,
	"window_from_day" date,
	"window_to_day" date,
	"checkpoint_day" date,
	"status" text DEFAULT 'running' NOT NULL,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"rows_upserted" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"api_version" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "google_ads_sync_run_operation_check" CHECK ("google_ads_sync_run"."operation" in ('discovery', 'facts')),
	CONSTRAINT "google_ads_sync_run_status_check" CHECK ("google_ads_sync_run"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "google_ads_sync_run_window_check" CHECK (("google_ads_sync_run"."operation" = 'discovery' and "google_ads_sync_run"."window_from_day" is null and "google_ads_sync_run"."window_to_day" is null)
        or ("google_ads_sync_run"."operation" = 'facts' and "google_ads_sync_run"."window_from_day" is not null and "google_ads_sync_run"."window_to_day" is not null
          and "google_ads_sync_run"."window_from_day" <= "google_ads_sync_run"."window_to_day"))
);
--> statement-breakpoint
ALTER TABLE "gclid_probe_report" ADD CONSTRAINT "gclid_probe_report_connection_id_google_ads_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_ads_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gclid_probe_report" ADD CONSTRAINT "gclid_probe_report_org_store_fk" FOREIGN KEY ("organization_id","shopify_store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_ads_campaign_fact" ADD CONSTRAINT "google_ads_campaign_fact_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."google_ads_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_ads_connection" ADD CONSTRAINT "google_ads_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_ads_connection" ADD CONSTRAINT "google_ads_connection_org_store_fk" FOREIGN KEY ("organization_id","shopify_store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_ads_sync_run" ADD CONSTRAINT "google_ads_sync_run_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."google_ads_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gclid_probe_report_store_idx" ON "gclid_probe_report" USING btree ("shopify_store_id","created_at");--> statement-breakpoint
CREATE INDEX "google_ads_campaign_fact_date_idx" ON "google_ads_campaign_fact" USING btree ("connection_id","fact_date");--> statement-breakpoint
CREATE UNIQUE INDEX "google_ads_connection_active_customer_uidx" ON "google_ads_connection" USING btree ("google_customer_id") WHERE "google_ads_connection"."google_customer_id" is not null and "google_ads_connection"."status" <> 'disabled';--> statement-breakpoint
CREATE INDEX "google_ads_sync_run_connection_idx" ON "google_ads_sync_run" USING btree ("connection_id","started_at");