/**
 * Shared disposable-database harness for Plan 3 match integration tests.
 * Test-only module; never imported by production code.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

export function resolveConnectionString(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const match = envFile.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

export function migrationStatements(fileName: string): string[] {
  return readFileSync(path.resolve(process.cwd(), "drizzle", fileName), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export const MATCH_FIXTURE_DDL = [
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

export async function applyMatchFixture(pool: Pool): Promise<void> {
  for (const statement of MATCH_FIXTURE_DDL) await pool.query(statement);
  for (const migration of [
    "0055_klaviyo_shopify_evidence.sql",
    "0056_klaviyo_source_core.sql",
    "0057_klaviyo_advisory_matching.sql",
    "0058_klaviyo_claims_reporting.sql",
    "0074_klaviyo_campaign_ledger.sql",
  ]) {
    for (const statement of migrationStatements(migration)) {
      await pool.query(statement);
    }
  }
}

export const MATCH_SCOPE = {
  organizationId: "org-a",
  storeId: "store-a",
  connectionId: "connection-a",
} as const;

/**
 * Seed one confirmed-matchable world: an order with lines + evidence
 * observation, a placed-order event whose $event_id resolves to it, an
 * approved join rule, and terminal source/evidence runs.
 */
export async function seedMatchWorld(
  pool: Pool,
  contentChecksum: (input: {
    order: { id: string; shopifyOrderId: string; orderCreatedAt: Date };
    lines: Array<{
      shopifyLineItemId: string;
      shopifyProductId: string | null;
      shopifyVariantId: string | null;
      sku: string | null;
      quantity: number;
    }>;
    lineDisposition: "complete" | "preserved_partial";
    identityDisposition: "available" | "unavailable" | "not_refreshed" | "suppressed";
  }) => string,
): Promise<{ orderCreatedAt: Date }> {
  // These columns are naive `timestamp`s holding UTC wall time. A raw Date
  // parameter is serialized by node-postgres in the PROCESS's zone, which
  // would store a different wall time on every machine; interpolate the UTC
  // ISO text so the seeded world is the same under any TZ.
  const orderCreatedAt = new Date("2026-07-20T10:00:00.000Z");
  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-a', 'Org A', 'org-a', now())`,
  );
  await pool.query(
    `INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone)
     VALUES ('store-a', 'org-a', 'a.example.com', 'America/New_York')`,
  );
  await pool.query(
    `INSERT INTO klaviyo_connection (id, organization_id, shopify_store_id, klaviyo_account_id, status)
     VALUES ('connection-a', 'org-a', 'store-a', 'account-a', 'ready')`,
  );
  await pool.query(
    `INSERT INTO klaviyo_metric
       (id, organization_id, shopify_store_id, connection_id, external_metric_id,
        name, canonical_kind, ingestion_enabled, api_revision) VALUES
       ('metric-placed', 'org-a', 'store-a', 'connection-a', 'ext-placed',
        'Placed Order', 'placed_order', 1, '2026-07-15'),
       ('metric-product', 'org-a', 'store-a', 'connection-a', 'ext-product',
        'Ordered Product', 'ordered_product', 1, '2026-07-15')`,
  );
  await pool.query(
    `INSERT INTO klaviyo_sync_run
       (id, organization_id, shopify_store_id, connection_id, operation,
        trigger_type, status, checkpoint, request_parameters,
        requested_from, requested_to) VALUES
       ('source-run-a', 'org-a', 'store-a', 'connection-a', 'events', 'manual',
        'success', NULL,
        '{"sourceMode":"order_core","metricKinds":["placed_order","ordered_product"]}',
        '2026-07-01T00:00:00Z', '2026-07-30T00:00:00Z'),
       ('probe-run-a', 'org-a', 'store-a', 'connection-a', 'probe', 'manual',
        'success', NULL, '{"sampleSize":20}', NULL, NULL)`,
  );
  await pool.query(
    `INSERT INTO klaviyo_probe_report
       (id, organization_id, shopify_store_id, connection_id, sync_run_id,
        sampled_from, sampled_to, sampled_shopify_orders, sampled_klaviyo_events,
        binding_overlap_count, key_type_shapes, identifier_coverage,
        collision_summary, unmatched_summary, unmatched_examples,
        product_coverage, attribution_coverage, redaction_verified, status, checksum)
     VALUES ('probe-a', 'org-a', 'store-a', 'connection-a', 'probe-run-a',
       now() - interval '30 day', now(), 20, 20, 20, '[]', '{}', '{}', '{}',
       '[]', '{}', '{}', 1, 'passed', 'probe-checksum')`,
  );
  await pool.query(
    `INSERT INTO klaviyo_join_rule
       (id, organization_id, shopify_store_id, connection_id, probe_report_id,
        event_kind, source_property, target_namespace, canonicalizer, state,
        observed_populated, observed_collisions, matcher_version)
     VALUES ('rule-a', 'org-a', 'store-a', 'connection-a', 'probe-a',
       'placed_order', '$event_id', 'shopify_order_gid', 'trimmed_exact',
       'approved', 20, 0, 'klaviyo-v1')`,
  );
  await pool.query(
    `INSERT INTO shopify_evidence_sync_run
       (id, start_trigger_run_id, organization_id, store_id, mode,
        store_timezone, anchor_store_day, requested_from, requested_to,
        status, identity_capability, line_completeness) VALUES
       ('evidence-run-a', 'trigger-a', 'org-a', 'store-a', 'initial_90d',
        'America/New_York', '2026-07-30', '2026-07-01T00:00:00Z',
        '2026-07-30T00:00:00Z', 'success', 'unavailable', 'complete')`,
  );
  await pool.query(
    `INSERT INTO shopify_order
       (id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales)
     VALUES ('order-a', 'org-a', 'store-a', '9001', $1, '2026-07-20', 42.5)`,
    [orderCreatedAt.toISOString()],
  );
  await pool.query(
    `INSERT INTO shopify_order_line
       (id, organization_id, store_id, order_id, shopify_line_item_id,
        shopify_product_id, shopify_variant_id, sku, product_title, quantity,
        parent_order_updated_at)
     VALUES ('line-a', 'org-a', 'store-a', 'order-a', 'li-1', '77', '88',
       'SKU-1', 'Product', 2, now())`,
  );
  // Recompute with the Date exactly as drizzle will reparse it: drizzle
  // maps naive timestamps as UTC, so rebuild from the stored text form.
  const [{ stored_text: storedText }] = (
    await pool.query(
      `SELECT order_created_at::text AS stored_text
         FROM shopify_order WHERE id = 'order-a'`,
    )
  ).rows as Array<{ stored_text: string }>;
  const storedCreatedAt = new Date(`${storedText.replace(" ", "T")}Z`);
  const checksum = contentChecksum({
    order: { id: "order-a", shopifyOrderId: "9001", orderCreatedAt: storedCreatedAt },
    lines: [
      {
        shopifyLineItemId: "li-1",
        shopifyProductId: "77",
        shopifyVariantId: "88",
        sku: "SKU-1",
        quantity: 2,
      },
    ],
    lineDisposition: "complete",
    identityDisposition: "unavailable",
  });
  await pool.query(
    `INSERT INTO shopify_evidence_run_observation
       (id, organization_id, store_id, evidence_run_id, order_id,
        line_disposition, identity_disposition, observed_content_checksum)
     VALUES ('obs-order-a', 'org-a', 'store-a', 'evidence-run-a', 'order-a',
       'complete', 'unavailable', $1)`,
    [checksum],
  );
  await pool.query(
    `INSERT INTO klaviyo_event
       (id, organization_id, shopify_store_id, connection_id, metric_id,
        external_event_id, occurred_at, explicit_order_id_candidate,
        attribution_relationship_ids, redacted_properties,
        key_type_fingerprint, warnings, product_evidence_completeness,
        source_checksum, api_revision)
     VALUES ('event-a', 'org-a', 'store-a', 'connection-a', 'metric-placed',
       'external-event-a', $1, '9001', '[]', '{}', '[]', '[]',
       'unavailable', 'event-checksum-a', '2026-07-15')`,
    ["2026-07-20T10:04:00.000Z"],
  );
  await pool.query(
    `INSERT INTO klaviyo_event_run_observation
       (organization_id, shopify_store_id, connection_id, sync_run_id,
        event_id, observed_source_checksum)
     VALUES ('org-a', 'store-a', 'connection-a', 'source-run-a', 'event-a',
       'event-checksum-a')`,
  );
  return { orderCreatedAt };
}

export type SeedOrderOptions = { createdAt?: string; orderDay?: string };

export type SeedOrderResultOptions = { runId?: string; supersededAt?: string };

export type SeedClaimInput = {
  id: string;
  conversionEventId: string;
  attributionId: string;
  campaignObjectId?: string | null;
  flowObjectId?: string | null;
  interactionOccurredAt?: string | null;
  botClick?: number | null;
};

/**
 * Insert one published match run all result rows can hang off. The
 * terminal-shape check requires every window, checksum, and count column
 * to be populated on a 'published' row.
 */
export async function seedPublishedRun(
  pool: Pool,
  id = "match-run-1",
): Promise<void> {
  await pool.query(
    `INSERT INTO klaviyo_match_run
       (id, organization_id, shopify_store_id, connection_id, source_run_id,
        shopify_evidence_run_id, matcher_version, publication_scope_fingerprint,
        invocation_fingerprint, status, started_at, completed_at, published_at,
        event_window_from, event_window_to, shopify_window_from,
        shopify_window_to, klaviyo_source_checksum, shopify_evidence_checksum,
        rule_checksum, config_checksum, expected_order_count,
        expected_event_count, result_order_count, result_event_count,
        candidate_count)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'source-run-a',
       'evidence-run-a', 'klaviyo-v1', $1 || '-scope-fp', $1 || '-invocation-fp',
       'published', now(), now(), now(),
       '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z',
       '2026-08-01T00:00:00Z', 'source-checksum-1', 'evidence-checksum-1',
       'rule-checksum-1', 'config-checksum-1', 0, 0, 0, 0, 0)`,
    [id],
  );
}

export async function seedOrder(
  pool: Pool,
  id: string,
  shopifyOrderId: string,
  netSales: string,
  options?: SeedOrderOptions,
): Promise<void> {
  await pool.query(
    `INSERT INTO shopify_order
       (id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales)
     VALUES ($1, 'org-a', 'store-a', $2, $4, $5, $3)`,
    [
      id,
      shopifyOrderId,
      netSales,
      options?.createdAt ?? "2026-07-21T12:00:00Z",
      options?.orderDay ?? "2026-07-21",
    ],
  );
}

export async function seedRefund(
  pool: Pool,
  id: string,
  orderId: string,
  refundDay: string,
  amount: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO shopify_refund
       (id, organization_id, store_id, order_id, shopify_refund_id,
        refund_day, amount)
     VALUES ($1, 'org-a', 'store-a', $2, $1 || '-shopify', $3, $4)`,
    [id, orderId, refundDay, amount],
  );
}

export async function seedEvent(
  pool: Pool,
  id: string,
  externalEventId: string,
  occurredAt = "2026-07-21T12:05:00Z",
): Promise<void> {
  await pool.query(
    `INSERT INTO klaviyo_event
       (id, organization_id, shopify_store_id, connection_id, metric_id,
        external_event_id, occurred_at, explicit_order_id_candidate,
        attribution_relationship_ids, redacted_properties,
        key_type_fingerprint, warnings, product_evidence_completeness,
        source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'metric-placed',
       $2, $3, NULL, '[]', '{}', '[]', '[]',
       'unavailable', $2 || '-checksum', '2026-07-15')`,
    [id, externalEventId, occurredAt],
  );
}

export async function seedOrderResult(
  pool: Pool,
  id: string,
  orderId: string,
  status: string,
  selectedEventId: string | null,
  options?: SeedOrderResultOptions,
): Promise<void> {
  const runId = options?.runId ?? "match-run-1";
  const supersededAt = options?.supersededAt ?? null;
  // The selection-shape check requires confirmed rows to point at a
  // deterministic candidate edge in the same run; statuses without a
  // selected event must leave all three selection columns null.
  let selectedCandidateId: string | null = null;
  if (selectedEventId !== null) {
    selectedCandidateId = `${id}-cand`;
    await pool.query(
      `INSERT INTO klaviyo_match_candidate
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, order_id, candidate_class, method, feature_vector,
          weights, tolerances, score, confidence, reason_codes)
       VALUES ($1, 'org-a', 'store-a', 'connection-a', $4,
         $2, $3, 'deterministic', 'explicit_order_id', '{}', '{}', '{}',
         '1', '1', '[]')`,
      [selectedCandidateId, selectedEventId, orderId, runId],
    );
  }
  // Superseded rows need published_at <= superseded_at and a supersession
  // reason; they are exempt from the current-row partial unique index but
  // must live in a different run than the current row (run+order unique).
  await pool.query(
    `INSERT INTO klaviyo_order_match_result
       (id, organization_id, shopify_store_id, connection_id, run_id, order_id,
        status, selected_candidate_id, selected_class, selected_event_id,
        reason_codes, matcher_version, published_at, superseded_at,
        supersession_reason)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $7, $2,
       $3, $4, $5, $6, '[]', 'klaviyo-v1', coalesce($8::timestamp, now()),
       $8, $9)`,
    [
      id,
      orderId,
      status,
      selectedCandidateId,
      selectedCandidateId === null ? null : "deterministic",
      selectedEventId,
      runId,
      supersededAt,
      supersededAt === null ? null : "entity_replaced",
    ],
  );
}

export async function seedClaim(
  pool: Pool,
  input: SeedClaimInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO klaviyo_attribution_claim
       (id, organization_id, shopify_store_id, connection_id,
        conversion_event_id, klaviyo_attribution_id, campaign_object_id,
        flow_object_id, interaction_occurred_at, bot_click,
        unknown_reason_codes, source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $2, $3, $4, $5, $6, $7,
       '[]', $1 || '-checksum', '2026-07-15')`,
    [
      input.id,
      input.conversionEventId,
      input.attributionId,
      input.campaignObjectId ?? null,
      input.flowObjectId ?? null,
      input.interactionOccurredAt ?? null,
      input.botClick ?? null,
    ],
  );
}
