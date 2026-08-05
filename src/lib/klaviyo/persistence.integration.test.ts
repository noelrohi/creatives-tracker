import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

function migrationStatements(fileName: string): string[] {
  return readFileSync(path.resolve(process.cwd(), "drizzle", fileName), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const FIXTURE_DDL = [
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

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_match_test";
const testPool = baseConnectionString
  ? new Pool({
      connectionString: withDatabase(baseConnectionString, TEST_DATABASE),
      max: 4,
    })
  : null;
const describeIfDb = baseConnectionString ? describe : describe.skip;

async function expectSqlError(
  statement: string,
  expectedCodes: string[],
  params: unknown[] = [],
): Promise<void> {
  let code: string | null = null;
  try {
    await testPool!.query(statement, params);
  } catch (error) {
    code = (error as { code?: string }).code ?? null;
  }
  expect(expectedCodes).toContain(code);
}

const PUBLISHED_RUN_COLUMNS = `
  (id, organization_id, shopify_store_id, connection_id, source_run_id,
   shopify_evidence_run_id, matcher_version, publication_scope_fingerprint,
   invocation_fingerprint, status, event_window_from, event_window_to,
   shopify_window_from, shopify_window_to, klaviyo_source_checksum,
   shopify_evidence_checksum, rule_checksum, config_checksum,
   expected_order_count, expected_event_count, result_order_count,
   result_event_count, candidate_count, started_at, completed_at, published_at)`;

function publishedRunValues(id: string, invocation: string): string {
  return `('${id}', 'org-a', 'store-a', 'connection-a', 'source-run-a',
    'evidence-run-a', 'klaviyo-v1', 'scope-fp-${id}', '${invocation}',
    'published', now() - interval '90 day', now(), now() - interval '90 day',
    now(), 'src-checksum', 'ev-checksum', 'rule-checksum', 'config-checksum',
    1, 1, 1, 1, 1, now(), now(), now())`;
}

async function seedBase(): Promise<void> {
  await testPool!.query(
    `INSERT INTO organization (id, name, slug, created_at) VALUES
       ('org-a', 'Org A', 'org-a', now()), ('org-b', 'Org B', 'org-b', now())`,
  );
  await testPool!.query(
    `INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone) VALUES
       ('store-a', 'org-a', 'a.example.com', 'America/New_York'),
       ('store-b', 'org-b', 'b.example.com', 'UTC')`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_connection (id, organization_id, shopify_store_id, klaviyo_account_id) VALUES
       ('connection-a', 'org-a', 'store-a', 'account-a'),
       ('connection-b', 'org-b', 'store-b', 'account-b')`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_metric
       (id, organization_id, shopify_store_id, connection_id, external_metric_id,
        name, canonical_kind, ingestion_enabled, api_revision) VALUES
       ('metric-a', 'org-a', 'store-a', 'connection-a', 'ext-placed',
        'Placed Order', 'placed_order', 1, '2026-07-15'),
       ('metric-b', 'org-b', 'store-b', 'connection-b', 'ext-placed-b',
        'Placed Order', 'placed_order', 1, '2026-07-15')`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_sync_run
       (id, organization_id, shopify_store_id, connection_id, operation,
        trigger_type, status, request_parameters) VALUES
       ('source-run-a', 'org-a', 'store-a', 'connection-a', 'events', 'manual',
        'success', '{"sourceMode":"order_core","metricKinds":["placed_order","ordered_product"]}'),
       ('source-run-b', 'org-b', 'store-b', 'connection-b', 'events', 'manual',
        'success', '{"sourceMode":"order_core","metricKinds":["placed_order","ordered_product"]}')`,
  );
  await testPool!.query(
    `INSERT INTO shopify_evidence_sync_run
       (id, start_trigger_run_id, organization_id, store_id, mode, store_timezone,
        anchor_store_day, requested_from, requested_to, status) VALUES
       ('evidence-run-a', 'trigger-a', 'org-a', 'store-a', 'initial_90d',
        'America/New_York', '2026-08-05', now() - interval '90 day', now(), 'success'),
       ('evidence-run-b', 'trigger-b', 'org-b', 'store-b', 'initial_90d',
        'UTC', '2026-08-05', now() - interval '90 day', now(), 'success')`,
  );
  for (const [event, org, store, connection, metric] of [
    ["event-a", "org-a", "store-a", "connection-a", "metric-a"],
    ["event-po", "org-a", "store-a", "connection-a", "metric-a"],
    ["event-b", "org-b", "store-b", "connection-b", "metric-b"],
  ]) {
    await testPool!.query(
      `INSERT INTO klaviyo_event
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          external_event_id, occurred_at, attribution_relationship_ids,
          redacted_properties, key_type_fingerprint, warnings,
          product_evidence_completeness, source_checksum, api_revision)
       VALUES ($1, $2, $3, $4, $5, $6, now(), '[]', '{}', '[]', '[]',
         'complete', 'checksum', '2026-07-15')`,
      [event, org, store, connection, metric, `external-${event}`],
    );
  }
  await testPool!.query(
    `INSERT INTO klaviyo_event_run_observation
       (organization_id, shopify_store_id, connection_id, sync_run_id, event_id,
        observed_source_checksum) VALUES
       ('org-a', 'store-a', 'connection-a', 'source-run-a', 'event-a', 'checksum')`,
  );
  await testPool!.query(
    `INSERT INTO shopify_order
       (id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales) VALUES
       ('order-a', 'org-a', 'store-a', 'shopify-a', now(), current_date, 10),
       ('order-b', 'org-b', 'store-b', 'shopify-b', now(), current_date, 20)`,
  );
  await testPool!.query(
    `INSERT INTO identity_matching_key_binding
       (organization_id, store_id, key_version, key_check) VALUES
       ('org-a', 'store-a', 'v1', 'check-v1'),
       ('org-a', 'store-a', 'v2', 'check-v2')`,
  );
  await testPool!.query(
    `INSERT INTO identity_erasure_suppression
       (id, organization_id, store_id, kind, key_version, digest) VALUES
       ('suppression-a', 'org-a', 'store-a', 'email', 'e1', 'tombstone-a')`,
  );
  await testPool!.query(
    `INSERT INTO source_identity_hmac
       (id, organization_id, store_id, source_kind, klaviyo_connection_id,
        klaviyo_event_id, key_version, digest, rotation_state) VALUES
       ('hmac-klaviyo-a', 'org-a', 'store-a', 'klaviyo_event', 'connection-a',
        'event-a', 'v1', 'digest-a', 'active')`,
  );
}

async function seedMarketingObject(
  id: string,
  connection: "a" | "b",
  objectType: string,
  externalId: string,
  parentId: string | null = null,
): Promise<void> {
  const suffix = connection;
  await testPool!.query(
    `INSERT INTO klaviyo_marketing_object
       (id, organization_id, shopify_store_id, connection_id, object_type,
        external_id, parent_id, name, tracking_projection, source_checksum,
        api_revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Name', '{}', 'checksum', '2026-07-15')`,
    [
      id,
      `org-${suffix}`,
      `store-${suffix}`,
      `connection-${suffix}`,
      objectType,
      externalId,
      parentId,
    ],
  );
}

async function seedReportRun(id: string, status = "running"): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_sync_run
       (id, organization_id, shopify_store_id, connection_id, operation,
        trigger_type, status)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'reports', 'manual', $2)`,
    [id, status],
  );
}

async function seedGeneration(
  id: string,
  syncRunId: string,
  kind: string,
  status: string,
  scopeFingerprint: string,
  refreshFingerprint: string,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_report_generation
       (id, organization_id, shopify_store_id, connection_id, sync_run_id, kind,
        requested_from, requested_to, account_timezone,
        publication_scope_fingerprint, refresh_fingerprint, status,
        published_at, superseded_at)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $2, $3,
       now() - interval '30 day', now(), 'America/New_York', $4, $5, $6,
       CASE WHEN $6::text IN ('current', 'superseded') THEN now() END,
       CASE WHEN $6::text = 'superseded' THEN now() END)`,
    [id, syncRunId, kind, scopeFingerprint, refreshFingerprint, status],
  );
}

async function seedReportFact(
  id: string,
  generationId: string,
  kind: string,
  factFingerprint: string,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_report_fact
       (id, organization_id, shopify_store_id, connection_id, generation_id,
        report_kind, conversion_metric_id, requested_from, requested_to,
        account_timezone, grouping, request_fingerprint, fact_fingerprint,
        conversions, additional_statistics, api_revision, as_of)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $2, $3, 'metric-a',
       now() - interval '30 day', now(), 'America/New_York', '{}', 'req-fp',
       $4, 5, '{}', '2026-07-15', now())`,
    [id, generationId, kind, factFingerprint],
  );
}

async function seedClaimAnchor(): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
     VALUES ${publishedRunValues("run-claims", "invocation-claims")}`,
  );
  await testPool!.query(
    `INSERT INTO klaviyo_event_match_result
       (id, organization_id, shopify_store_id, connection_id, run_id,
        event_id, status, reason_codes, published_at)
     VALUES ('result-claims', 'org-a', 'store-a', 'connection-a', 'run-claims',
       'event-a', 'unmatched', '[]', now())`,
  );
}

describeIfDb("Klaviyo advisory-matching persistence on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    for (const statement of FIXTURE_DDL) await testPool!.query(statement);
    for (const migration of [
      "0053_klaviyo_shopify_evidence.sql",
      "0054_klaviyo_source_core.sql",
      "0055_klaviyo_advisory_matching.sql",
      "0056_klaviyo_claims_reporting.sql",
    ]) {
      for (const statement of migrationStatements(migration)) {
        await testPool!.query(statement);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await testPool?.end();
    if (adminPool) {
      await adminPool.query(
        `DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`,
      );
      await adminPool.end();
    }
  });

  beforeEach(async () => {
    await testPool!.query(
      `TRUNCATE identity_pilot_uninstall_receipt, klaviyo_connection,
         shopify_store, organization RESTART IDENTITY CASCADE`,
    );
    await seedBase();
  });

  it("rejects a Klaviyo digest without exactly one Klaviyo event source", async () => {
    await expectSqlError(
      `INSERT INTO source_identity_hmac
         (id, organization_id, store_id, source_kind, shopify_order_id,
          klaviyo_connection_id, klaviyo_event_id, key_version, digest, rotation_state)
       VALUES ('bad-both', 'org-a', 'store-a', 'klaviyo_event', 'order-a',
         'connection-a', 'event-po', 'v1', 'digest-x', 'active')`,
      ["23514"],
    );
    await expectSqlError(
      `INSERT INTO source_identity_hmac
         (id, organization_id, store_id, source_kind, klaviyo_connection_id,
          key_version, digest, rotation_state)
       VALUES ('bad-missing-event', 'org-a', 'store-a', 'klaviyo_event',
         'connection-a', 'v1', 'digest-y', 'active')`,
      ["23514"],
    );
  });

  it("rejects a Klaviyo digest whose connection/event scope disagrees", async () => {
    await expectSqlError(
      `INSERT INTO source_identity_hmac
         (id, organization_id, store_id, source_kind, klaviyo_connection_id,
          klaviyo_event_id, key_version, digest, rotation_state)
       VALUES ('bad-cross', 'org-a', 'store-a', 'klaviyo_event', 'connection-a',
         'event-b', 'v1', 'digest-z', 'active')`,
      ["23503"],
    );
  });

  it("rejects a Klaviyo identity observation outside its exact source run event or digest scope", async () => {
    await expectSqlError(
      `INSERT INTO klaviyo_event_run_identity_observation
         (organization_id, shopify_store_id, connection_id, sync_run_id,
          event_id, identity_hmac_id)
       VALUES ('org-a', 'store-a', 'connection-a', 'source-run-a', 'event-po',
         'hmac-klaviyo-a')`,
      ["23503"],
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_run_identity_observation
         (organization_id, shopify_store_id, connection_id, sync_run_id,
          event_id, identity_hmac_id)
       VALUES ('org-a', 'store-a', 'connection-a', 'source-run-a', 'event-a',
         'hmac-klaviyo-a')`,
    );
  });

  it("rejects a candidate edge outside its match-run connection", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-pub", "invocation-1")}`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_match_candidate
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, order_id, candidate_class, method, feature_vector,
          weights, tolerances, score, confidence, reason_codes)
       VALUES ('cand-cross', 'org-b', 'store-b', 'connection-b', 'run-pub',
         'event-b', 'order-b', 'deterministic', 'order_id', '{}', '{}', '{}',
         10, 1, '[]')`,
      ["23503"],
    );
  });

  it("rejects a match run whose source run is outside its exact scope", async () => {
    await expectSqlError(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-bad-source", "invocation-2").replace(
         "'source-run-a'",
         "'source-run-b'",
       )}`,
      ["23503"],
    );
  });

  it("rejects a match run whose Shopify evidence run is outside its store scope", async () => {
    await expectSqlError(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-bad-evidence", "invocation-3").replace(
         "'evidence-run-a'",
         "'evidence-run-b'",
       )}`,
      ["23503"],
    );
  });

  it("rejects running or malformed terminal match runs", async () => {
    await expectSqlError(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-running", "invocation-4").replace(
         "'published'",
         "'running'",
       )}`,
      ["23514"],
    );
    await expectSqlError(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-no-checksum", "invocation-5").replace(
         "'src-checksum'",
         "null",
       )}`,
      ["23514"],
    );
    await expectSqlError(
      `INSERT INTO klaviyo_match_run
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          shopify_evidence_run_id, matcher_version, publication_scope_fingerprint,
          invocation_fingerprint, status, failure_code, published_at,
          started_at, completed_at)
       VALUES ('run-failed-published', 'org-a', 'store-a', 'connection-a',
         'source-run-a', 'evidence-run-a', 'klaviyo-v1', 'scope-x',
         'invocation-6', 'failed', 'MATCH_FAILED', now(), now(), now())`,
      ["23514"],
    );
  });

  it("allows failed attempts no results and excludes them from current publication", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_match_run
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          shopify_evidence_run_id, matcher_version, publication_scope_fingerprint,
          invocation_fingerprint, status, failure_code, started_at, completed_at)
       VALUES ('run-failed', 'org-a', 'store-a', 'connection-a', 'source-run-a',
         'evidence-run-a', 'klaviyo-v1', 'scope-f', 'invocation-7', 'failed',
         'MATCH_FAILED', now(), now())`,
    );
    const current = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_event_match_result r
        JOIN klaviyo_match_run m ON m.id = r.run_id
       WHERE m.status <> 'published'`,
    );
    expect(current.rows[0].count).toBe(0);
  });

  it("rejects candidates or results attached to a failed match run", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_match_run
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          shopify_evidence_run_id, matcher_version, publication_scope_fingerprint,
          invocation_fingerprint, status, failure_code, started_at, completed_at)
       VALUES ('run-failed-2', 'org-a', 'store-a', 'connection-a', 'source-run-a',
         'evidence-run-a', 'klaviyo-v1', 'scope-f2', 'invocation-8', 'failed',
         'MATCH_FAILED', now(), now())`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_match_candidate
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, order_id, candidate_class, method, feature_vector,
          weights, tolerances, score, confidence, reason_codes)
       VALUES ('cand-on-failed', 'org-a', 'store-a', 'connection-a',
         'run-failed-2', 'event-a', 'order-a', 'deterministic', 'order_id',
         '{}', '{}', '{}', 10, 1, '[]')`,
      ["23503"],
    );
    await expectSqlError(
      `INSERT INTO klaviyo_match_candidate
         (id, organization_id, shopify_store_id, connection_id, run_id,
          run_status, event_id, order_id, candidate_class, method,
          feature_vector, weights, tolerances, score, confidence, reason_codes)
       VALUES ('cand-failed-status', 'org-a', 'store-a', 'connection-a',
         'run-failed-2', 'failed', 'event-a', 'order-a', 'deterministic',
         'order_id', '{}', '{}', '{}', 10, 1, '[]')`,
      ["23514"],
    );
  });

  it("allows failed attempts to share a fingerprint but one published run only", async () => {
    for (const id of ["retry-1", "retry-2"]) {
      await testPool!.query(
        `INSERT INTO klaviyo_match_run
           (id, organization_id, shopify_store_id, connection_id, source_run_id,
            shopify_evidence_run_id, matcher_version, publication_scope_fingerprint,
            invocation_fingerprint, status, failure_code, started_at, completed_at)
         VALUES ($1, 'org-a', 'store-a', 'connection-a', 'source-run-a',
           'evidence-run-a', 'klaviyo-v1', 'scope-r', 'shared-invocation',
           'failed', 'MATCH_FAILED', now(), now())`,
        [id],
      );
    }
    await testPool!.query(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-pub-shared", "shared-invocation")}`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-pub-shared-2", "shared-invocation")}`,
      ["23505"],
    );
  });

  it("publishes a fresh zero-result window without pretending it was superseded", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-zero", "invocation-zero")
         .replace("1, 1, 1, 1, 1", "0, 0, 0, 0, 0")}`,
    );
    const run = await testPool!.query(
      `SELECT superseded_at, expected_order_count FROM klaviyo_match_run
        WHERE id = 'run-zero'`,
    );
    expect(run.rows[0]).toEqual({ superseded_at: null, expected_order_count: 0 });
  });

  it("allows one live identity rotation per connection and snapshots its retained sources", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_identity_rotation_run
         (id, organization_id, shopify_store_id, connection_id, fingerprint,
          current_key_version, current_key_check, previous_key_version,
          previous_key_check, state)
       VALUES ('rotation-a', 'org-a', 'store-a', 'connection-a', 'fp-1',
         'v2', 'check-v2', 'v1', 'check-v1', 'preparing')`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_identity_rotation_run
         (id, organization_id, shopify_store_id, connection_id, fingerprint,
          current_key_version, current_key_check, previous_key_version,
          previous_key_check, state)
       VALUES ('rotation-dup', 'org-a', 'store-a', 'connection-a', 'fp-2',
         'v2', 'check-v2', 'v1', 'check-v1', 'dual_write')`,
      ["23505"],
    );
    await testPool!.query(
      `INSERT INTO klaviyo_identity_rotation_source
         (id, organization_id, shopify_store_id, connection_id, rotation_id,
          source_snapshot_id, kind, klaviyo_event_id, status)
       VALUES ('member-a', 'org-a', 'store-a', 'connection-a', 'rotation-a',
         'snapshot-a', 'klaviyo_event', 'event-a', 'pending')`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_identity_rotation_source
         (id, organization_id, shopify_store_id, connection_id, rotation_id,
          source_snapshot_id, kind, klaviyo_event_id, status)
       VALUES ('member-dup', 'org-a', 'store-a', 'connection-a', 'rotation-a',
         'snapshot-dup', 'klaviyo_event', 'event-a', 'pending')`,
      ["23505"],
    );
  });

  it("keeps rotation memberships valid across suppression and compliance release", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_identity_rotation_run
         (id, organization_id, shopify_store_id, connection_id, fingerprint,
          current_key_version, current_key_check, previous_key_version,
          previous_key_check, state)
       VALUES ('rotation-m', 'org-a', 'store-a', 'connection-a', 'fp-m',
         'v2', 'check-v2', 'v1', 'check-v1', 'complete')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_identity_rotation_source
         (id, organization_id, shopify_store_id, connection_id, rotation_id,
          source_snapshot_id, kind, klaviyo_event_id, status)
       VALUES ('member-m', 'org-a', 'store-a', 'connection-a', 'rotation-m',
         'snapshot-m', 'klaviyo_event', 'event-a', 'pending')`,
    );
    await testPool!.query(
      `UPDATE klaviyo_identity_rotation_source
          SET klaviyo_event_id = NULL, suppression_id = 'suppression-a',
              status = 'suppressed'
        WHERE id = 'member-m'`,
    );
    await expectSqlError(
      `DELETE FROM identity_erasure_suppression WHERE id = 'suppression-a'`,
      ["23503"],
    );
    await testPool!.query(
      `UPDATE klaviyo_identity_rotation_source
          SET suppression_id = NULL, status = 'released', released_at = now()
        WHERE id = 'member-m'`,
    );
    await testPool!.query(
      `DELETE FROM identity_erasure_suppression WHERE id = 'suppression-a'`,
    );
    await expectSqlError(
      `UPDATE klaviyo_identity_rotation_source
          SET status = 'suppressed', released_at = NULL
        WHERE id = 'member-m'`,
      ["23514"],
    );
  });

  it("retains a scoped completed uninstall receipt after connection cascade", async () => {
    await testPool!.query(
      `INSERT INTO identity_pilot_uninstall_receipt
         (id, organization_id, store_id, former_connection_id, prior_mode,
          resulting_current_key_version, resulting_current_key_check,
          completed_at)
       VALUES ('receipt-a', 'org-a', 'store-a', 'connection-a', 'dual',
         'v2', 'check-v2', now())`,
    );
    await testPool!.query(
      `INSERT INTO identity_pilot_uninstall_retired_key
         (organization_id, store_id, receipt_id, resulting_current_key_version,
          retired_key_version)
       VALUES ('org-a', 'store-a', 'receipt-a', 'v2', 'v1')`,
    );
    await testPool!.query(
      `DELETE FROM klaviyo_connection WHERE id = 'connection-a'`,
    );
    const receipt = await testPool!.query(
      `SELECT count(*)::int AS count FROM identity_pilot_uninstall_receipt
        WHERE id = 'receipt-a'`,
    );
    expect(receipt.rows[0].count).toBe(1);
  });

  it("rejects rebinding a historical matching-key label to a new secret check", async () => {
    await expectSqlError(
      `INSERT INTO identity_matching_key_binding
         (organization_id, store_id, key_version, key_check)
       VALUES ('org-a', 'store-a', 'v1', 'check-different')`,
      ["23505"],
    );
  });

  it("rejects a retired receipt label equal to its resulting current label", async () => {
    await testPool!.query(
      `INSERT INTO identity_pilot_uninstall_receipt
         (id, organization_id, store_id, former_connection_id, prior_mode,
          resulting_current_key_version, resulting_current_key_check,
          completed_at)
       VALUES ('receipt-b', 'org-a', 'store-a', 'connection-a', 'current_only',
         'v2', 'check-v2', now())`,
    );
    await expectSqlError(
      `INSERT INTO identity_pilot_uninstall_retired_key
         (organization_id, store_id, receipt_id, resulting_current_key_version,
          retired_key_version)
       VALUES ('org-a', 'store-a', 'receipt-b', 'v2', 'v2')`,
      ["23514"],
    );
  });

  it("enforces a closed current-only or dual identity-write gate with key checks", async () => {
    await testPool!.query(
      `UPDATE klaviyo_connection
          SET identity_current_key_version = 'v1',
              identity_current_key_check = 'check-v1'
        WHERE id = 'connection-a'`,
    );
    await testPool!.query(
      `UPDATE klaviyo_connection
          SET identity_write_mode = 'dual',
              identity_current_key_version = 'v2',
              identity_current_key_check = 'check-v2',
              identity_previous_key_version = 'v1',
              identity_previous_key_check = 'check-v1'
        WHERE id = 'connection-a'`,
    );
    await expectSqlError(
      `UPDATE klaviyo_connection
          SET identity_previous_key_version = NULL,
              identity_previous_key_check = NULL
        WHERE id = 'connection-a'`,
      ["23514"],
    );
    await expectSqlError(
      `UPDATE klaviyo_connection SET identity_write_mode = 'retired'
        WHERE id = 'connection-a'`,
      ["23514"],
    );
  });

  it("rejects gate bootstrap on a version/secret mismatch or unresolved dual rows", async () => {
    await expectSqlError(
      `UPDATE klaviyo_connection
          SET identity_current_key_version = 'v1',
              identity_current_key_check = 'check-wrong'
        WHERE id = 'connection-a'`,
      ["23503"],
    );
    await expectSqlError(
      `UPDATE klaviyo_connection
          SET identity_write_mode = 'dual',
              identity_current_key_version = 'v1',
              identity_current_key_check = 'check-v1',
              identity_previous_key_version = 'v1',
              identity_previous_key_check = 'check-v1'
        WHERE id = 'connection-a'`,
      ["23514"],
    );
  });

  it("extends erasure suppression only with HMACed Klaviyo profile aliases", async () => {
    await testPool!.query(
      `INSERT INTO identity_erasure_suppression
         (id, organization_id, store_id, kind, key_version, digest)
       VALUES ('suppression-profile', 'org-a', 'store-a', 'klaviyo_profile_id',
         'e1', 'profile-alias-digest')`,
    );
    await expectSqlError(
      `INSERT INTO identity_erasure_suppression
         (id, organization_id, store_id, kind, key_version, digest)
       VALUES ('suppression-bad', 'org-a', 'store-a', 'raw_profile_id',
         'e1', 'anything')`,
      ["22P02"],
    );
  });

  it("rejects confirmed event results without one deterministic edge", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-det", "invocation-det")}`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_match_candidate
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, order_id, candidate_class, method, feature_vector,
          weights, tolerances, score, confidence, reason_codes)
       VALUES ('cand-diag', 'org-a', 'store-a', 'connection-a', 'run-det',
         'event-a', 'order-a', 'diagnostic', 'time_value', '{}', '{}', '{}',
         6, 0.5, '[]')`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_event_match_result
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, status, selected_candidate_id, selected_class,
          reason_codes, published_at)
       VALUES ('result-bad-class', 'org-a', 'store-a', 'connection-a',
         'run-det', 'event-a', 'confirmed', 'cand-diag', 'deterministic',
         '[]', now())`,
      ["23503"],
    );
    await expectSqlError(
      `INSERT INTO klaviyo_event_match_result
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, status, reason_codes, published_at)
       VALUES ('result-no-edge', 'org-a', 'store-a', 'connection-a',
         'run-det', 'event-a', 'confirmed', '[]', now())`,
      ["23514"],
    );
  });

  it("rejects selected edges on ambiguous and unmatched event results", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-amb", "invocation-amb")}`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_match_candidate
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, order_id, candidate_class, method, feature_vector,
          weights, tolerances, score, confidence, reason_codes)
       VALUES ('cand-amb', 'org-a', 'store-a', 'connection-a', 'run-amb',
         'event-a', 'order-a', 'deterministic', 'order_id', '{}', '{}', '{}',
         10, 1, '[]')`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_event_match_result
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, status, selected_candidate_id, selected_class,
          reason_codes, published_at)
       VALUES ('result-amb-edge', 'org-a', 'store-a', 'connection-a',
         'run-amb', 'event-a', 'ambiguous', 'cand-amb', 'deterministic',
         '[]', now())`,
      ["23514"],
    );
  });

  it("allows only one current result per connection and source entity", async () => {
    for (const [run, invocation] of [
      ["run-cur-1", "invocation-cur-1"],
      ["run-cur-2", "invocation-cur-2"],
    ]) {
      await testPool!.query(
        `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
         VALUES ${publishedRunValues(run, invocation)}`,
      );
    }
    await testPool!.query(
      `INSERT INTO klaviyo_event_match_result
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, status, reason_codes, published_at)
       VALUES ('result-cur-1', 'org-a', 'store-a', 'connection-a', 'run-cur-1',
         'event-a', 'unmatched', '[]', now())`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_event_match_result
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, status, reason_codes, published_at)
       VALUES ('result-cur-2', 'org-a', 'store-a', 'connection-a', 'run-cur-2',
         'event-a', 'unmatched', '[]', now())`,
      ["23505"],
    );
    await testPool!.query(
      `UPDATE klaviyo_event_match_result
          SET superseded_at = now(), supersession_reason = 'entity_replaced'
        WHERE id = 'result-cur-1'`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_match_result
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, status, reason_codes, published_at)
       VALUES ('result-cur-3', 'org-a', 'store-a', 'connection-a', 'run-cur-2',
         'event-a', 'unmatched', '[]', now())`,
    );
  });

  it("cascades events, products, links, candidates, and results from a connection", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_match_run ${PUBLISHED_RUN_COLUMNS}
       VALUES ${publishedRunValues("run-cascade", "invocation-cascade")}`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_match_candidate
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, order_id, candidate_class, method, feature_vector,
          weights, tolerances, score, confidence, reason_codes)
       VALUES ('cand-cascade', 'org-a', 'store-a', 'connection-a',
         'run-cascade', 'event-a', 'order-a', 'deterministic', 'order_id',
         '{}', '{}', '{}', 10, 1, '[]')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_match_result
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, status, selected_candidate_id, selected_class,
          reason_codes, published_at)
       VALUES ('result-cascade', 'org-a', 'store-a', 'connection-a',
         'run-cascade', 'event-a', 'confirmed', 'cand-cascade',
         'deterministic', '[]', now())`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_product_evidence_link
         (id, organization_id, shopify_store_id, connection_id, run_id,
          ordered_product_event_id, placed_order_event_id, shopify_order_id,
          method, matcher_version, status, reason_codes)
       VALUES ('link-cascade', 'org-a', 'store-a', 'connection-a',
         'run-cascade', 'event-po', 'event-a', 'order-a', 'deterministic',
         'klaviyo-v1', 'exact', '[]')`,
    );
    await testPool!.query(
      `DELETE FROM klaviyo_connection WHERE id = 'connection-a'`,
    );
    for (const table of [
      "klaviyo_event",
      "klaviyo_event_product",
      "klaviyo_match_run",
      "klaviyo_match_candidate",
      "klaviyo_event_match_result",
      "klaviyo_order_match_result",
      "klaviyo_product_evidence_link",
      "klaviyo_event_run_identity_observation",
    ]) {
      const count = await testPool!.query(
        `SELECT count(*)::int AS count FROM ${table} WHERE connection_id = 'connection-a'`,
      );
      expect(count.rows[0].count).toBe(0);
    }
  });

  it("rejects a marketing object whose parent belongs to another connection", async () => {
    await seedMarketingObject("campaign-b", "b", "campaign", "ext-campaign-b");
    await expectSqlError(
      `INSERT INTO klaviyo_marketing_object
         (id, organization_id, shopify_store_id, connection_id, object_type,
          external_id, parent_id, name, tracking_projection, source_checksum,
          api_revision)
       VALUES ('message-cross', 'org-a', 'store-a', 'connection-a',
         'campaign_message', 'ext-message-x', 'campaign-b', 'Name', '{}',
         'checksum', '2026-07-15')`,
      ["23503"],
    );
  });

  it("deduplicates marketing objects by connection, type, and external id", async () => {
    await seedMarketingObject("campaign-a", "a", "campaign", "ext-shared");
    await expectSqlError(
      `INSERT INTO klaviyo_marketing_object
         (id, organization_id, shopify_store_id, connection_id, object_type,
          external_id, name, tracking_projection, source_checksum, api_revision)
       VALUES ('campaign-dup', 'org-a', 'store-a', 'connection-a', 'campaign',
         'ext-shared', 'Name', '{}', 'checksum', '2026-07-15')`,
      ["23505"],
    );
    await seedMarketingObject("flow-a", "a", "flow", "ext-shared");
  });

  it("allows every unproven claim relationship to remain null", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_attribution_claim
         (id, organization_id, shopify_store_id, connection_id,
          conversion_event_id, klaviyo_attribution_id, unknown_reason_codes,
          source_checksum, api_revision)
       VALUES ('claim-null', 'org-a', 'store-a', 'connection-a', 'event-a',
         'attribution-1', '["relationship_unavailable"]', 'checksum',
         '2026-07-15')`,
    );
    const claim = await testPool!.query(
      `SELECT attributed_interaction_event_id, campaign_object_id,
              flow_object_id, message_object_id, variation_object_id,
              interaction_type, interaction_occurred_at, bot_click
         FROM klaviyo_attribution_claim WHERE id = 'claim-null'`,
    );
    expect(Object.values(claim.rows[0]).every((value) => value === null)).toBe(
      true,
    );
  });

  it("rejects a claim whose conversion event belongs to another connection", async () => {
    await expectSqlError(
      `INSERT INTO klaviyo_attribution_claim
         (id, organization_id, shopify_store_id, connection_id,
          conversion_event_id, klaviyo_attribution_id, unknown_reason_codes,
          source_checksum, api_revision)
       VALUES ('claim-cross', 'org-a', 'store-a', 'connection-a', 'event-b',
         'attribution-2', '[]', 'checksum', '2026-07-15')`,
      ["23503"],
    );
  });

  it("rejects an attributed interaction event outside the claim connection", async () => {
    await expectSqlError(
      `INSERT INTO klaviyo_attribution_claim
         (id, organization_id, shopify_store_id, connection_id,
          conversion_event_id, klaviyo_attribution_id,
          attributed_interaction_event_id, unknown_reason_codes,
          source_checksum, api_revision)
       VALUES ('claim-cross-interaction', 'org-a', 'store-a', 'connection-a',
         'event-a', 'attribution-3', 'event-b', '[]', 'checksum',
         '2026-07-15')`,
      ["23503"],
    );
  });

  it("keeps one scoped replay state per source run match run and conversion event", async () => {
    await seedClaimAnchor();
    await testPool!.query(
      `INSERT INTO klaviyo_claim_replay_state
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          match_run_id, conversion_event_id, source_checksum, status,
          reason_codes, attempted_at, completed_at)
       VALUES ('state-1', 'org-a', 'store-a', 'connection-a', 'source-run-a',
         'run-claims', 'event-a', 'checksum', 'complete', '[]', now(), now())`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_claim_replay_state
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          match_run_id, conversion_event_id, source_checksum, status,
          reason_codes, attempted_at, completed_at)
       VALUES ('state-dup', 'org-a', 'store-a', 'connection-a', 'source-run-a',
         'run-claims', 'event-a', 'checksum', 'complete', '[]', now(), now())`,
      ["23505"],
    );
    await expectSqlError(
      `INSERT INTO klaviyo_claim_replay_state
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          match_run_id, conversion_event_id, source_checksum, status,
          reason_codes, attempted_at, completed_at)
       VALUES ('state-no-anchor', 'org-a', 'store-a', 'connection-a',
         'source-run-a', 'run-claims', 'event-po', 'checksum', 'complete',
         '[]', now(), now())`,
      ["23503"],
    );
  });

  it("keeps one live claim replay graph per connection with a durable checkpoint and lease", async () => {
    await seedClaimAnchor();
    await testPool!.query(
      `INSERT INTO klaviyo_claim_replay_run
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          match_run_id, checkpoint, status)
       VALUES ('graph-1', 'org-a', 'store-a', 'connection-a', 'source-run-a',
         'run-claims', '{"phase":"missing","stage":"idle"}', 'running')`,
    );
    const lease = await testPool!.query(
      `SELECT checkpoint->>'phase' AS phase, heartbeat_at
         FROM klaviyo_claim_replay_run WHERE id = 'graph-1'`,
    );
    expect(lease.rows[0].phase).toBe("missing");
    expect(lease.rows[0].heartbeat_at).not.toBeNull();
    await expectSqlError(
      `INSERT INTO klaviyo_claim_replay_run
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          match_run_id, checkpoint, status)
       VALUES ('graph-dup', 'org-a', 'store-a', 'connection-a', 'source-run-a',
         'run-claims', '{"phase":"missing","stage":"idle"}', 'running')`,
      ["23505"],
    );
    await expectSqlError(
      `UPDATE klaviyo_claim_replay_run SET status = 'success'
        WHERE id = 'graph-1'`,
      ["23514"],
    );
    await testPool!.query(
      `UPDATE klaviyo_claim_replay_run
          SET status = 'success', finished_at = now() WHERE id = 'graph-1'`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_claim_replay_run
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          match_run_id, checkpoint, status)
       VALUES ('graph-2', 'org-a', 'store-a', 'connection-a', 'source-run-a',
         'run-claims', '{"phase":"missing","stage":"idle"}', 'running')`,
    );
  });

  it("preserves replay-state history and claims on incomplete refresh", async () => {
    await seedClaimAnchor();
    await testPool!.query(
      `INSERT INTO klaviyo_attribution_claim
         (id, organization_id, shopify_store_id, connection_id,
          conversion_event_id, klaviyo_attribution_id, unknown_reason_codes,
          source_checksum, api_revision)
       VALUES ('claim-history', 'org-a', 'store-a', 'connection-a', 'event-a',
         'attribution-h', '[]', 'checksum', '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_claim_replay_state
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          match_run_id, conversion_event_id, source_checksum, status,
          reason_codes, attempted_at, completed_at)
       VALUES ('state-history', 'org-a', 'store-a', 'connection-a',
         'source-run-a', 'run-claims', 'event-a', 'checksum', 'complete',
         '[]', now(), now())`,
    );
    await testPool!.query(
      `UPDATE klaviyo_claim_replay_state
          SET status = 'incomplete',
              reason_codes = '["attribution_relationship_truncated"]',
              attempt_count = attempt_count + 1, completed_at = NULL
        WHERE id = 'state-history'`,
    );
    const survivors = await testPool!.query(
      `SELECT
         (SELECT count(*)::int FROM klaviyo_attribution_claim
           WHERE id = 'claim-history') AS claims,
         (SELECT status FROM klaviyo_claim_replay_state
           WHERE id = 'state-history') AS state_status`,
    );
    expect(survivors.rows[0]).toEqual({ claims: 1, state_status: "incomplete" });
  });

  it("keeps tracking settings scoped to their connection and marketing object", async () => {
    await seedMarketingObject("campaign-a", "a", "campaign", "ext-campaign-a");
    await seedMarketingObject(
      "cm-a",
      "a",
      "campaign_message",
      "ext-cm-a",
      "campaign-a",
    );
    await seedMarketingObject("campaign-b", "b", "campaign", "ext-campaign-b");
    await seedMarketingObject(
      "cm-b",
      "b",
      "campaign_message",
      "ext-cm-b",
      "campaign-b",
    );
    await testPool!.query(
      `INSERT INTO klaviyo_tracking_setting
         (id, organization_id, shopify_store_id, connection_id, scope,
          parameter_name, value_mode, api_revision)
       VALUES ('tracking-account', 'org-a', 'store-a', 'connection-a',
         'account', 'utm_source', 'static', '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_tracking_setting
         (id, organization_id, shopify_store_id, connection_id, scope,
          marketing_object_id, marketing_object_type, parameter_name,
          value_mode, api_revision)
       VALUES ('tracking-message', 'org-a', 'store-a', 'connection-a',
         'campaign_message', 'cm-a', 'campaign_message', 'utm_campaign',
         'dynamic', '2026-07-15')`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_tracking_setting
         (id, organization_id, shopify_store_id, connection_id, scope,
          marketing_object_id, marketing_object_type, parameter_name,
          value_mode, api_revision)
       VALUES ('tracking-account-obj', 'org-a', 'store-a', 'connection-a',
         'account', 'cm-a', 'campaign_message', 'utm_source', 'static',
         '2026-07-15')`,
      ["23514"],
    );
    await expectSqlError(
      `INSERT INTO klaviyo_tracking_setting
         (id, organization_id, shopify_store_id, connection_id, scope,
          parameter_name, value_mode, api_revision)
       VALUES ('tracking-message-null', 'org-a', 'store-a', 'connection-a',
         'campaign_message', 'utm_source', 'static', '2026-07-15')`,
      ["23514"],
    );
    await expectSqlError(
      `INSERT INTO klaviyo_tracking_setting
         (id, organization_id, shopify_store_id, connection_id, scope,
          marketing_object_id, marketing_object_type, parameter_name,
          value_mode, api_revision)
       VALUES ('tracking-cross', 'org-a', 'store-a', 'connection-a',
         'campaign_message', 'cm-b', 'campaign_message', 'utm_source',
         'static', '2026-07-15')`,
      ["23503"],
    );
  });

  it("deduplicates report facts by request fingerprint and fact dimensions", async () => {
    await seedReportRun("report-run-1");
    await seedGeneration(
      "generation-1",
      "report-run-1",
      "campaign",
      "staging",
      "scope-campaign",
      "refresh-1",
    );
    await seedReportFact("fact-1", "generation-1", "campaign", "fact-fp-1");
    await expectSqlError(
      `INSERT INTO klaviyo_report_fact
         (id, organization_id, shopify_store_id, connection_id, generation_id,
          report_kind, conversion_metric_id, requested_from, requested_to,
          account_timezone, grouping, request_fingerprint, fact_fingerprint,
          additional_statistics, api_revision, as_of)
       VALUES ('fact-dup', 'org-a', 'store-a', 'connection-a', 'generation-1',
         'campaign', 'metric-a', now() - interval '30 day', now(),
         'America/New_York', '{}', 'req-fp', 'fact-fp-1', '{}', '2026-07-15',
         now())`,
      ["23505"],
    );
    await expectSqlError(
      `INSERT INTO klaviyo_report_fact
         (id, organization_id, shopify_store_id, connection_id, generation_id,
          report_kind, conversion_metric_id, requested_from, requested_to,
          account_timezone, grouping, request_fingerprint, fact_fingerprint,
          additional_statistics, api_revision, as_of)
       VALUES ('fact-kind-mismatch', 'org-a', 'store-a', 'connection-a',
         'generation-1', 'flow', 'metric-a', now() - interval '30 day', now(),
         'America/New_York', '{}', 'req-fp', 'fact-fp-2', '{}', '2026-07-15',
         now())`,
      ["23503"],
    );
  });

  it("exposes report facts only from the current successful generation", async () => {
    await seedReportRun("report-run-old", "success");
    await seedReportRun("report-run-new", "success");
    await seedGeneration(
      "generation-old",
      "report-run-old",
      "campaign",
      "superseded",
      "scope-campaign",
      "refresh-old",
    );
    await seedGeneration(
      "generation-new",
      "report-run-new",
      "campaign",
      "current",
      "scope-campaign",
      "refresh-new",
    );
    await seedReportFact("fact-old", "generation-old", "campaign", "fact-a");
    await seedReportFact("fact-new", "generation-new", "campaign", "fact-a");
    const current = await testPool!.query(
      `SELECT f.id FROM klaviyo_report_fact f
        JOIN klaviyo_report_generation g ON g.id = f.generation_id
       WHERE g.connection_id = 'connection-a'
         AND g.publication_scope_fingerprint = 'scope-campaign'
         AND g.status = 'current'`,
    );
    expect(current.rows).toEqual([{ id: "fact-new" }]);
  });

  it("keeps one current report generation per logical kind scope across asOf refreshes", async () => {
    await seedReportRun("report-run-cur-1", "success");
    await seedReportRun("report-run-cur-2", "success");
    await seedGeneration(
      "generation-cur-1",
      "report-run-cur-1",
      "campaign",
      "current",
      "scope-campaign",
      "refresh-a",
    );
    await expectSqlError(
      `INSERT INTO klaviyo_report_generation
         (id, organization_id, shopify_store_id, connection_id, sync_run_id,
          kind, requested_from, requested_to, account_timezone,
          publication_scope_fingerprint, refresh_fingerprint, status,
          published_at)
       VALUES ('generation-cur-2', 'org-a', 'store-a', 'connection-a',
         'report-run-cur-2', 'campaign', now() - interval '30 day', now(),
         'America/New_York', 'scope-campaign', 'refresh-b', 'current', now())`,
      ["23505"],
    );
    await testPool!.query(
      `UPDATE klaviyo_report_generation
          SET status = 'superseded', superseded_at = now()
        WHERE id = 'generation-cur-1'`,
    );
    await seedGeneration(
      "generation-cur-3",
      "report-run-cur-2",
      "campaign",
      "current",
      "scope-campaign",
      "refresh-b",
    );
  });

  it("allows one staging generation per requested kind in a report sync run", async () => {
    await seedReportRun("report-run-staging");
    await seedGeneration(
      "generation-staging-campaign",
      "report-run-staging",
      "campaign",
      "staging",
      "scope-campaign",
      "refresh-s",
    );
    await seedGeneration(
      "generation-staging-flow",
      "report-run-staging",
      "flow",
      "staging",
      "scope-flow",
      "refresh-s",
    );
    await expectSqlError(
      `INSERT INTO klaviyo_report_generation
         (id, organization_id, shopify_store_id, connection_id, sync_run_id,
          kind, requested_from, requested_to, account_timezone,
          publication_scope_fingerprint, refresh_fingerprint, status)
       VALUES ('generation-staging-dup', 'org-a', 'store-a', 'connection-a',
         'report-run-staging', 'campaign', now() - interval '30 day', now(),
         'America/New_York', 'scope-campaign-2', 'refresh-s2', 'staging')`,
      ["23505"],
    );
  });

  it("stores the connection's nullable last successful report-sync timestamp", async () => {
    const before = await testPool!.query(
      `SELECT last_report_synced_at FROM klaviyo_connection
        WHERE id = 'connection-a'`,
    );
    expect(before.rows[0].last_report_synced_at).toBeNull();
    await testPool!.query(
      `UPDATE klaviyo_connection SET last_report_synced_at = now()
        WHERE id = 'connection-a'`,
    );
    const after = await testPool!.query(
      `SELECT last_report_synced_at FROM klaviyo_connection
        WHERE id = 'connection-a'`,
    );
    expect(after.rows[0].last_report_synced_at).not.toBeNull();
  });

  it("allows one running dimension or report sync per connection and operation", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status)
       VALUES ('dimension-run-1', 'org-a', 'store-a', 'connection-a',
         'dimensions', 'manual', 'running')`,
    );
    await expectSqlError(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status)
       VALUES ('dimension-run-2', 'org-a', 'store-a', 'connection-a',
         'dimensions', 'manual', 'running')`,
      ["23505"],
    );
    await seedReportRun("report-run-parallel");
    await expectSqlError(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status)
       VALUES ('report-run-parallel-2', 'org-a', 'store-a', 'connection-a',
         'reports', 'manual', 'running')`,
      ["23505"],
    );
  });

  it("cascades dimensions, claims, tracking, and reports on organization, store, or connection deletion", async () => {
    await seedClaimAnchor();
    await seedMarketingObject("campaign-a", "a", "campaign", "ext-campaign-a");
    await seedMarketingObject(
      "cm-a",
      "a",
      "campaign_message",
      "ext-cm-a",
      "campaign-a",
    );
    await testPool!.query(
      `INSERT INTO klaviyo_tracking_setting
         (id, organization_id, shopify_store_id, connection_id, scope,
          parameter_name, value_mode, api_revision)
       VALUES ('tracking-cascade', 'org-a', 'store-a', 'connection-a',
         'account', 'utm_source', 'static', '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_attribution_claim
         (id, organization_id, shopify_store_id, connection_id,
          conversion_event_id, klaviyo_attribution_id, campaign_object_id,
          unknown_reason_codes, source_checksum, api_revision)
       VALUES ('claim-cascade', 'org-a', 'store-a', 'connection-a', 'event-a',
         'attribution-cascade', 'campaign-a', '[]', 'checksum', '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_claim_replay_state
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          match_run_id, conversion_event_id, source_checksum, status,
          reason_codes, attempted_at, completed_at)
       VALUES ('state-cascade', 'org-a', 'store-a', 'connection-a',
         'source-run-a', 'run-claims', 'event-a', 'checksum', 'complete',
         '[]', now(), now())`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_claim_replay_run
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          match_run_id, checkpoint, status)
       VALUES ('graph-cascade', 'org-a', 'store-a', 'connection-a',
         'source-run-a', 'run-claims', '{"phase":"missing","stage":"idle"}',
         'running')`,
    );
    await seedReportRun("report-run-cascade");
    await seedGeneration(
      "generation-cascade",
      "report-run-cascade",
      "campaign",
      "staging",
      "scope-cascade",
      "refresh-cascade",
    );
    await seedReportFact(
      "fact-cascade",
      "generation-cascade",
      "campaign",
      "fact-cascade",
    );
    await testPool!.query(
      `DELETE FROM klaviyo_connection WHERE id = 'connection-a'`,
    );
    for (const table of [
      "klaviyo_marketing_object",
      "klaviyo_tracking_setting",
      "klaviyo_attribution_claim",
      "klaviyo_claim_replay_state",
      "klaviyo_claim_replay_run",
      "klaviyo_report_generation",
      "klaviyo_report_fact",
    ]) {
      const count = await testPool!.query(
        `SELECT count(*)::int AS count FROM ${table} WHERE connection_id = 'connection-a'`,
      );
      expect(count.rows[0].count).toBe(0);
    }
  });
});
