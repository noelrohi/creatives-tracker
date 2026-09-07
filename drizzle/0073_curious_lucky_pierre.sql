CREATE TABLE "klaviyo_snapshot_content" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"resource_kind" text NOT NULL,
	"content_digest" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_snapshot_content_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id","resource_kind"),
	CONSTRAINT "klaviyo_snapshot_content_identity_uniq" UNIQUE("connection_id","resource_kind","content_digest"),
	CONSTRAINT "klaviyo_snapshot_content_payload_check" CHECK (
      "klaviyo_snapshot_content"."content_digest" ~ '^[0-9a-f]{64}$' and jsonb_typeof("klaviyo_snapshot_content"."content") = 'object'),
	CONSTRAINT "klaviyo_snapshot_content_kind_check" CHECK ("klaviyo_snapshot_content"."resource_kind" in (
        'campaign', 'campaign_message', 'metric', 'event', 'campaign_value_row'
      ))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_snapshot_definition" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"dataset" text NOT NULL,
	"daily_enabled" integer DEFAULT 0 NOT NULL,
	"configuration_version" integer DEFAULT 1 NOT NULL,
	"window_mode" text DEFAULT 'rolling_days' NOT NULL,
	"rolling_days" integer,
	"fixed_from" timestamp,
	"fixed_to" timestamp,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"selected_metric_ids" jsonb,
	"conversion_metric_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_snapshot_definition_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id","dataset"),
	CONSTRAINT "klaviyo_snapshot_definition_dataset_uniq" UNIQUE("connection_id","dataset"),
	CONSTRAINT "klaviyo_snapshot_definition_dataset_check" CHECK ("klaviyo_snapshot_definition"."dataset" in ('campaigns', 'metrics', 'events', 'campaign_values')),
	CONSTRAINT "klaviyo_snapshot_definition_daily_check" CHECK ("klaviyo_snapshot_definition"."daily_enabled" in (0, 1)),
	CONSTRAINT "klaviyo_snapshot_definition_window_mode_check" CHECK ("klaviyo_snapshot_definition"."window_mode" in ('rolling_days', 'fixed')),
	CONSTRAINT "klaviyo_snapshot_definition_rolling_days_check" CHECK (("klaviyo_snapshot_definition"."window_mode" <> 'rolling_days')
        or ("klaviyo_snapshot_definition"."rolling_days" is not null and "klaviyo_snapshot_definition"."rolling_days" between 1 and 365
          and "klaviyo_snapshot_definition"."fixed_from" is null and "klaviyo_snapshot_definition"."fixed_to" is null)),
	CONSTRAINT "klaviyo_snapshot_definition_fixed_pair_check" CHECK (("klaviyo_snapshot_definition"."window_mode" <> 'fixed')
        or ("klaviyo_snapshot_definition"."fixed_from" is not null and "klaviyo_snapshot_definition"."fixed_to" is not null
          and "klaviyo_snapshot_definition"."fixed_from" < "klaviyo_snapshot_definition"."fixed_to" and "klaviyo_snapshot_definition"."rolling_days" is null)),
	CONSTRAINT "klaviyo_snapshot_definition_config_check" CHECK (
      "klaviyo_snapshot_definition"."configuration_version" > 0 and
      (("klaviyo_snapshot_definition"."dataset" = 'events' and "klaviyo_snapshot_definition"."selected_metric_ids" is not null
         and jsonb_typeof("klaviyo_snapshot_definition"."selected_metric_ids") = 'array'
         and jsonb_array_length("klaviyo_snapshot_definition"."selected_metric_ids") between 1 and 20
         and "klaviyo_snapshot_definition"."conversion_metric_id" is null)
       or ("klaviyo_snapshot_definition"."dataset" = 'campaign_values' and "klaviyo_snapshot_definition"."conversion_metric_id" is not null
         and "klaviyo_snapshot_definition"."selected_metric_ids" is null)
       or ("klaviyo_snapshot_definition"."dataset" in ('campaigns', 'metrics') and "klaviyo_snapshot_definition"."selected_metric_ids" is null
         and "klaviyo_snapshot_definition"."conversion_metric_id" is null)))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_snapshot_profile_suppression" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"key_version" text NOT NULL,
	"digest" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_snapshot_profile_suppression_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id"),
	CONSTRAINT "klaviyo_snapshot_profile_suppression_identity_uniq" UNIQUE("connection_id","profile_id","key_version","digest"),
	CONSTRAINT "klaviyo_snapshot_profile_suppression_digest_check" CHECK (
      "klaviyo_snapshot_profile_suppression"."digest" ~ '^[A-Za-z0-9_-]{43}$' and "klaviyo_snapshot_profile_suppression"."key_version" ~ '^[A-Za-z0-9._-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "klaviyo_snapshot_record" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"snapshot_run_id" text NOT NULL,
	"content_id" text NOT NULL,
	"resource_kind" text NOT NULL,
	"provider_identity" text NOT NULL,
	"ordering_key" text NOT NULL,
	"profile_id" text,
	"metric_id" text,
	"event_datetime" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_snapshot_record_identity_uniq" UNIQUE("snapshot_run_id","resource_kind","provider_identity"),
	CONSTRAINT "klaviyo_snapshot_record_ordering_uniq" UNIQUE("snapshot_run_id","resource_kind","ordering_key"),
	CONSTRAINT "klaviyo_snapshot_record_kind_check" CHECK ("klaviyo_snapshot_record"."resource_kind" in (
        'campaign', 'campaign_message', 'metric', 'event', 'campaign_value_row'
      )),
	CONSTRAINT "klaviyo_snapshot_record_event_check" CHECK (
      ("klaviyo_snapshot_record"."resource_kind" = 'event' and "klaviyo_snapshot_record"."metric_id" is not null and "klaviyo_snapshot_record"."event_datetime" is not null)
      or ("klaviyo_snapshot_record"."resource_kind" <> 'event' and "klaviyo_snapshot_record"."profile_id" is null
        and "klaviyo_snapshot_record"."metric_id" is null and "klaviyo_snapshot_record"."event_datetime" is null))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_snapshot_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"definition_id" text,
	"dataset" text NOT NULL,
	"scope_fingerprint" text NOT NULL,
	"resolved_scope" jsonb NOT NULL,
	"configuration_version" integer NOT NULL,
	"trigger_type" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"is_current" integer DEFAULT 0 NOT NULL,
	"lease_token" text NOT NULL,
	"heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"checkpoint" jsonb,
	"api_revision" text NOT NULL,
	"schema_revision" integer DEFAULT 1 NOT NULL,
	"account_id" text NOT NULL,
	"lease_owner" text,
	"requested_from" timestamp,
	"requested_to" timestamp,
	"provider_window_start" text,
	"provider_window_end" text,
	"timezone" text,
	"anchor_at" timestamp,
	"page_count" integer DEFAULT 0 NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"bytes_staged" integer DEFAULT 0 NOT NULL,
	"suppressed_count" integer DEFAULT 0 NOT NULL,
	"provider_completeness" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"privacy_adjusted" integer DEFAULT 0 NOT NULL,
	"privacy_adjusted_at" timestamp,
	"privacy_removed_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"published_at" timestamp,
	CONSTRAINT "klaviyo_snapshot_run_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id"),
	CONSTRAINT "klaviyo_snapshot_run_scope_fingerprint_uniq" UNIQUE("connection_id","dataset","scope_fingerprint","id"),
	CONSTRAINT "klaviyo_snapshot_run_dataset_check" CHECK ("klaviyo_snapshot_run"."dataset" in ('campaigns', 'metrics', 'events', 'campaign_values')),
	CONSTRAINT "klaviyo_snapshot_run_trigger_type_check" CHECK ("klaviyo_snapshot_run"."trigger_type" in ('daily', 'manual')),
	CONSTRAINT "klaviyo_snapshot_run_state_check" CHECK ("klaviyo_snapshot_run"."state" in ('running', 'published', 'failed')),
	CONSTRAINT "klaviyo_snapshot_run_current_check" CHECK ("klaviyo_snapshot_run"."is_current" in (0, 1) and ("klaviyo_snapshot_run"."is_current" = 0 or "klaviyo_snapshot_run"."state" = 'published')),
	CONSTRAINT "klaviyo_snapshot_run_published_checkpoint_check" CHECK (("klaviyo_snapshot_run"."state" <> 'published' or "klaviyo_snapshot_run"."checkpoint" is null)
        and ("klaviyo_snapshot_run"."state" <> 'running' or ("klaviyo_snapshot_run"."checkpoint" is not null
          and coalesce("klaviyo_snapshot_run"."checkpoint"->>'dataset' = "klaviyo_snapshot_run"."dataset", false)))),
	CONSTRAINT "klaviyo_snapshot_run_privacy_check" CHECK ("klaviyo_snapshot_run"."privacy_adjusted" in (0, 1) and ("klaviyo_snapshot_run"."privacy_removed_count" >= 0)),
	CONSTRAINT "klaviyo_snapshot_run_provider_completeness_check" CHECK ("klaviyo_snapshot_run"."provider_completeness" is null
        or "klaviyo_snapshot_run"."provider_completeness" in ('complete', 'unverified')),
	CONSTRAINT "klaviyo_snapshot_run_counts_check" CHECK ("klaviyo_snapshot_run"."page_count" >= 0 and "klaviyo_snapshot_run"."record_count" >= 0
        and "klaviyo_snapshot_run"."bytes_staged" >= 0 and "klaviyo_snapshot_run"."suppressed_count" >= 0),
	CONSTRAINT "klaviyo_snapshot_run_publish_state_check" CHECK (("klaviyo_snapshot_run"."state" <> 'published')
        or ("klaviyo_snapshot_run"."published_at" is not null and "klaviyo_snapshot_run"."finished_at" is not null)),
	CONSTRAINT "klaviyo_snapshot_run_scope_shape_check" CHECK ("klaviyo_snapshot_run"."configuration_version" >= 0 and "klaviyo_snapshot_run"."schema_revision" = 1 and
        coalesce("klaviyo_snapshot_run"."resolved_scope"->>'dataset' = "klaviyo_snapshot_run"."dataset", false) and
        (("klaviyo_snapshot_run"."dataset" in ('campaigns','metrics') and "klaviyo_snapshot_run"."requested_from" is null
          and "klaviyo_snapshot_run"."requested_to" is null)
         or ("klaviyo_snapshot_run"."dataset" in ('events','campaign_values') and "klaviyo_snapshot_run"."requested_from" is not null
          and "klaviyo_snapshot_run"."requested_to" is not null and "klaviyo_snapshot_run"."requested_from" < "klaviyo_snapshot_run"."requested_to"
          and "klaviyo_snapshot_run"."anchor_at" is not null)))
);
--> statement-breakpoint
ALTER TABLE "klaviyo_snapshot_content" ADD CONSTRAINT "klaviyo_snapshot_content_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_snapshot_definition" ADD CONSTRAINT "klaviyo_snapshot_definition_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_snapshot_profile_suppression" ADD CONSTRAINT "klaviyo_snapshot_profile_suppression_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_snapshot_record" ADD CONSTRAINT "klaviyo_snapshot_record_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_snapshot_record" ADD CONSTRAINT "klaviyo_snapshot_record_run_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","snapshot_run_id") REFERENCES "public"."klaviyo_snapshot_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_snapshot_record" ADD CONSTRAINT "klaviyo_snapshot_record_content_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","content_id","resource_kind") REFERENCES "public"."klaviyo_snapshot_content"("organization_id","shopify_store_id","connection_id","id","resource_kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_snapshot_run" ADD CONSTRAINT "klaviyo_snapshot_run_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_snapshot_run" ADD CONSTRAINT "klaviyo_snapshot_run_definition_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","definition_id","dataset") REFERENCES "public"."klaviyo_snapshot_definition"("organization_id","shopify_store_id","connection_id","id","dataset") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "klaviyo_snapshot_profile_suppression_digest_idx" ON "klaviyo_snapshot_profile_suppression" USING btree ("organization_id","shopify_store_id","key_version","digest");--> statement-breakpoint
CREATE INDEX "klaviyo_snapshot_profile_suppression_profile_idx" ON "klaviyo_snapshot_profile_suppression" USING btree ("organization_id","shopify_store_id","connection_id","profile_id");--> statement-breakpoint
CREATE INDEX "klaviyo_snapshot_record_content_idx" ON "klaviyo_snapshot_record" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "klaviyo_snapshot_record_profile_idx" ON "klaviyo_snapshot_record" USING btree ("organization_id","shopify_store_id","connection_id","profile_id");--> statement-breakpoint
CREATE INDEX "klaviyo_snapshot_record_metric_time_idx" ON "klaviyo_snapshot_record" USING btree ("organization_id","shopify_store_id","connection_id","metric_id","event_datetime");--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_snapshot_run_one_running_uidx" ON "klaviyo_snapshot_run" USING btree ("connection_id","dataset","scope_fingerprint") WHERE "klaviyo_snapshot_run"."state" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_snapshot_run_one_current_uidx" ON "klaviyo_snapshot_run" USING btree ("connection_id","dataset","scope_fingerprint") WHERE "klaviyo_snapshot_run"."state" = 'published' and "klaviyo_snapshot_run"."is_current" = 1;--> statement-breakpoint
CREATE INDEX "klaviyo_snapshot_run_scope_history_idx" ON "klaviyo_snapshot_run" USING btree ("connection_id","dataset","scope_fingerprint","state","published_at");--> statement-breakpoint
CREATE INDEX "klaviyo_snapshot_run_connection_state_idx" ON "klaviyo_snapshot_run" USING btree ("organization_id","shopify_store_id","connection_id","dataset","state","started_at");