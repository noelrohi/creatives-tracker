CREATE TABLE "klaviyo_attribution_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"conversion_event_id" text NOT NULL,
	"klaviyo_attribution_id" text NOT NULL,
	"attributed_interaction_event_id" text,
	"attributed_interaction_external_event_id" text,
	"campaign_object_id" text,
	"flow_object_id" text,
	"message_object_id" text,
	"variation_object_id" text,
	"external_variation_reference" text,
	"interaction_type" text,
	"interaction_occurred_at" timestamp,
	"interaction_channel" text,
	"interaction_host" text,
	"interaction_path" text,
	"bot_click" integer,
	"unknown_reason_codes" jsonb NOT NULL,
	"source_checksum" text NOT NULL,
	"api_revision" text NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_attribution_claim_conversion_uniq" UNIQUE("connection_id","conversion_event_id","klaviyo_attribution_id"),
	CONSTRAINT "klaviyo_attribution_claim_interaction_type_check" CHECK ("klaviyo_attribution_claim"."interaction_type" is null
        or "klaviyo_attribution_claim"."interaction_type" in ('click', 'open', 'delivery', 'sms')),
	CONSTRAINT "klaviyo_attribution_claim_bot_check" CHECK ("klaviyo_attribution_claim"."bot_click" is null or "klaviyo_attribution_claim"."bot_click" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_claim_replay_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"match_run_id" text NOT NULL,
	"checkpoint" jsonb,
	"status" text NOT NULL,
	"conversions_complete" integer DEFAULT 0 NOT NULL,
	"conversions_incomplete" integer DEFAULT 0 NOT NULL,
	"conversions_failed" integer DEFAULT 0 NOT NULL,
	"superseded_skipped" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"current_trigger_run_id" text,
	"heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_claim_replay_run_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id"),
	CONSTRAINT "klaviyo_claim_replay_run_status_check" CHECK (("klaviyo_claim_replay_run"."status")::text in ('running', 'success', 'partial', 'failed', 'stale')),
	CONSTRAINT "klaviyo_claim_replay_run_terminal_shape_check" CHECK ((("klaviyo_claim_replay_run"."status")::text = 'running' and "klaviyo_claim_replay_run"."finished_at" is null)
        or (("klaviyo_claim_replay_run"."status")::text <> 'running' and "klaviyo_claim_replay_run"."finished_at" is not null)),
	CONSTRAINT "klaviyo_claim_replay_run_failure_shape_check" CHECK (("klaviyo_claim_replay_run"."status")::text <> 'failed' or "klaviyo_claim_replay_run"."failure_code" is not null),
	CONSTRAINT "klaviyo_claim_replay_run_counts_check" CHECK ("klaviyo_claim_replay_run"."conversions_complete" >= 0
        and "klaviyo_claim_replay_run"."conversions_incomplete" >= 0
        and "klaviyo_claim_replay_run"."conversions_failed" >= 0
        and "klaviyo_claim_replay_run"."superseded_skipped" >= 0)
);
--> statement-breakpoint
CREATE TABLE "klaviyo_claim_replay_state" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"match_run_id" text NOT NULL,
	"conversion_event_id" text NOT NULL,
	"source_checksum" text NOT NULL,
	"status" text NOT NULL,
	"expected_claim_count" integer DEFAULT 0 NOT NULL,
	"resolved_claim_count" integer DEFAULT 0 NOT NULL,
	"referenced_event_fetch_count" integer DEFAULT 0 NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"last_attempt_claim_replay_id" text,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"attempted_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_claim_replay_state_scope_uniq" UNIQUE("connection_id","source_run_id","match_run_id","conversion_event_id"),
	CONSTRAINT "klaviyo_claim_replay_state_status_check" CHECK (("klaviyo_claim_replay_state"."status")::text in ('complete', 'incomplete', 'failed')),
	CONSTRAINT "klaviyo_claim_replay_state_counts_check" CHECK ("klaviyo_claim_replay_state"."expected_claim_count" >= 0
        and "klaviyo_claim_replay_state"."resolved_claim_count" >= 0
        and "klaviyo_claim_replay_state"."referenced_event_fetch_count" >= 0
        and "klaviyo_claim_replay_state"."attempt_count" >= 1),
	CONSTRAINT "klaviyo_claim_replay_state_completion_check" CHECK (("klaviyo_claim_replay_state"."status")::text <> 'complete' or "klaviyo_claim_replay_state"."completed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "klaviyo_marketing_object" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"object_type" text NOT NULL,
	"external_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"channel" text,
	"status" text,
	"provider_created_at" timestamp,
	"provider_updated_at" timestamp,
	"tracking_projection" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_checksum" text NOT NULL,
	"api_revision" text NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_marketing_object_connection_type_external_uniq" UNIQUE("connection_id","object_type","external_id"),
	CONSTRAINT "klaviyo_marketing_object_connection_id_uniq" UNIQUE("connection_id","id"),
	CONSTRAINT "klaviyo_marketing_object_connection_type_id_uniq" UNIQUE("connection_id","object_type","id"),
	CONSTRAINT "klaviyo_marketing_object_type_check" CHECK (("klaviyo_marketing_object"."object_type")::text in ('campaign', 'flow', 'campaign_message',
        'flow_message', 'flow_message_variation'))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_report_fact" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"report_kind" text NOT NULL,
	"conversion_metric_id" text NOT NULL,
	"campaign_object_id" text,
	"flow_object_id" text,
	"message_object_id" text,
	"requested_from" timestamp NOT NULL,
	"requested_to" timestamp NOT NULL,
	"account_timezone" text NOT NULL,
	"grouping" jsonb NOT NULL,
	"request_fingerprint" text NOT NULL,
	"fact_fingerprint" text NOT NULL,
	"conversions" numeric,
	"conversion_value" numeric,
	"recipients" numeric,
	"unique_clicks" numeric,
	"unique_opens" numeric,
	"additional_statistics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"api_revision" text NOT NULL,
	"as_of" timestamp NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_report_fact_generation_fact_uniq" UNIQUE("generation_id","fact_fingerprint"),
	CONSTRAINT "klaviyo_report_fact_kind_check" CHECK (("klaviyo_report_fact"."report_kind")::text in ('campaign', 'flow')),
	CONSTRAINT "klaviyo_report_fact_window_check" CHECK ("klaviyo_report_fact"."requested_from" < "klaviyo_report_fact"."requested_to")
);
--> statement-breakpoint
CREATE TABLE "klaviyo_report_generation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"sync_run_id" text NOT NULL,
	"kind" text NOT NULL,
	"requested_from" timestamp NOT NULL,
	"requested_to" timestamp NOT NULL,
	"account_timezone" text NOT NULL,
	"publication_scope_fingerprint" text NOT NULL,
	"refresh_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"fact_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"published_at" timestamp,
	"superseded_at" timestamp,
	CONSTRAINT "klaviyo_report_generation_run_kind_uniq" UNIQUE("sync_run_id","kind"),
	CONSTRAINT "klaviyo_report_generation_connection_id_uniq" UNIQUE("connection_id","id"),
	CONSTRAINT "klaviyo_report_generation_connection_kind_id_uniq" UNIQUE("connection_id","kind","id"),
	CONSTRAINT "klaviyo_report_generation_kind_check" CHECK (("klaviyo_report_generation"."kind")::text in ('campaign', 'flow')),
	CONSTRAINT "klaviyo_report_generation_status_check" CHECK (("klaviyo_report_generation"."status")::text in ('staging', 'current', 'failed', 'superseded')),
	CONSTRAINT "klaviyo_report_generation_status_shape_check" CHECK ((("klaviyo_report_generation"."status")::text = 'staging'
          and "klaviyo_report_generation"."published_at" is null and "klaviyo_report_generation"."superseded_at" is null)
        or (("klaviyo_report_generation"."status")::text = 'failed' and "klaviyo_report_generation"."superseded_at" is null)
        or (("klaviyo_report_generation"."status")::text = 'current'
          and "klaviyo_report_generation"."published_at" is not null and "klaviyo_report_generation"."superseded_at" is null)
        or (("klaviyo_report_generation"."status")::text = 'superseded'
          and "klaviyo_report_generation"."published_at" is not null and "klaviyo_report_generation"."superseded_at" is not null)),
	CONSTRAINT "klaviyo_report_generation_window_check" CHECK ("klaviyo_report_generation"."requested_from" < "klaviyo_report_generation"."requested_to"),
	CONSTRAINT "klaviyo_report_generation_fact_count_check" CHECK ("klaviyo_report_generation"."fact_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "klaviyo_tracking_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"scope" text NOT NULL,
	"marketing_object_id" text,
	"marketing_object_type" text,
	"parameter_name" text NOT NULL,
	"value_mode" text NOT NULL,
	"sanitized_value" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"api_revision" text NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_tracking_setting_scope_check" CHECK (("klaviyo_tracking_setting"."scope")::text in ('account', 'campaign_message', 'flow_message')),
	CONSTRAINT "klaviyo_tracking_setting_value_mode_check" CHECK (("klaviyo_tracking_setting"."value_mode")::text in ('static', 'dynamic')),
	CONSTRAINT "klaviyo_tracking_setting_enabled_check" CHECK ("klaviyo_tracking_setting"."enabled" in (0, 1)),
	CONSTRAINT "klaviyo_tracking_setting_object_shape_check" CHECK ((("klaviyo_tracking_setting"."scope")::text = 'account'
          and "klaviyo_tracking_setting"."marketing_object_id" is null
          and "klaviyo_tracking_setting"."marketing_object_type" is null)
        or (("klaviyo_tracking_setting"."scope")::text = 'campaign_message'
          and "klaviyo_tracking_setting"."marketing_object_id" is not null
          and ("klaviyo_tracking_setting"."marketing_object_type")::text = 'campaign_message')
        or (("klaviyo_tracking_setting"."scope")::text = 'flow_message'
          and "klaviyo_tracking_setting"."marketing_object_id" is not null
          and ("klaviyo_tracking_setting"."marketing_object_type")::text = 'flow_message'))
);
--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD COLUMN "last_report_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "klaviyo_attribution_claim" ADD CONSTRAINT "klaviyo_attribution_claim_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_attribution_claim" ADD CONSTRAINT "klaviyo_attribution_claim_conversion_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","conversion_event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_attribution_claim" ADD CONSTRAINT "klaviyo_attribution_claim_interaction_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","attributed_interaction_event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_attribution_claim" ADD CONSTRAINT "klaviyo_attribution_claim_campaign_fk" FOREIGN KEY ("connection_id","campaign_object_id") REFERENCES "public"."klaviyo_marketing_object"("connection_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_attribution_claim" ADD CONSTRAINT "klaviyo_attribution_claim_flow_fk" FOREIGN KEY ("connection_id","flow_object_id") REFERENCES "public"."klaviyo_marketing_object"("connection_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_attribution_claim" ADD CONSTRAINT "klaviyo_attribution_claim_message_fk" FOREIGN KEY ("connection_id","message_object_id") REFERENCES "public"."klaviyo_marketing_object"("connection_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_attribution_claim" ADD CONSTRAINT "klaviyo_attribution_claim_variation_fk" FOREIGN KEY ("connection_id","variation_object_id") REFERENCES "public"."klaviyo_marketing_object"("connection_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_claim_replay_run" ADD CONSTRAINT "klaviyo_claim_replay_run_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_claim_replay_run" ADD CONSTRAINT "klaviyo_claim_replay_run_source_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","source_run_id") REFERENCES "public"."klaviyo_sync_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_claim_replay_run" ADD CONSTRAINT "klaviyo_claim_replay_run_match_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","match_run_id") REFERENCES "public"."klaviyo_match_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_claim_replay_state" ADD CONSTRAINT "klaviyo_claim_replay_state_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_claim_replay_state" ADD CONSTRAINT "klaviyo_claim_replay_state_source_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","source_run_id") REFERENCES "public"."klaviyo_sync_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_claim_replay_state" ADD CONSTRAINT "klaviyo_claim_replay_state_match_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","match_run_id") REFERENCES "public"."klaviyo_match_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_claim_replay_state" ADD CONSTRAINT "klaviyo_claim_replay_state_conversion_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","conversion_event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_claim_replay_state" ADD CONSTRAINT "klaviyo_claim_replay_state_result_anchor_fk" FOREIGN KEY ("match_run_id","conversion_event_id") REFERENCES "public"."klaviyo_event_match_result"("run_id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_marketing_object" ADD CONSTRAINT "klaviyo_marketing_object_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_marketing_object" ADD CONSTRAINT "klaviyo_marketing_object_parent_fk" FOREIGN KEY ("connection_id","parent_id") REFERENCES "public"."klaviyo_marketing_object"("connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD CONSTRAINT "klaviyo_report_fact_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD CONSTRAINT "klaviyo_report_fact_generation_fk" FOREIGN KEY ("connection_id","report_kind","generation_id") REFERENCES "public"."klaviyo_report_generation"("connection_id","kind","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD CONSTRAINT "klaviyo_report_fact_metric_fk" FOREIGN KEY ("connection_id","conversion_metric_id") REFERENCES "public"."klaviyo_metric"("connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD CONSTRAINT "klaviyo_report_fact_campaign_fk" FOREIGN KEY ("connection_id","campaign_object_id") REFERENCES "public"."klaviyo_marketing_object"("connection_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD CONSTRAINT "klaviyo_report_fact_flow_fk" FOREIGN KEY ("connection_id","flow_object_id") REFERENCES "public"."klaviyo_marketing_object"("connection_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_report_fact" ADD CONSTRAINT "klaviyo_report_fact_message_fk" FOREIGN KEY ("connection_id","message_object_id") REFERENCES "public"."klaviyo_marketing_object"("connection_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_report_generation" ADD CONSTRAINT "klaviyo_report_generation_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_report_generation" ADD CONSTRAINT "klaviyo_report_generation_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","sync_run_id") REFERENCES "public"."klaviyo_sync_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_tracking_setting" ADD CONSTRAINT "klaviyo_tracking_setting_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_tracking_setting" ADD CONSTRAINT "klaviyo_tracking_setting_object_fk" FOREIGN KEY ("connection_id","marketing_object_type","marketing_object_id") REFERENCES "public"."klaviyo_marketing_object"("connection_id","object_type","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "klaviyo_attribution_claim_conversion_idx" ON "klaviyo_attribution_claim" USING btree ("connection_id","conversion_event_id");--> statement-breakpoint
CREATE INDEX "klaviyo_attribution_claim_campaign_idx" ON "klaviyo_attribution_claim" USING btree ("connection_id","campaign_object_id");--> statement-breakpoint
CREATE INDEX "klaviyo_attribution_claim_flow_idx" ON "klaviyo_attribution_claim" USING btree ("connection_id","flow_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_claim_replay_run_one_running_uidx" ON "klaviyo_claim_replay_run" USING btree ("connection_id") WHERE "klaviyo_claim_replay_run"."status" = 'running';--> statement-breakpoint
CREATE INDEX "klaviyo_claim_replay_run_scope_started_idx" ON "klaviyo_claim_replay_run" USING btree ("organization_id","shopify_store_id","connection_id","started_at");--> statement-breakpoint
CREATE INDEX "klaviyo_claim_replay_state_match_run_idx" ON "klaviyo_claim_replay_state" USING btree ("connection_id","match_run_id","status");--> statement-breakpoint
CREATE INDEX "klaviyo_marketing_object_scope_type_idx" ON "klaviyo_marketing_object" USING btree ("organization_id","shopify_store_id","connection_id","object_type");--> statement-breakpoint
CREATE INDEX "klaviyo_report_fact_range_idx" ON "klaviyo_report_fact" USING btree ("connection_id","report_kind","requested_from","requested_to");--> statement-breakpoint
CREATE INDEX "klaviyo_report_fact_request_idx" ON "klaviyo_report_fact" USING btree ("connection_id","request_fingerprint");--> statement-breakpoint
CREATE INDEX "klaviyo_report_fact_campaign_idx" ON "klaviyo_report_fact" USING btree ("connection_id","campaign_object_id");--> statement-breakpoint
CREATE INDEX "klaviyo_report_fact_flow_idx" ON "klaviyo_report_fact" USING btree ("connection_id","flow_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_report_generation_current_uidx" ON "klaviyo_report_generation" USING btree ("connection_id","publication_scope_fingerprint") WHERE "klaviyo_report_generation"."status" = 'current';--> statement-breakpoint
CREATE INDEX "klaviyo_report_generation_slot_idx" ON "klaviyo_report_generation" USING btree ("connection_id","publication_scope_fingerprint","status");--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_tracking_setting_scope_param_uidx" ON "klaviyo_tracking_setting" USING btree ("connection_id","scope",coalesce("marketing_object_id", ''),"parameter_name");--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_sync_run_one_running_dimension_report_uidx" ON "klaviyo_sync_run" USING btree ("connection_id","operation") WHERE "klaviyo_sync_run"."operation" in ('dimensions', 'reports') and "klaviyo_sync_run"."status" = 'running';