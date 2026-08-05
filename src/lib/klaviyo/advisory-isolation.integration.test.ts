import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_SCOPE,
  applyMatchFixture,
  resolveConnectionString,
  seedMatchWorld,
  withDatabase,
} from "@/lib/klaviyo/match-test-harness";

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_isolation_test";
const testPool = baseConnectionString
  ? new Pool({
      connectionString: withDatabase(baseConnectionString, TEST_DATABASE),
      max: 6,
    })
  : null;
const testDb = testPool ? drizzle(testPool) : null;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const service = await import("@/lib/klaviyo/match-service");
const attribution = await import("@/lib/attribution-queries");
const evidenceStore = await import("@/lib/shopify-evidence-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;
const range = {
  organizationId: scope.organizationId,
  storeId: scope.storeId,
  dateFrom: "2026-07-01",
  dateTo: "2026-07-31",
};

const BUCKETS = [
  "meta",
  "google",
  "klaviyo",
  "tiktok",
  "ai",
  "organic_direct",
  "unattributed",
  "untracked",
] as const;

async function snapshotProduction() {
  const orders = await testPool!.query(
    `SELECT id, shopify_order_id, net_sales, bucket, bucket_rule_version,
            meta_verified, meta_campaign_id, verification_pending
       FROM shopify_order ORDER BY id`,
  );
  const refunds = await testPool!.query(
    `SELECT id, order_id, amount, kind FROM shopify_refund ORDER BY id`,
  );
  const bucketTotals = await attribution.getBucketTotals(range);
  const metaVerified = await attribution.getMetaVerified(range);
  return {
    orders: orders.rows,
    refunds: refunds.rows,
    bucketTotals,
    metaVerified,
  };
}

describeIfDb("Klaviyo advisory isolation on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await applyMatchFixture(testPool!);
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
    await seedMatchWorld(testPool!, evidenceStore.canonicalContentChecksum);
    // Give the matched order a production bucket + Meta verification, and
    // seed one order per remaining bucket with a refund each.
    await testPool!.query(
      `UPDATE shopify_order
          SET bucket = 'klaviyo', bucket_rule_version = 3, meta_verified = false
        WHERE id = 'order-a'`,
    );
    for (const [index, bucket] of BUCKETS.entries()) {
      const id = `order-bucket-${bucket}`;
      await testPool!.query(
        `INSERT INTO shopify_order
           (id, organization_id, store_id, shopify_order_id, order_created_at,
            order_day, net_sales, bucket, bucket_rule_version, meta_verified,
            meta_campaign_id)
         VALUES ($1, 'org-a', 'store-a', $2, '2026-07-1${index % 9}T10:00:00Z',
           $3, $4, $5, 3, $6, $7)`,
        [
          id,
          `bucket-${bucket}`,
          `2026-07-1${index % 9}`,
          (index + 1) * 10,
          bucket,
          bucket === "meta",
          bucket === "meta" ? "campaign-1" : null,
        ],
      );
      await testPool!.query(
        `INSERT INTO shopify_refund
           (id, organization_id, store_id, order_id, shopify_refund_id,
            refund_day, amount, kind)
         VALUES ($1, 'org-a', 'store-a', $2, $3, '2026-07-2${index % 9}', 1.5,
           'refund')`,
        [`refund-${bucket}`, id, `shopify-refund-${bucket}`],
      );
      // Each bucket order needs its evidence observation so success+complete
      // coverage still holds for the evaluated window.
      const [{ stored_text: storedText }] = (
        await testPool!.query(
          `SELECT order_created_at::text AS stored_text
             FROM shopify_order WHERE id = $1`,
          [id],
        )
      ).rows as Array<{ stored_text: string }>;
      const checksum = evidenceStore.canonicalContentChecksum({
        order: {
          id,
          shopifyOrderId: `bucket-${bucket}`,
          orderCreatedAt: new Date(`${storedText.replace(" ", "T")}Z`),
        },
        lines: [],
        lineDisposition: "complete",
        identityDisposition: "unavailable",
      });
      await testPool!.query(
        `INSERT INTO shopify_evidence_run_observation
           (id, organization_id, store_id, evidence_run_id, order_id,
            line_disposition, identity_disposition, observed_content_checksum)
         VALUES ($1, 'org-a', 'store-a', 'evidence-run-a', $2, 'complete',
           'unavailable', $3)`,
        [`obs-${bucket}`, id, checksum],
      );
    }
  });

  it("keeps every production monetary and attribution value byte-for-byte unchanged", async () => {
    const before = await snapshotProduction();

    // Full advisory pipeline: publish, replay, republish from a fresh run.
    const first = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status, checkpoint, request_parameters,
          requested_from, requested_to)
       VALUES ('source-run-b', 'org-a', 'store-a', 'connection-a', 'events',
         'manual', 'success', NULL,
         '{"sourceMode":"order_core","metricKinds":["placed_order","ordered_product"]}',
         '2026-07-01T00:00:00Z', '2026-07-30T00:00:00Z')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_run_observation
         (organization_id, shopify_store_id, connection_id, sync_run_id,
          event_id, observed_source_checksum)
       VALUES ('org-a', 'store-a', 'connection-a', 'source-run-b', 'event-a',
         'event-checksum-a')`,
    );
    const second = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-b",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    expect(second.runId).not.toBe(first.runId);

    const after = await snapshotProduction();
    expect(after).toEqual(before);
  });

  it("has no product revenue or allocated-revenue column in the advisory schema", async () => {
    const columns = await testPool!.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name LIKE 'klaviyo_match%'
            OR table_name LIKE 'klaviyo_event_match%'
            OR table_name LIKE 'klaviyo_order_match%'
            OR table_name LIKE 'klaviyo_product%'
            OR table_name = 'klaviyo_event_product'
            OR table_name = 'shopify_order_line')
          AND (column_name ~* 'revenue|net_sales|price|amount|total|money')`,
    );
    expect(columns.rows).toEqual([]);
  });

  it("never issues UPDATE or DELETE against shopify_order from the match path", async () => {
    // Statement-level trigger that records any mutation of shopify_order.
    await testPool!.query(`
      CREATE TABLE IF NOT EXISTS mutation_audit (table_name text, action text);
      CREATE OR REPLACE FUNCTION record_order_mutation() RETURNS trigger AS $$
      BEGIN
        INSERT INTO mutation_audit VALUES ('shopify_order', TG_OP);
        RETURN NULL;
      END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS shopify_order_mutation_audit ON shopify_order;
      CREATE TRIGGER shopify_order_mutation_audit
        AFTER UPDATE OR DELETE ON shopify_order
        FOR EACH STATEMENT EXECUTE FUNCTION record_order_mutation();
    `);
    await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    const audit = await testPool!.query(`SELECT * FROM mutation_audit`);
    expect(audit.rows).toEqual([]);
    await testPool!.query(
      `DROP TRIGGER IF EXISTS shopify_order_mutation_audit ON shopify_order`,
    );
  });
});
