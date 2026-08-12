DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "shopify_store" AS s
		LEFT JOIN "organization" AS o ON o."id" = s."organization_id"
		WHERE o."id" IS NULL
	) THEN
		RAISE EXCEPTION 'shopify_store organization scope preflight failed';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "shopify_order" AS o
		JOIN "shopify_store" AS s ON s."id" = o."store_id"
		WHERE o."organization_id" IS DISTINCT FROM s."organization_id"
	) THEN
		RAISE EXCEPTION 'shopify_order store scope preflight failed';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "shopify_refund" AS r
		JOIN "shopify_order" AS o ON o."id" = r."order_id"
		WHERE r."organization_id" IS DISTINCT FROM o."organization_id"
			OR r."store_id" IS DISTINCT FROM o."store_id"
	) THEN
		RAISE EXCEPTION 'shopify_refund order scope preflight failed';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "shopify_sync_run" AS r
		JOIN "shopify_store" AS s ON s."id" = r."store_id"
		WHERE r."organization_id" IS DISTINCT FROM s."organization_id"
	) THEN
		RAISE EXCEPTION 'shopify_sync_run store scope preflight failed';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "finding" AS f
		JOIN "shopify_store" AS s ON s."id" = f."store_id"
		WHERE f."store_id" IS NOT NULL
			AND f."organization_id" IS DISTINCT FROM s."organization_id"
	) THEN
		RAISE EXCEPTION 'finding store scope preflight failed';
	END IF;
END
$$;--> statement-breakpoint
CREATE TYPE "public"."identity_erasure_suppression_kind" AS ENUM('email', 'shopify_customer_id');--> statement-breakpoint
CREATE TYPE "public"."identity_hmac_rotation_state" AS ENUM('active', 'rotation_previous');--> statement-breakpoint
CREATE TYPE "public"."shopify_evidence_capability" AS ENUM('unknown', 'available', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."shopify_evidence_completeness" AS ENUM('unknown', 'complete', 'partial', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."shopify_evidence_run_status" AS ENUM('running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."source_identity_kind" AS ENUM('shopify_order');--> statement-breakpoint
CREATE TABLE "identity_crypto_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"matching_current_version" text NOT NULL,
	"matching_current_key_check" text NOT NULL,
	"matching_previous_version" text,
	"matching_previous_key_check" text,
	"suppression_version" text NOT NULL,
	"suppression_key_check" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "identity_crypto_policy_org_store_uniq" UNIQUE("organization_id","store_id"),
	CONSTRAINT "identity_crypto_policy_previous_pair" CHECK (("identity_crypto_policy"."matching_previous_version" IS NULL AND "identity_crypto_policy"."matching_previous_key_check" IS NULL) OR ("identity_crypto_policy"."matching_previous_version" IS NOT NULL AND "identity_crypto_policy"."matching_previous_key_check" IS NOT NULL)),
	CONSTRAINT "identity_crypto_policy_versions_distinct" CHECK ("identity_crypto_policy"."matching_previous_version" IS NULL OR "identity_crypto_policy"."matching_previous_version" <> "identity_crypto_policy"."matching_current_version")
);
--> statement-breakpoint
CREATE TABLE "identity_erasure_suppression" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"kind" "identity_erasure_suppression_kind" NOT NULL,
	"key_version" text NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "identity_erasure_suppression_scope_digest_uniq" UNIQUE("organization_id","store_id","kind","key_version","digest"),
	CONSTRAINT "identity_erasure_suppression_scope_id_uniq" UNIQUE("organization_id","store_id","id")
);
--> statement-breakpoint
CREATE TABLE "identity_matching_key_binding" (
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"key_version" text NOT NULL,
	"key_check" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "identity_matching_key_binding_scope_version_uniq" UNIQUE("organization_id","store_id","key_version"),
	CONSTRAINT "identity_matching_key_binding_scope_version_check_uniq" UNIQUE("organization_id","store_id","key_version","key_check")
);
--> statement-breakpoint
CREATE TABLE "shopify_evidence_run_identity_observation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"evidence_run_id" text NOT NULL,
	"order_id" text NOT NULL,
	"identity_hmac_id" text NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_evidence_identity_observation_run_order_uniq" UNIQUE("store_id","evidence_run_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "shopify_evidence_run_observation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"evidence_run_id" text NOT NULL,
	"order_id" text NOT NULL,
	"line_disposition" text NOT NULL,
	"identity_disposition" text NOT NULL,
	"observed_content_checksum" text NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_evidence_observation_scope_run_order_uniq" UNIQUE("organization_id","store_id","evidence_run_id","order_id"),
	CONSTRAINT "shopify_evidence_observation_line_disposition_check" CHECK ("shopify_evidence_run_observation"."line_disposition" IN ('complete', 'preserved_partial')),
	CONSTRAINT "shopify_evidence_observation_identity_disposition_check" CHECK ("shopify_evidence_run_observation"."identity_disposition" IN ('available', 'unavailable', 'not_refreshed', 'suppressed'))
);
--> statement-breakpoint
CREATE TABLE "shopify_evidence_sync_run" (
	"id" text PRIMARY KEY NOT NULL,
	"start_trigger_run_id" text NOT NULL,
	"first_batch_trigger_run_id" text,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"mode" text NOT NULL,
	"store_timezone" text NOT NULL,
	"anchor_store_day" text NOT NULL,
	"requested_from" timestamp NOT NULL,
	"requested_to" timestamp NOT NULL,
	"cursor" text,
	"status" "shopify_evidence_run_status" DEFAULT 'running' NOT NULL,
	"identity_capability" "shopify_evidence_capability" DEFAULT 'unknown' NOT NULL,
	"line_completeness" "shopify_evidence_completeness" DEFAULT 'unknown' NOT NULL,
	"orders_read" integer DEFAULT 0 NOT NULL,
	"orders_enriched" integer DEFAULT 0 NOT NULL,
	"orders_partial" integer DEFAULT 0 NOT NULL,
	"orders_unavailable" integer DEFAULT 0 NOT NULL,
	"warnings" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"error" text,
	"heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "shopify_evidence_sync_run_start_trigger_uniq" UNIQUE("start_trigger_run_id"),
	CONSTRAINT "shopify_evidence_sync_run_scope_id_uniq" UNIQUE("organization_id","store_id","id"),
	CONSTRAINT "shopify_evidence_sync_run_window_valid" CHECK ("shopify_evidence_sync_run"."requested_from" < "shopify_evidence_sync_run"."requested_to"),
	CONSTRAINT "shopify_evidence_sync_run_mode_check" CHECK ("shopify_evidence_sync_run"."mode" IN ('initial_90d', 'incremental_7d'))
);
--> statement-breakpoint
CREATE TABLE "shopify_order_line" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"order_id" text NOT NULL,
	"shopify_line_item_id" text NOT NULL,
	"shopify_product_id" text,
	"shopify_variant_id" text,
	"sku" text,
	"product_title" text NOT NULL,
	"variant_title" text,
	"quantity" integer NOT NULL,
	"source_position" integer,
	"parent_order_updated_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_order_line_store_external_uniq" UNIQUE("store_id","shopify_line_item_id"),
	CONSTRAINT "shopify_order_line_quantity_positive" CHECK ("shopify_order_line"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "source_identity_hmac" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"store_id" text NOT NULL,
	"source_kind" "source_identity_kind" NOT NULL,
	"shopify_order_id" text NOT NULL,
	"key_version" text NOT NULL,
	"digest" text NOT NULL,
	"rotation_state" "identity_hmac_rotation_state" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "source_identity_hmac_shopify_version_uniq" UNIQUE("shopify_order_id","key_version"),
	CONSTRAINT "source_identity_hmac_scope_id_uniq" UNIQUE("organization_id","store_id","id"),
	CONSTRAINT "source_identity_hmac_scope_order_id_uniq" UNIQUE("organization_id","store_id","shopify_order_id","id"),
	CONSTRAINT "source_identity_hmac_shopify_only" CHECK ("source_identity_hmac"."source_kind" = 'shopify_order' AND "source_identity_hmac"."shopify_order_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "shopify_order" ADD COLUMN "shopify_customer_id" text;--> statement-breakpoint
ALTER TABLE "shopify_order" ADD CONSTRAINT "shopify_order_org_store_id_uniq" UNIQUE("organization_id","store_id","id");--> statement-breakpoint
ALTER TABLE "shopify_store" ADD CONSTRAINT "shopify_store_org_id_uniq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "shopify_store" ADD CONSTRAINT "shopify_store_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding" DROP CONSTRAINT "finding_store_id_shopify_store_id_fk";--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_org_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_order" DROP CONSTRAINT "shopify_order_store_id_shopify_store_id_fk";--> statement-breakpoint
ALTER TABLE "shopify_order" ADD CONSTRAINT "shopify_order_org_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_refund" DROP CONSTRAINT "shopify_refund_store_id_shopify_store_id_fk";--> statement-breakpoint
ALTER TABLE "shopify_refund" DROP CONSTRAINT "shopify_refund_order_id_shopify_order_id_fk";--> statement-breakpoint
ALTER TABLE "shopify_refund" ADD CONSTRAINT "shopify_refund_org_store_order_fk" FOREIGN KEY ("organization_id","store_id","order_id") REFERENCES "public"."shopify_order"("organization_id","store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_sync_run" DROP CONSTRAINT "shopify_sync_run_store_id_shopify_store_id_fk";--> statement-breakpoint
ALTER TABLE "shopify_sync_run" ADD CONSTRAINT "shopify_sync_run_org_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_crypto_policy" ADD CONSTRAINT "identity_crypto_policy_org_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_crypto_policy" ADD CONSTRAINT "identity_crypto_policy_current_binding_fk" FOREIGN KEY ("organization_id","store_id","matching_current_version","matching_current_key_check") REFERENCES "public"."identity_matching_key_binding"("organization_id","store_id","key_version","key_check") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_crypto_policy" ADD CONSTRAINT "identity_crypto_policy_previous_binding_fk" FOREIGN KEY ("organization_id","store_id","matching_previous_version","matching_previous_key_check") REFERENCES "public"."identity_matching_key_binding"("organization_id","store_id","key_version","key_check") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_erasure_suppression" ADD CONSTRAINT "identity_erasure_suppression_org_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_matching_key_binding" ADD CONSTRAINT "identity_matching_key_binding_org_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_evidence_run_identity_observation" ADD CONSTRAINT "shopify_evidence_identity_observation_content_fk" FOREIGN KEY ("organization_id","store_id","evidence_run_id","order_id") REFERENCES "public"."shopify_evidence_run_observation"("organization_id","store_id","evidence_run_id","order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_evidence_run_identity_observation" ADD CONSTRAINT "shopify_evidence_identity_observation_hmac_fk" FOREIGN KEY ("organization_id","store_id","order_id","identity_hmac_id") REFERENCES "public"."source_identity_hmac"("organization_id","store_id","shopify_order_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_evidence_run_observation" ADD CONSTRAINT "shopify_evidence_observation_run_fk" FOREIGN KEY ("organization_id","store_id","evidence_run_id") REFERENCES "public"."shopify_evidence_sync_run"("organization_id","store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_evidence_run_observation" ADD CONSTRAINT "shopify_evidence_observation_order_fk" FOREIGN KEY ("organization_id","store_id","order_id") REFERENCES "public"."shopify_order"("organization_id","store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_evidence_sync_run" ADD CONSTRAINT "shopify_evidence_sync_run_org_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."shopify_store"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_order_line" ADD CONSTRAINT "shopify_order_line_org_store_order_fk" FOREIGN KEY ("organization_id","store_id","order_id") REFERENCES "public"."shopify_order"("organization_id","store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_identity_hmac" ADD CONSTRAINT "source_identity_hmac_shopify_order_fk" FOREIGN KEY ("organization_id","store_id","shopify_order_id") REFERENCES "public"."shopify_order"("organization_id","store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_erasure_suppression_lookup_idx" ON "identity_erasure_suppression" USING btree ("organization_id","store_id","key_version","kind","digest");--> statement-breakpoint
CREATE INDEX "shopify_evidence_identity_observation_run_idx" ON "shopify_evidence_run_identity_observation" USING btree ("organization_id","store_id","evidence_run_id");--> statement-breakpoint
CREATE INDEX "shopify_evidence_observation_run_order_idx" ON "shopify_evidence_run_observation" USING btree ("organization_id","store_id","evidence_run_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_evidence_sync_run_one_running_store_uidx" ON "shopify_evidence_sync_run" USING btree ("store_id") WHERE "shopify_evidence_sync_run"."status" = 'running';--> statement-breakpoint
CREATE INDEX "shopify_evidence_sync_run_scope_started_idx" ON "shopify_evidence_sync_run" USING btree ("organization_id","store_id","started_at");--> statement-breakpoint
CREATE INDEX "shopify_order_line_order_idx" ON "shopify_order_line" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shopify_order_line_store_product_idx" ON "shopify_order_line" USING btree ("store_id","shopify_product_id");--> statement-breakpoint
CREATE INDEX "shopify_order_line_store_variant_idx" ON "shopify_order_line" USING btree ("store_id","shopify_variant_id");--> statement-breakpoint
CREATE INDEX "shopify_order_line_store_sku_idx" ON "shopify_order_line" USING btree ("store_id","sku");--> statement-breakpoint
CREATE INDEX "source_identity_hmac_scope_digest_idx" ON "source_identity_hmac" USING btree ("organization_id","store_id","key_version","digest");--> statement-breakpoint
CREATE INDEX "shopify_order_store_customer_idx" ON "shopify_order" USING btree ("store_id","shopify_customer_id");--> statement-breakpoint
