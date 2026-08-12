import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  klaviyoConnections,
  klaviyoEventAliases,
  klaviyoEventRunObservations,
  klaviyoEvents,
  klaviyoEventProducts,
  klaviyoJoinRules,
  klaviyoMetrics,
  klaviyoProbeReports,
  klaviyoSyncRuns,
} from "@/schema/klaviyo";

function resolveConnectionString(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const match = envFile.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function readMigrationStatements(fileName: string): string[] {
  return readFileSync(path.resolve(process.cwd(), "drizzle", fileName), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const PRE_0053_FIXTURE_DDL = [
  `CREATE TABLE organization (
     id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
     logo text, created_at timestamp NOT NULL, metadata text
   )`,
  `CREATE TABLE shopify_store (
     id text PRIMARY KEY, organization_id text NOT NULL,
     shop_domain text NOT NULL UNIQUE, access_token text,
     iana_timezone text NOT NULL, currency text, last_synced_at timestamp,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL
   )`,
  `CREATE TYPE attribution_bucket AS ENUM (
     'meta', 'google', 'klaviyo', 'tiktok', 'ai',
     'organic_direct', 'unattributed', 'untracked'
   )`,
  `CREATE TABLE shopify_order (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     shopify_order_id text NOT NULL, order_name text,
     order_created_at timestamp NOT NULL, order_updated_at timestamp,
     order_day date NOT NULL, net_sales numeric NOT NULL,
     taxes_included boolean, customer_journey jsonb,
     journey_ready boolean DEFAULT false NOT NULL, pending_since timestamp,
     last_click_utm_source text, last_click_utm_medium text,
     last_click_utm_campaign text, bucket attribution_bucket,
     bucket_rule_version integer, meta_verified boolean DEFAULT false NOT NULL,
     meta_campaign_id text, verification_pending boolean DEFAULT false NOT NULL,
     cancelled_at timestamp, cancel_reason text, order_source_name text,
     created_at timestamp DEFAULT now() NOT NULL,
     updated_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_order_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE,
     CONSTRAINT shopify_order_store_order_uniq UNIQUE (store_id, shopify_order_id)
   )`,
  `CREATE TABLE shopify_refund (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     order_id text NOT NULL, shopify_refund_id text NOT NULL,
     refund_day date NOT NULL, amount numeric NOT NULL,
     kind text DEFAULT 'refund' NOT NULL, refund_created_at timestamp,
     created_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT shopify_refund_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE,
     CONSTRAINT shopify_refund_order_id_shopify_order_id_fk
       FOREIGN KEY (order_id) REFERENCES shopify_order(id) ON DELETE CASCADE,
     CONSTRAINT shopify_refund_store_refund_uniq UNIQUE (store_id, shopify_refund_id)
   )`,
  `CREATE TABLE shopify_sync_run (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text NOT NULL,
     trigger_type text NOT NULL, phase text NOT NULL, date_from date, date_to date,
     result text, orders_synced integer, error text,
     requested_at timestamp DEFAULT now() NOT NULL, finished_at timestamp, meta jsonb,
     CONSTRAINT shopify_sync_run_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE
   )`,
  `CREATE TYPE finding_type AS ENUM (
     'meta_overclaim', 'unattributed_spike', 'broken_utm_template',
     'sync_failure', 'roas_below_target'
   )`,
  `CREATE TABLE finding (
     id text PRIMARY KEY, organization_id text NOT NULL, store_id text,
     type finding_type NOT NULL, fired_at timestamp DEFAULT now() NOT NULL,
     payload jsonb NOT NULL, created_at timestamp DEFAULT now() NOT NULL,
     CONSTRAINT finding_store_id_shopify_store_id_fk
       FOREIGN KEY (store_id) REFERENCES shopify_store(id) ON DELETE CASCADE
   )`,
];

describe("Klaviyo source schema", () => {
  it("exports every Plan 2 table", () => {
    expect(klaviyoConnections).toBeDefined();
    expect(klaviyoEventAliases).toBeDefined();
    expect(klaviyoMetrics).toBeDefined();
    expect(klaviyoProbeReports).toBeDefined();
    expect(klaviyoJoinRules).toBeDefined();
    expect(klaviyoSyncRuns).toBeDefined();
    expect(klaviyoEvents).toBeDefined();
    expect(klaviyoEventRunObservations).toBeDefined();
    expect(klaviyoEventProducts).toBeDefined();
  });

  it("pins the generated source-core migration contract", () => {
    const sql = readFileSync(
      path.resolve(process.cwd(), "drizzle/0054_klaviyo_source_core.sql"),
      "utf8",
    );
    const expectedTables = [
      "klaviyo_connection",
      "klaviyo_event_alias",
      "klaviyo_event_product",
      "klaviyo_event_run_observation",
      "klaviyo_event",
      "klaviyo_join_rule",
      "klaviyo_metric",
      "klaviyo_probe_report",
      "klaviyo_sync_run",
    ];

    expect(sql.match(/CREATE TABLE "klaviyo_/g)).toHaveLength(9);
    for (const table of expectedTables) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }

    for (const contract of [
      "klaviyo_connection_initial_source_window_check",
      "klaviyo_connection_active_account_uidx",
      "klaviyo_metric_connection_external_uniq",
      "klaviyo_metric_enabled_kind_uidx",
      "klaviyo_sync_run_one_running_discovery_uidx",
      "klaviyo_sync_run_one_running_probe_uidx",
      "klaviyo_sync_run_one_running_events_uidx",
      "klaviyo_sync_run_operation_check",
      "klaviyo_sync_run_status_check",
      "klaviyo_probe_report_run_scope_fk",
      "klaviyo_probe_report_sample_size_check",
      "klaviyo_probe_report_overlap_check",
      "klaviyo_event_alias_report_metric_field_uniq",
      "klaviyo_event_alias_report_metric_source_uniq",
      "klaviyo_event_alias_approved_metric_field_uniq",
      "klaviyo_event_alias_approved_metric_source_uniq",
      "klaviyo_join_rule_report_source_uniq",
      "klaviyo_join_rule_approved_source_uidx",
      "klaviyo_event_connection_external_uniq",
      "klaviyo_event_product_completeness_check",
      "klaviyo_event_run_observation_membership_uniq",
      "klaviyo_event_run_observation_run_scope_fk",
      "klaviyo_event_run_observation_event_scope_fk",
      "klaviyo_event_run_observation_exact_run_idx",
      "klaviyo_event_product_quantity_check",
    ]) {
      expect(sql).toContain(contract);
    }

    expect(sql).toContain('"heartbeat_at" timestamp DEFAULT now() NOT NULL');
    expect(sql).toContain(
      'UNIQUE("connection_id","sync_run_id","event_id")',
    );

    const observationDefinition = sql.slice(
      sql.indexOf('CREATE TABLE "klaviyo_event_run_observation"'),
      sql.indexOf('CREATE TABLE "klaviyo_event"'),
    );
    expect(observationDefinition).toContain('"observed_source_checksum" text NOT NULL');
    for (const forbiddenColumn of [
      "external_event_id",
      "profile_id",
      "identity",
      "product_id",
      "provider_value",
      "redacted_properties",
      "match_conclusion",
    ]) {
      expect(observationDefinition).not.toContain(`"${forbiddenColumn}"`);
    }
  });
});

const baseConnectionString = resolveConnectionString();
const testDatabase = `adsolute_klaviyo_schema_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
if (!/^[a-z0-9_]+$/.test(testDatabase)) {
  throw new Error("Unsafe Klaviyo schema test database name");
}

let adminPool: Pool | null = null;
let testPool: Pool | null = null;

const describeIfDb = baseConnectionString ? describe : describe.skip;

describeIfDb("Klaviyo source migration on PostgreSQL", () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    await adminPool.query(`CREATE DATABASE "${testDatabase}"`);
    testPool = new Pool({
      connectionString: withDatabase(baseConnectionString!, testDatabase),
    });

    for (const statement of PRE_0053_FIXTURE_DDL) {
      await testPool.query(statement);
    }
    for (const migration of [
      "0053_klaviyo_shopify_evidence.sql",
      "0054_klaviyo_source_core.sql",
      "0055_klaviyo_advisory_matching.sql",
    ]) {
      for (const statement of readMigrationStatements(migration)) {
        await testPool.query(statement);
      }
    }
  }, 30_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${testDatabase}"`);
      await adminPool.end();
    }
    testPool = null;
    adminPool = null;
  });

  it("applies 0054 and exposes the scoped observation contract", async () => {
    const tables = await testPool!.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'klaviyo_%'
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "klaviyo_connection",
      "klaviyo_event",
      "klaviyo_event_alias",
      // Plan 3 advisory-matching tables (migration 0055).
      "klaviyo_event_match_result",
      "klaviyo_event_product",
      "klaviyo_event_run_identity_observation",
      "klaviyo_event_run_observation",
      "klaviyo_identity_rotation_publication_attempt",
      "klaviyo_identity_rotation_run",
      "klaviyo_identity_rotation_source",
      "klaviyo_join_rule",
      "klaviyo_match_candidate",
      "klaviyo_match_run",
      "klaviyo_metric",
      "klaviyo_order_match_result",
      "klaviyo_probe_report",
      "klaviyo_product_evidence_link",
      "klaviyo_sync_run",
    ]);

    const observationColumns = await testPool!.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'klaviyo_event_run_observation'
        ORDER BY ordinal_position`,
    );
    expect(observationColumns.rows.map((row) => row.column_name)).toEqual([
      "organization_id",
      "shopify_store_id",
      "connection_id",
      "sync_run_id",
      "event_id",
      "observed_source_checksum",
      "observed_at",
    ]);

    const observationForeignKeys = await testPool!.query<{
      conname: string;
      delete_action: string;
    }>(
      `SELECT conname, confdeltype AS delete_action
         FROM pg_constraint
        WHERE conrelid = 'klaviyo_event_run_observation'::regclass
          AND contype = 'f'
        ORDER BY conname`,
    );
    expect(observationForeignKeys.rows).toEqual([
      {
        conname: "klaviyo_event_run_observation_event_scope_fk",
        delete_action: "c",
      },
      {
        conname: "klaviyo_event_run_observation_run_scope_fk",
        delete_action: "c",
      },
    ]);

    const partialIndexes = await testPool!.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'klaviyo_connection_active_account_uidx',
            'klaviyo_sync_run_one_running_discovery_uidx',
            'klaviyo_sync_run_one_running_probe_uidx',
            'klaviyo_sync_run_one_running_events_uidx',
            'klaviyo_event_alias_approved_metric_field_uniq',
            'klaviyo_event_alias_approved_metric_source_uniq',
            'klaviyo_join_rule_approved_source_uidx'
          )
        ORDER BY indexname`,
    );
    expect(partialIndexes.rows).toHaveLength(7);
  });
});
