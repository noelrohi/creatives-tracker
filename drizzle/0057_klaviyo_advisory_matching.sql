ALTER TYPE "public"."identity_erasure_suppression_kind" ADD VALUE 'klaviyo_profile_id';--> statement-breakpoint
ALTER TYPE "public"."source_identity_kind" ADD VALUE 'klaviyo_event';--> statement-breakpoint
CREATE TABLE "identity_pilot_uninstall_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"former_connection_id" text NOT NULL,
	"prior_mode" text NOT NULL,
	"resulting_current_key_version" text NOT NULL,
	"resulting_current_key_check" text NOT NULL,
	"cleared_shopify_identity_rows" integer DEFAULT 0 NOT NULL,
	"cleared_klaviyo_identity_rows" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"completed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "identity_pilot_uninstall_receipt_scope_id_uniq" UNIQUE("organization_id","store_id","id"),
	CONSTRAINT "identity_pilot_uninstall_receipt_current_uniq" UNIQUE("organization_id","store_id","id","resulting_current_key_version"),
	CONSTRAINT "identity_pilot_uninstall_receipt_status_check" CHECK ("identity_pilot_uninstall_receipt"."status" = 'complete'),
	CONSTRAINT "identity_pilot_uninstall_receipt_mode_check" CHECK ("identity_pilot_uninstall_receipt"."prior_mode" in ('current_only', 'dual')),
	CONSTRAINT "identity_pilot_uninstall_receipt_counts_check" CHECK ("identity_pilot_uninstall_receipt"."cleared_shopify_identity_rows" >= 0
        and "identity_pilot_uninstall_receipt"."cleared_klaviyo_identity_rows" >= 0)
);
--> statement-breakpoint
CREATE TABLE "identity_pilot_uninstall_retired_key" (
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"resulting_current_key_version" text NOT NULL,
	"retired_key_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "identity_pilot_uninstall_retired_key_uniq" UNIQUE("organization_id","store_id","receipt_id","retired_key_version"),
	CONSTRAINT "identity_pilot_uninstall_retired_key_not_current_check" CHECK ("identity_pilot_uninstall_retired_key"."retired_key_version" <> "identity_pilot_uninstall_retired_key"."resulting_current_key_version")
);
--> statement-breakpoint
CREATE TABLE "klaviyo_event_match_result" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"run_id" text NOT NULL,
	"run_status" text DEFAULT 'published' NOT NULL,
	"event_id" text NOT NULL,
	"status" text NOT NULL,
	"selected_candidate_id" text,
	"selected_class" text,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"duplicate_warning" integer DEFAULT 0 NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"published_at" timestamp NOT NULL,
	"superseded_at" timestamp,
	"supersession_reason" text,
	CONSTRAINT "klaviyo_event_match_result_run_event_uniq" UNIQUE("run_id","event_id"),
	CONSTRAINT "klaviyo_event_match_result_run_status_check" CHECK ("klaviyo_event_match_result"."run_status" = 'published'),
	CONSTRAINT "klaviyo_event_match_result_status_check" CHECK ("klaviyo_event_match_result"."status" in ('confirmed', 'candidate', 'ambiguous', 'unmatched')),
	CONSTRAINT "klaviyo_event_match_result_selection_check" CHECK ("klaviyo_event_match_result"."superseded_at" is not null
        or ("klaviyo_event_match_result"."status" = 'confirmed'
          and "klaviyo_event_match_result"."selected_candidate_id" is not null
          and "klaviyo_event_match_result"."selected_class" = 'deterministic')
        or ("klaviyo_event_match_result"."status" = 'candidate'
          and "klaviyo_event_match_result"."selected_candidate_id" is not null
          and "klaviyo_event_match_result"."selected_class" = 'diagnostic')
        or ("klaviyo_event_match_result"."status" in ('ambiguous', 'unmatched')
          and "klaviyo_event_match_result"."selected_candidate_id" is null
          and "klaviyo_event_match_result"."selected_class" is null)),
	CONSTRAINT "klaviyo_event_match_result_counts_check" CHECK ("klaviyo_event_match_result"."candidate_count" >= 0 and "klaviyo_event_match_result"."duplicate_warning" in (0, 1)),
	CONSTRAINT "klaviyo_event_match_result_supersession_check" CHECK (("klaviyo_event_match_result"."superseded_at" is null and "klaviyo_event_match_result"."supersession_reason" is null)
        or ("klaviyo_event_match_result"."superseded_at" is not null
          and "klaviyo_event_match_result"."published_at" <= "klaviyo_event_match_result"."superseded_at"
          and "klaviyo_event_match_result"."supersession_reason" in
            ('entity_replaced', 'incident_edge_boundary', 'rotation_key_retired', 'privacy_erasure')))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_event_run_identity_observation" (
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"sync_run_id" text NOT NULL,
	"event_id" text NOT NULL,
	"identity_hmac_id" text NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_event_run_identity_obs_uniq" UNIQUE("connection_id","sync_run_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "klaviyo_identity_rotation_publication_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"rotation_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"stage" text NOT NULL,
	"trigger_run_id" text,
	"shopify_evidence_run_id" text,
	"source_run_id" text,
	"match_run_id" text,
	"klaviyo_source_checksum" text,
	"shopify_evidence_checksum" text,
	"publication_scope_fingerprint" text,
	"invocation_fingerprint" text,
	"stale_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_identity_rotation_attempt_uniq" UNIQUE("rotation_id","attempt_number"),
	CONSTRAINT "klaviyo_identity_rotation_attempt_number_check" CHECK ("klaviyo_identity_rotation_publication_attempt"."attempt_number" > 0),
	CONSTRAINT "klaviyo_identity_rotation_attempt_stage_check" CHECK ("klaviyo_identity_rotation_publication_attempt"."stage" in
        ('refreshing_shopify_evidence', 'refreshing_order_core', 'matching', 'published', 'stale'))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_identity_rotation_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"current_key_version" text NOT NULL,
	"current_key_check" text NOT NULL,
	"previous_key_version" text NOT NULL,
	"previous_key_check" text NOT NULL,
	"state" text DEFAULT 'preparing' NOT NULL,
	"checkpoint" jsonb,
	"current_attempt_number" integer DEFAULT 0 NOT NULL,
	"sources_pending" integer DEFAULT 0 NOT NULL,
	"sources_complete" integer DEFAULT 0 NOT NULL,
	"sources_unavailable" integer DEFAULT 0 NOT NULL,
	"sources_suppressed" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"failure_code" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "klaviyo_identity_rotation_run_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id"),
	CONSTRAINT "klaviyo_identity_rotation_run_state_check" CHECK ("klaviyo_identity_rotation_run"."state" in
        ('preparing', 'dual_write', 'republishing', 'pruning', 'complete', 'failed', 'aborted')),
	CONSTRAINT "klaviyo_identity_rotation_run_versions_check" CHECK ("klaviyo_identity_rotation_run"."current_key_version" <> "klaviyo_identity_rotation_run"."previous_key_version"),
	CONSTRAINT "klaviyo_identity_rotation_run_counts_check" CHECK ("klaviyo_identity_rotation_run"."current_attempt_number" >= 0
        and "klaviyo_identity_rotation_run"."sources_pending" >= 0
        and "klaviyo_identity_rotation_run"."sources_complete" >= 0
        and "klaviyo_identity_rotation_run"."sources_unavailable" >= 0
        and "klaviyo_identity_rotation_run"."sources_suppressed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "klaviyo_identity_rotation_source" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"rotation_id" text NOT NULL,
	"source_snapshot_id" text NOT NULL,
	"kind" text NOT NULL,
	"shopify_order_id" text,
	"klaviyo_event_id" text,
	"suppression_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"released_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_identity_rotation_source_snapshot_uniq" UNIQUE("rotation_id","source_snapshot_id"),
	CONSTRAINT "klaviyo_identity_rotation_source_kind_check" CHECK ("klaviyo_identity_rotation_source"."kind" in ('shopify_order', 'klaviyo_event')),
	CONSTRAINT "klaviyo_identity_rotation_source_status_check" CHECK ("klaviyo_identity_rotation_source"."status" in ('pending', 'complete', 'unavailable', 'suppressed', 'released')),
	CONSTRAINT "klaviyo_identity_rotation_source_live_shape_check" CHECK (not ("klaviyo_identity_rotation_source"."shopify_order_id" is not null and "klaviyo_identity_rotation_source"."klaviyo_event_id" is not null)
        and ("klaviyo_identity_rotation_source"."shopify_order_id" is null or "klaviyo_identity_rotation_source"."kind" = 'shopify_order')
        and ("klaviyo_identity_rotation_source"."klaviyo_event_id" is null or "klaviyo_identity_rotation_source"."kind" = 'klaviyo_event')),
	CONSTRAINT "klaviyo_identity_rotation_source_terminal_shape_check" CHECK (("klaviyo_identity_rotation_source"."status" in ('pending', 'complete', 'unavailable')
          and "klaviyo_identity_rotation_source"."suppression_id" is null and "klaviyo_identity_rotation_source"."released_at" is null)
        or ("klaviyo_identity_rotation_source"."status" = 'suppressed'
          and "klaviyo_identity_rotation_source"."shopify_order_id" is null and "klaviyo_identity_rotation_source"."klaviyo_event_id" is null
          and "klaviyo_identity_rotation_source"."suppression_id" is not null and "klaviyo_identity_rotation_source"."released_at" is null)
        or ("klaviyo_identity_rotation_source"."status" = 'released'
          and "klaviyo_identity_rotation_source"."shopify_order_id" is null and "klaviyo_identity_rotation_source"."klaviyo_event_id" is null
          and "klaviyo_identity_rotation_source"."suppression_id" is null and "klaviyo_identity_rotation_source"."released_at" is not null)),
	CONSTRAINT "klaviyo_identity_rotation_source_attempts_check" CHECK ("klaviyo_identity_rotation_source"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "klaviyo_match_candidate" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"run_id" text NOT NULL,
	"run_status" text DEFAULT 'published' NOT NULL,
	"event_id" text NOT NULL,
	"order_id" text NOT NULL,
	"candidate_class" text NOT NULL,
	"method" text NOT NULL,
	"feature_vector" jsonb NOT NULL,
	"weights" jsonb NOT NULL,
	"tolerances" jsonb NOT NULL,
	"score" numeric NOT NULL,
	"confidence" numeric NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_match_candidate_run_edge_uniq" UNIQUE("run_id","event_id","order_id"),
	CONSTRAINT "klaviyo_match_candidate_selected_edge_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","run_id","id","candidate_class"),
	CONSTRAINT "klaviyo_match_candidate_run_status_check" CHECK ("klaviyo_match_candidate"."run_status" = 'published'),
	CONSTRAINT "klaviyo_match_candidate_class_check" CHECK ("klaviyo_match_candidate"."candidate_class" in ('deterministic', 'diagnostic')),
	CONSTRAINT "klaviyo_match_candidate_confidence_check" CHECK ("klaviyo_match_candidate"."confidence" >= 0 and "klaviyo_match_candidate"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "klaviyo_match_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"shopify_evidence_run_id" text NOT NULL,
	"matcher_version" text NOT NULL,
	"publication_scope_fingerprint" text NOT NULL,
	"invocation_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"failure_code" text,
	"event_window_from" timestamp,
	"event_window_to" timestamp,
	"shopify_window_from" timestamp,
	"shopify_window_to" timestamp,
	"klaviyo_source_checksum" text,
	"shopify_evidence_checksum" text,
	"rule_checksum" text,
	"config_checksum" text,
	"expected_order_count" integer,
	"expected_event_count" integer,
	"result_order_count" integer,
	"result_event_count" integer,
	"candidate_count" integer,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp NOT NULL,
	"published_at" timestamp,
	"superseded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_match_run_scope_id_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id"),
	CONSTRAINT "klaviyo_match_run_scope_status_uniq" UNIQUE("organization_id","shopify_store_id","connection_id","id","status"),
	CONSTRAINT "klaviyo_match_run_status_check" CHECK ("klaviyo_match_run"."status" in ('published', 'failed')),
	CONSTRAINT "klaviyo_match_run_terminal_shape_check" CHECK (("klaviyo_match_run"."status" = 'published'
          and "klaviyo_match_run"."published_at" is not null
          and "klaviyo_match_run"."failure_code" is null
          and "klaviyo_match_run"."event_window_from" is not null
          and "klaviyo_match_run"."event_window_to" is not null
          and "klaviyo_match_run"."shopify_window_from" is not null
          and "klaviyo_match_run"."shopify_window_to" is not null
          and "klaviyo_match_run"."klaviyo_source_checksum" is not null
          and "klaviyo_match_run"."shopify_evidence_checksum" is not null
          and "klaviyo_match_run"."rule_checksum" is not null
          and "klaviyo_match_run"."config_checksum" is not null
          and "klaviyo_match_run"."expected_order_count" is not null and "klaviyo_match_run"."expected_order_count" >= 0
          and "klaviyo_match_run"."expected_event_count" is not null and "klaviyo_match_run"."expected_event_count" >= 0
          and "klaviyo_match_run"."result_order_count" is not null and "klaviyo_match_run"."result_order_count" >= 0
          and "klaviyo_match_run"."result_event_count" is not null and "klaviyo_match_run"."result_event_count" >= 0
          and "klaviyo_match_run"."candidate_count" is not null and "klaviyo_match_run"."candidate_count" >= 0)
        or ("klaviyo_match_run"."status" = 'failed'
          and "klaviyo_match_run"."failure_code" is not null
          and "klaviyo_match_run"."published_at" is null
          and "klaviyo_match_run"."superseded_at" is null
          and "klaviyo_match_run"."event_window_from" is null
          and "klaviyo_match_run"."event_window_to" is null
          and "klaviyo_match_run"."shopify_window_from" is null
          and "klaviyo_match_run"."shopify_window_to" is null
          and "klaviyo_match_run"."klaviyo_source_checksum" is null
          and "klaviyo_match_run"."shopify_evidence_checksum" is null
          and "klaviyo_match_run"."rule_checksum" is null
          and "klaviyo_match_run"."config_checksum" is null
          and "klaviyo_match_run"."expected_order_count" is null
          and "klaviyo_match_run"."expected_event_count" is null
          and "klaviyo_match_run"."result_order_count" is null
          and "klaviyo_match_run"."result_event_count" is null
          and "klaviyo_match_run"."candidate_count" is null)),
	CONSTRAINT "klaviyo_match_run_supersession_check" CHECK ("klaviyo_match_run"."superseded_at" is null or "klaviyo_match_run"."published_at" <= "klaviyo_match_run"."superseded_at")
);
--> statement-breakpoint
CREATE TABLE "klaviyo_order_match_result" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"run_id" text NOT NULL,
	"run_status" text DEFAULT 'published' NOT NULL,
	"order_id" text NOT NULL,
	"status" text NOT NULL,
	"selected_candidate_id" text,
	"selected_class" text,
	"selected_event_id" text,
	"product_status" text,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"matcher_version" text NOT NULL,
	"published_at" timestamp NOT NULL,
	"superseded_at" timestamp,
	"supersession_reason" text,
	CONSTRAINT "klaviyo_order_match_result_run_order_uniq" UNIQUE("run_id","order_id"),
	CONSTRAINT "klaviyo_order_match_result_run_status_check" CHECK ("klaviyo_order_match_result"."run_status" = 'published'),
	CONSTRAINT "klaviyo_order_match_result_status_check" CHECK ("klaviyo_order_match_result"."status" in
        ('confirmed', 'candidate', 'ambiguous', 'no_klaviyo_event', 'duplicate_conversion_events')),
	CONSTRAINT "klaviyo_order_match_result_selection_check" CHECK ("klaviyo_order_match_result"."superseded_at" is not null
        or ("klaviyo_order_match_result"."status" = 'confirmed'
          and "klaviyo_order_match_result"."selected_candidate_id" is not null
          and "klaviyo_order_match_result"."selected_class" = 'deterministic'
          and "klaviyo_order_match_result"."selected_event_id" is not null)
        or ("klaviyo_order_match_result"."status" = 'candidate'
          and "klaviyo_order_match_result"."selected_candidate_id" is not null
          and "klaviyo_order_match_result"."selected_class" = 'diagnostic'
          and "klaviyo_order_match_result"."selected_event_id" is not null)
        or ("klaviyo_order_match_result"."status" in ('ambiguous', 'no_klaviyo_event', 'duplicate_conversion_events')
          and "klaviyo_order_match_result"."selected_candidate_id" is null
          and "klaviyo_order_match_result"."selected_class" is null
          and "klaviyo_order_match_result"."selected_event_id" is null)),
	CONSTRAINT "klaviyo_order_match_result_product_status_check" CHECK (("klaviyo_order_match_result"."product_status" is null and "klaviyo_order_match_result"."status" <> 'confirmed')
        or ("klaviyo_order_match_result"."status" = 'confirmed'
          and "klaviyo_order_match_result"."product_status" in ('exact', 'partial', 'contradictory', 'unavailable'))),
	CONSTRAINT "klaviyo_order_match_result_claims_check" CHECK ("klaviyo_order_match_result"."claim_count" >= 0),
	CONSTRAINT "klaviyo_order_match_result_supersession_check" CHECK (("klaviyo_order_match_result"."superseded_at" is null and "klaviyo_order_match_result"."supersession_reason" is null)
        or ("klaviyo_order_match_result"."superseded_at" is not null
          and "klaviyo_order_match_result"."published_at" <= "klaviyo_order_match_result"."superseded_at"
          and "klaviyo_order_match_result"."supersession_reason" in
            ('entity_replaced', 'incident_edge_boundary', 'rotation_key_retired', 'privacy_erasure')))
);
--> statement-breakpoint
CREATE TABLE "klaviyo_product_evidence_link" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shopify_store_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"run_id" text NOT NULL,
	"run_status" text DEFAULT 'published' NOT NULL,
	"ordered_product_event_id" text NOT NULL,
	"placed_order_event_id" text NOT NULL,
	"shopify_order_id" text NOT NULL,
	"method" text NOT NULL,
	"matcher_version" text NOT NULL,
	"status" text NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "klaviyo_product_evidence_link_run_uniq" UNIQUE("run_id","ordered_product_event_id","placed_order_event_id","shopify_order_id"),
	CONSTRAINT "klaviyo_product_evidence_link_run_status_check" CHECK ("klaviyo_product_evidence_link"."run_status" = 'published'),
	CONSTRAINT "klaviyo_product_evidence_link_method_check" CHECK ("klaviyo_product_evidence_link"."method" = 'deterministic'),
	CONSTRAINT "klaviyo_product_evidence_link_status_check" CHECK ("klaviyo_product_evidence_link"."status" in ('exact', 'partial', 'contradictory', 'unavailable'))
);
--> statement-breakpoint
ALTER TABLE "source_identity_hmac" DROP CONSTRAINT "source_identity_hmac_shopify_version_uniq";--> statement-breakpoint
ALTER TABLE "source_identity_hmac" DROP CONSTRAINT "source_identity_hmac_shopify_only";--> statement-breakpoint
ALTER TABLE "source_identity_hmac" ALTER COLUMN "shopify_order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD COLUMN "identity_write_mode" text DEFAULT 'current_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD COLUMN "identity_current_key_version" text;--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD COLUMN "identity_current_key_check" text;--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD COLUMN "identity_previous_key_version" text;--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD COLUMN "identity_previous_key_check" text;--> statement-breakpoint
ALTER TABLE "klaviyo_sync_run" ADD COLUMN "events_suppressed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_identity_hmac" ADD COLUMN "klaviyo_connection_id" text;--> statement-breakpoint
ALTER TABLE "source_identity_hmac" ADD COLUMN "klaviyo_event_id" text;--> statement-breakpoint
ALTER TABLE "identity_pilot_uninstall_receipt" ADD CONSTRAINT "identity_pilot_uninstall_receipt_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_pilot_uninstall_receipt" ADD CONSTRAINT "identity_pilot_uninstall_receipt_binding_fk" FOREIGN KEY ("organization_id","store_id","resulting_current_key_version","resulting_current_key_check") REFERENCES "public"."identity_matching_key_binding"("organization_id","store_id","key_version","key_check") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_pilot_uninstall_retired_key" ADD CONSTRAINT "identity_pilot_uninstall_retired_key_receipt_fk" FOREIGN KEY ("organization_id","store_id","receipt_id","resulting_current_key_version") REFERENCES "public"."identity_pilot_uninstall_receipt"("organization_id","store_id","id","resulting_current_key_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_pilot_uninstall_retired_key" ADD CONSTRAINT "identity_pilot_uninstall_retired_key_binding_fk" FOREIGN KEY ("organization_id","store_id","retired_key_version") REFERENCES "public"."identity_matching_key_binding"("organization_id","store_id","key_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_match_result" ADD CONSTRAINT "klaviyo_event_match_result_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","run_id","run_status") REFERENCES "public"."klaviyo_match_run"("organization_id","shopify_store_id","connection_id","id","status") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_match_result" ADD CONSTRAINT "klaviyo_event_match_result_event_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_match_result" ADD CONSTRAINT "klaviyo_event_match_result_selected_edge_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","run_id","selected_candidate_id","selected_class") REFERENCES "public"."klaviyo_match_candidate"("organization_id","shopify_store_id","connection_id","run_id","id","candidate_class") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_run_identity_observation" ADD CONSTRAINT "klaviyo_event_run_identity_obs_membership_fk" FOREIGN KEY ("connection_id","sync_run_id","event_id") REFERENCES "public"."klaviyo_event_run_observation"("connection_id","sync_run_id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_event_run_identity_observation" ADD CONSTRAINT "klaviyo_event_run_identity_obs_run_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","sync_run_id") REFERENCES "public"."klaviyo_sync_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_identity_hmac" ADD CONSTRAINT "source_identity_hmac_scope_event_id_uniq" UNIQUE("organization_id","store_id","klaviyo_connection_id","klaviyo_event_id","id");--> statement-breakpoint
ALTER TABLE "klaviyo_event_run_identity_observation" ADD CONSTRAINT "klaviyo_event_run_identity_obs_hmac_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","event_id","identity_hmac_id") REFERENCES "public"."source_identity_hmac"("organization_id","store_id","klaviyo_connection_id","klaviyo_event_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_identity_rotation_publication_attempt" ADD CONSTRAINT "klaviyo_identity_rotation_attempt_rotation_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","rotation_id") REFERENCES "public"."klaviyo_identity_rotation_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_identity_rotation_run" ADD CONSTRAINT "klaviyo_identity_rotation_run_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_identity_rotation_run" ADD CONSTRAINT "klaviyo_identity_rotation_current_binding_fk" FOREIGN KEY ("organization_id","shopify_store_id","current_key_version","current_key_check") REFERENCES "public"."identity_matching_key_binding"("organization_id","store_id","key_version","key_check") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_identity_rotation_run" ADD CONSTRAINT "klaviyo_identity_rotation_previous_binding_fk" FOREIGN KEY ("organization_id","shopify_store_id","previous_key_version","previous_key_check") REFERENCES "public"."identity_matching_key_binding"("organization_id","store_id","key_version","key_check") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_identity_rotation_source" ADD CONSTRAINT "klaviyo_identity_rotation_source_rotation_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","rotation_id") REFERENCES "public"."klaviyo_identity_rotation_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_identity_rotation_source" ADD CONSTRAINT "klaviyo_identity_rotation_source_order_fk" FOREIGN KEY ("organization_id","shopify_store_id","shopify_order_id") REFERENCES "public"."shopify_order"("organization_id","store_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_identity_rotation_source" ADD CONSTRAINT "klaviyo_identity_rotation_source_event_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","klaviyo_event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_identity_rotation_source" ADD CONSTRAINT "klaviyo_identity_rotation_source_suppression_fk" FOREIGN KEY ("organization_id","shopify_store_id","suppression_id") REFERENCES "public"."identity_erasure_suppression"("organization_id","store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_match_candidate" ADD CONSTRAINT "klaviyo_match_candidate_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","run_id","run_status") REFERENCES "public"."klaviyo_match_run"("organization_id","shopify_store_id","connection_id","id","status") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_match_candidate" ADD CONSTRAINT "klaviyo_match_candidate_event_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_match_candidate" ADD CONSTRAINT "klaviyo_match_candidate_order_fk" FOREIGN KEY ("organization_id","shopify_store_id","order_id") REFERENCES "public"."shopify_order"("organization_id","store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_match_run" ADD CONSTRAINT "klaviyo_match_run_scope_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_match_run" ADD CONSTRAINT "klaviyo_match_run_source_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","source_run_id") REFERENCES "public"."klaviyo_sync_run"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_match_run" ADD CONSTRAINT "klaviyo_match_run_evidence_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","shopify_evidence_run_id") REFERENCES "public"."shopify_evidence_sync_run"("organization_id","store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_order_match_result" ADD CONSTRAINT "klaviyo_order_match_result_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","run_id","run_status") REFERENCES "public"."klaviyo_match_run"("organization_id","shopify_store_id","connection_id","id","status") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_order_match_result" ADD CONSTRAINT "klaviyo_order_match_result_order_fk" FOREIGN KEY ("organization_id","shopify_store_id","order_id") REFERENCES "public"."shopify_order"("organization_id","store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_order_match_result" ADD CONSTRAINT "klaviyo_order_match_result_selected_edge_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","run_id","selected_candidate_id","selected_class") REFERENCES "public"."klaviyo_match_candidate"("organization_id","shopify_store_id","connection_id","run_id","id","candidate_class") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_order_match_result" ADD CONSTRAINT "klaviyo_order_match_result_selected_event_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","selected_event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_product_evidence_link" ADD CONSTRAINT "klaviyo_product_evidence_link_run_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","run_id","run_status") REFERENCES "public"."klaviyo_match_run"("organization_id","shopify_store_id","connection_id","id","status") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_product_evidence_link" ADD CONSTRAINT "klaviyo_product_evidence_link_op_event_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","ordered_product_event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_product_evidence_link" ADD CONSTRAINT "klaviyo_product_evidence_link_po_event_fk" FOREIGN KEY ("organization_id","shopify_store_id","connection_id","placed_order_event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_product_evidence_link" ADD CONSTRAINT "klaviyo_product_evidence_link_order_fk" FOREIGN KEY ("organization_id","shopify_store_id","shopify_order_id") REFERENCES "public"."shopify_order"("organization_id","store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_event_match_result_current_uidx" ON "klaviyo_event_match_result" USING btree ("connection_id","event_id") WHERE "klaviyo_event_match_result"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "klaviyo_event_match_result_event_idx" ON "klaviyo_event_match_result" USING btree ("connection_id","event_id");--> statement-breakpoint
CREATE INDEX "klaviyo_event_run_identity_obs_run_idx" ON "klaviyo_event_run_identity_observation" USING btree ("connection_id","sync_run_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_identity_rotation_run_live_uidx" ON "klaviyo_identity_rotation_run" USING btree ("connection_id") WHERE "klaviyo_identity_rotation_run"."state" not in ('complete', 'failed', 'aborted');--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_identity_rotation_source_order_uidx" ON "klaviyo_identity_rotation_source" USING btree ("rotation_id","shopify_order_id") WHERE "klaviyo_identity_rotation_source"."shopify_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_identity_rotation_source_event_uidx" ON "klaviyo_identity_rotation_source" USING btree ("rotation_id","klaviyo_event_id") WHERE "klaviyo_identity_rotation_source"."klaviyo_event_id" is not null;--> statement-breakpoint
CREATE INDEX "klaviyo_match_candidate_event_idx" ON "klaviyo_match_candidate" USING btree ("connection_id","event_id");--> statement-breakpoint
CREATE INDEX "klaviyo_match_candidate_order_idx" ON "klaviyo_match_candidate" USING btree ("organization_id","shopify_store_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_match_run_published_invocation_uidx" ON "klaviyo_match_run" USING btree ("connection_id","invocation_fingerprint") WHERE "klaviyo_match_run"."status" = 'published';--> statement-breakpoint
CREATE INDEX "klaviyo_match_run_invocation_idx" ON "klaviyo_match_run" USING btree ("connection_id","invocation_fingerprint");--> statement-breakpoint
CREATE INDEX "klaviyo_match_run_scope_time_idx" ON "klaviyo_match_run" USING btree ("organization_id","shopify_store_id","connection_id","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "klaviyo_order_match_result_current_uidx" ON "klaviyo_order_match_result" USING btree ("connection_id","order_id") WHERE "klaviyo_order_match_result"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "klaviyo_order_match_result_order_idx" ON "klaviyo_order_match_result" USING btree ("organization_id","shopify_store_id","order_id");--> statement-breakpoint
CREATE INDEX "klaviyo_product_evidence_link_order_idx" ON "klaviyo_product_evidence_link" USING btree ("organization_id","shopify_store_id","shopify_order_id");--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD CONSTRAINT "klaviyo_connection_identity_current_binding_fk" FOREIGN KEY ("organization_id","shopify_store_id","identity_current_key_version","identity_current_key_check") REFERENCES "public"."identity_matching_key_binding"("organization_id","store_id","key_version","key_check") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD CONSTRAINT "klaviyo_connection_identity_previous_binding_fk" FOREIGN KEY ("organization_id","shopify_store_id","identity_previous_key_version","identity_previous_key_check") REFERENCES "public"."identity_matching_key_binding"("organization_id","store_id","key_version","key_check") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_identity_hmac" ADD CONSTRAINT "source_identity_hmac_klaviyo_connection_fk" FOREIGN KEY ("organization_id","store_id","klaviyo_connection_id") REFERENCES "public"."klaviyo_connection"("organization_id","shopify_store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_identity_hmac" ADD CONSTRAINT "source_identity_hmac_klaviyo_event_fk" FOREIGN KEY ("organization_id","store_id","klaviyo_connection_id","klaviyo_event_id") REFERENCES "public"."klaviyo_event"("organization_id","shopify_store_id","connection_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_identity_hmac_shopify_version_uidx" ON "source_identity_hmac" USING btree ("shopify_order_id","key_version") WHERE "source_identity_hmac"."shopify_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "source_identity_hmac_klaviyo_version_uidx" ON "source_identity_hmac" USING btree ("klaviyo_connection_id","klaviyo_event_id","key_version") WHERE "source_identity_hmac"."klaviyo_connection_id" is not null;--> statement-breakpoint
CREATE INDEX "source_identity_hmac_klaviyo_digest_idx" ON "source_identity_hmac" USING btree ("klaviyo_connection_id","key_version","digest");--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD CONSTRAINT "klaviyo_connection_identity_write_mode_check" CHECK ("klaviyo_connection"."identity_write_mode" in ('current_only', 'dual'));--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD CONSTRAINT "klaviyo_connection_identity_current_pair_check" CHECK (("klaviyo_connection"."identity_current_key_version" is null and "klaviyo_connection"."identity_current_key_check" is null)
        or ("klaviyo_connection"."identity_current_key_version" is not null and "klaviyo_connection"."identity_current_key_check" is not null));--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD CONSTRAINT "klaviyo_connection_identity_previous_pair_check" CHECK (("klaviyo_connection"."identity_previous_key_version" is null and "klaviyo_connection"."identity_previous_key_check" is null)
        or ("klaviyo_connection"."identity_previous_key_version" is not null and "klaviyo_connection"."identity_previous_key_check" is not null));--> statement-breakpoint
ALTER TABLE "klaviyo_connection" ADD CONSTRAINT "klaviyo_connection_identity_gate_shape_check" CHECK (("klaviyo_connection"."identity_write_mode" = 'current_only' and "klaviyo_connection"."identity_previous_key_version" is null)
        or ("klaviyo_connection"."identity_write_mode" = 'dual'
          and "klaviyo_connection"."identity_current_key_version" is not null
          and "klaviyo_connection"."identity_previous_key_version" is not null
          and "klaviyo_connection"."identity_current_key_version" <> "klaviyo_connection"."identity_previous_key_version"
          and "klaviyo_connection"."identity_current_key_check" <> "klaviyo_connection"."identity_previous_key_check"));--> statement-breakpoint
ALTER TABLE "klaviyo_sync_run" ADD CONSTRAINT "klaviyo_sync_run_events_suppressed_check" CHECK ("klaviyo_sync_run"."events_suppressed" >= 0);--> statement-breakpoint
ALTER TABLE "source_identity_hmac" ADD CONSTRAINT "source_identity_hmac_exactly_one_source" CHECK ((("source_identity_hmac"."source_kind")::text = 'shopify_order' AND "source_identity_hmac"."shopify_order_id" IS NOT NULL
        AND "source_identity_hmac"."klaviyo_connection_id" IS NULL AND "source_identity_hmac"."klaviyo_event_id" IS NULL)
      OR (("source_identity_hmac"."source_kind")::text = 'klaviyo_event' AND "source_identity_hmac"."shopify_order_id" IS NULL
        AND "source_identity_hmac"."klaviyo_connection_id" IS NOT NULL AND "source_identity_hmac"."klaviyo_event_id" IS NOT NULL));