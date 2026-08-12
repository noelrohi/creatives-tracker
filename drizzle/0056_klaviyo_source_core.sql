CREATE TABLE "klaviyo_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"klaviyo_account_id" text,
	"account_name" text,
	"timezone" text,
	"currency" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"authentication_mode" text DEFAULT 'environment' NOT NULL,
	"credential_reference" text DEFAULT 'reviv_environment' NOT NULL,
	"last_discovery_synced_at" timestamp,
	"last_event_synced_at" timestamp,
	"initial_source_from" timestamp,
	"initial_source_to" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_connection_org_store_uniq" UNIQUE("organization_id","shopify_store_id"),
	CONSTRAINT "klaviyo_connection_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","id"),
	CONSTRAINT "klaviyo_connection_status_check" CHECK ("klaviyo_connection"."status" in ('pending', 'ready', 'degraded', 'disabled')),
	CONSTRAINT "klaviyo_connection_auth_mode_check" CHECK ("klaviyo_connection"."authentication_mode" = 'environment'),
	CONSTRAINT "klaviyo_connection_credential_ref_check" CHECK ("klaviyo_connection"."credential_reference" = 'reviv_environment'),
	CONSTRAINT "klaviyo_connection_initial_source_window_check" CHECK (("klaviyo_connection"."initial_source_from" is null and "klaviyo_connection"."initial_source_to" is null)
        or ("klaviyo_connection"."initial_source_from" is not null and "klaviyo_connection"."initial_source_to" is not null
          and "klaviyo_connection"."initial_source_from" < "klaviyo_connection"."initial_source_to"))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_event_alias" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"probe_report_id" text NOT NULL,
	"canonical_field" text NOT NULL,
	"source_property" text NOT NULL,
	"state" text DEFAULT 'candidate' NOT NULL,
	"observed_populated" integer NOT NULL,
	"observed_malformed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_event_alias_report_metric_field_uniq" UNIQUE("probe_report_id","metric_id","canonical_field"),
	CONSTRAINT "klaviyo_event_alias_report_metric_source_uniq" UNIQUE("probe_report_id","metric_id","source_property"),
	CONSTRAINT "klaviyo_event_alias_field_check" CHECK ("klaviyo_event_alias"."canonical_field" in ('orderId', 'uniqueEventId', 'productId',
        'variantId', 'sku', 'productName', 'variantName', 'quantity', 'value',
        'currency', 'items')),
	CONSTRAINT "klaviyo_event_alias_state_check" CHECK ("klaviyo_event_alias"."state" in ('candidate', 'approved', 'rejected', 'disabled')),
	CONSTRAINT "klaviyo_event_alias_counts_check" CHECK ("klaviyo_event_alias"."observed_populated" > 0 and "klaviyo_event_alias"."observed_malformed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "klaviyo_event_product" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"event_id" text NOT NULL,
	"source_ordinal" integer NOT NULL,
	"product_id" text,
	"variant_id" text,
	"sku" text,
	"product_name" text,
	"variant_name" text,
	"quantity" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_event_product_ordinal_uniq" UNIQUE("event_id","source_ordinal"),
	CONSTRAINT "klaviyo_event_product_quantity_check" CHECK ("klaviyo_event_product"."quantity" is null or "klaviyo_event_product"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "klaviyo_event_run_observation" (
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"sync_run_id" text NOT NULL,
	"event_id" text NOT NULL,
	"observed_source_checksum" text NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_event_run_observation_membership_uniq" UNIQUE("connection_id","sync_run_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "klaviyo_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_uuid" text,
	"occurred_at" timestamp NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"profile_id" text,
	"explicit_order_id_candidate" text,
	"provider_unique_id_candidate" text,
	"provider_value" numeric,
	"provider_currency" text,
	"attribution_relationship_ids" jsonb NOT NULL,
	"redacted_properties" jsonb NOT NULL,
	"key_type_fingerprint" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"product_evidence_completeness" text NOT NULL,
	"source_checksum" text NOT NULL,
	"api_revision" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_event_connection_external_uniq" UNIQUE("connection_id","external_event_id"),
	CONSTRAINT "klaviyo_event_connection_id_uniq" UNIQUE("connection_id","id"),
	CONSTRAINT "klaviyo_event_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id"),
	CONSTRAINT "klaviyo_event_product_completeness_check" CHECK ("klaviyo_event"."product_evidence_completeness" in ('complete', 'incomplete', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_join_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"probe_report_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"source_property" text NOT NULL,
	"target_namespace" text NOT NULL,
	"canonicalizer" text NOT NULL,
	"state" text DEFAULT 'candidate' NOT NULL,
	"observed_populated" integer NOT NULL,
	"observed_collisions" integer NOT NULL,
	"approver_id" text,
	"review_note" text,
	"approved_at" timestamp,
	"matcher_version" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_join_rule_report_source_uniq" UNIQUE("probe_report_id","event_kind","source_property","target_namespace"),
	CONSTRAINT "klaviyo_join_rule_state_check" CHECK ("klaviyo_join_rule"."state" in ('candidate', 'approved', 'rejected', 'disabled')),
	CONSTRAINT "klaviyo_join_rule_canonicalizer_check" CHECK ("klaviyo_join_rule"."canonicalizer" in ('shopify_order_gid', 'trimmed_exact'))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_metric" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"external_metric_id" text NOT NULL,
	"name" text NOT NULL,
	"integration_name" text,
	"integration_category" text,
	"canonical_kind" text,
	"ingestion_enabled" integer DEFAULT 0 NOT NULL,
	"api_revision" text NOT NULL,
	"discovered_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_metric_connection_external_uniq" UNIQUE("connection_id","external_metric_id"),
	CONSTRAINT "klaviyo_metric_connection_id_uniq" UNIQUE("connection_id","id")
);
--> statement-breakpoint
CREATE TABLE "klaviyo_probe_report" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"sync_run_id" text NOT NULL,
	"sampled_from" timestamp NOT NULL,
	"sampled_to" timestamp NOT NULL,
	"sampled_shopify_orders" integer NOT NULL,
	"sampled_klaviyo_events" integer NOT NULL,
	"binding_overlap_count" integer NOT NULL,
	"key_type_shapes" jsonb NOT NULL,
	"identifier_coverage" jsonb NOT NULL,
	"collision_summary" jsonb NOT NULL,
	"unmatched_summary" jsonb NOT NULL,
	"unmatched_examples" jsonb NOT NULL,
	"product_coverage" jsonb NOT NULL,
	"attribution_coverage" jsonb NOT NULL,
	"redaction_verified" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_id" text,
	"review_note" text,
	"reviewed_at" timestamp,
	"checksum" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_probe_report_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id"),
	CONSTRAINT "klaviyo_probe_report_status_check" CHECK ("klaviyo_probe_report"."status" in ('pending', 'passed', 'failed')),
	CONSTRAINT "klaviyo_probe_report_sample_size_check" CHECK ("klaviyo_probe_report"."sampled_shopify_orders" between 20 and 50),
	CONSTRAINT "klaviyo_probe_report_overlap_check" CHECK ("klaviyo_probe_report"."binding_overlap_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "klaviyo_sync_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"operation" text NOT NULL,
	"trigger_type" text NOT NULL,
	"request_parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_from" timestamp,
	"requested_to" timestamp,
	"checkpoint" jsonb,
	"api_revision" text,
	"status" text DEFAULT 'running' NOT NULL,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"rows_inserted" integer DEFAULT 0 NOT NULL,
	"rows_updated" integer DEFAULT 0 NOT NULL,
	"rows_ignored" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "klaviyo_sync_run_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id"),
	CONSTRAINT "klaviyo_sync_run_operation_check" CHECK ("klaviyo_sync_run"."operation" in ('discovery', 'probe', 'dimensions', 'events', 'reports')),
	CONSTRAINT "klaviyo_sync_run_status_check" CHECK ("klaviyo_sync_run"."status" in ('running', 'success', 'partial', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD CONSTRAINT "klaviyo_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD CONSTRAINT "klaviyo_connection_org_store_fk" FOREIGN KEY ("organization_id","shopify_store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_alias" ADD CONSTRAINT "klaviyo_event_alias_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_alias" ADD CONSTRAINT "klaviyo_event_alias_metric_fk" FOREIGN KEY ("connection_id","metric_id") REFERENCES "public"."klaviyo_metric"("connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_alias" ADD CONSTRAINT "klaviyo_event_alias_report_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","probe_report_id") REFERENCES "public"."klaviyo_probe_report"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_product" ADD CONSTRAINT "klaviyo_event_product_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_product" ADD CONSTRAINT "klaviyo_event_product_event_fk" FOREIGN KEY ("connection_id","event_id") REFERENCES "public"."klaviyo_event"("connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_run_observation" ADD CONSTRAINT "klaviyo_event_run_observation_run_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","sync_run_id") REFERENCES "public"."klaviyo_sync_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_run_observation" ADD CONSTRAINT "klaviyo_event_run_observation_event_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event" ADD CONSTRAINT "klaviyo_event_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event" ADD CONSTRAINT "klaviyo_event_metric_fk" FOREIGN KEY ("connection_id","metric_id") REFERENCES "public"."klaviyo_metric"("connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_join_rule" ADD CONSTRAINT "klaviyo_join_rule_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_join_rule" ADD CONSTRAINT "klaviyo_join_rule_report_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","probe_report_id") REFERENCES "public"."klaviyo_probe_report"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_metric" ADD CONSTRAINT "klaviyo_metric_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_probe_report" ADD CONSTRAINT "klaviyo_probe_report_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_probe_report" ADD CONSTRAINT "klaviyo_probe_report_run_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","sync_run_id") REFERENCES "public"."klaviyo_sync_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_sync_run" ADD CONSTRAINT "klaviyo_sync_run_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_connection_active_account_uidx" ON "klaviyo_connection" USING btree ("klaviyo_account_id") WHERE "klaviyo_connection"."klaviyo_account_id" is not null and "klaviyo_connection"."status" <> 'disabled';--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_event_alias_approved_metric_field_uniq" ON "klaviyo_event_alias" USING btree ("connection_id","metric_id","canonical_field") WHERE "klaviyo_event_alias"."state" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_event_alias_approved_metric_source_uniq" ON "klaviyo_event_alias" USING btree ("connection_id","metric_id","source_property") WHERE "klaviyo_event_alias"."state" = 'approved';--> statement-breakpoint
CREATE INDEX "klaviyo_event_product_variant_idx" ON "klaviyo_event_product" USING btree ("organization_id","shopify_store_id","variant_id");--> statement-breakpoint
CREATE INDEX "klaviyo_event_product_product_idx" ON "klaviyo_event_product" USING btree ("organization_id","shopify_store_id","product_id");--> statement-breakpoint
CREATE INDEX "klaviyo_event_product_sku_idx" ON "klaviyo_event_product" USING btree ("organization_id","shopify_store_id","sku");--> statement-breakpoint
CREATE INDEX "klaviyo_event_run_observation_exact_run_idx" ON "klaviyo_event_run_observation" USING btree ("connection_id","sync_run_id","event_id");--> statement-breakpoint
CREATE INDEX "klaviyo_event_scope_metric_time_idx" ON "klaviyo_event" USING btree ("organization_id","shopify_store_id","connection_id","metric_id","occurred_at");--> statement-breakpoint
CREATE INDEX "klaviyo_event_scope_profile_time_idx" ON "klaviyo_event" USING btree ("organization_id","shopify_store_id","connection_id","profile_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_join_rule_approved_source_uidx" ON "klaviyo_join_rule" USING btree ("connection_id","event_kind","source_property","target_namespace") WHERE "klaviyo_join_rule"."state" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_metric_enabled_kind_uidx" ON "klaviyo_metric" USING btree ("connection_id","canonical_kind") WHERE "klaviyo_metric"."canonical_kind" is not null and "klaviyo_metric"."ingestion_enabled" = 1;--> statement-breakpoint
CREATE INDEX "klaviyo_metric_scope_kind_idx" ON "klaviyo_metric" USING btree ("organization_id","shopify_store_id","connection_id","canonical_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_sync_run_one_running_discovery_uidx" ON "klaviyo_sync_run" USING btree ("connection_id") WHERE "klaviyo_sync_run"."operation" = 'discovery' and "klaviyo_sync_run"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_sync_run_one_running_probe_uidx" ON "klaviyo_sync_run" USING btree ("connection_id") WHERE "klaviyo_sync_run"."operation" = 'probe' and "klaviyo_sync_run"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_sync_run_one_running_events_uidx" ON "klaviyo_sync_run" USING btree ("connection_id") WHERE "klaviyo_sync_run"."operation" = 'events' and "klaviyo_sync_run"."status" = 'running';--> statement-breakpoint
CREATE INDEX "klaviyo_sync_run_scope_started_idx" ON "klaviyo_sync_run" USING btree ("organization_id","shopify_store_id","connection_id","started_at");