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
const TEST_DATABASE = "adsolute_klaviyo_match_repo_test";
const testPool = baseConnectionString
  ? new Pool({
      connectionString: withDatabase(baseConnectionString, TEST_DATABASE),
      max: 8,
    })
  : null;
const testDb = testPool ? drizzle(testPool) : null;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const service = await import("@/lib/klaviyo/match-service");
const repository = await import("@/lib/klaviyo/match-repository");
const evidenceStore = await import("@/lib/shopify-evidence-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;

describeIfDb("Klaviyo match publication on PostgreSQL", () => {
  let adminPool: Pool | null = null;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseConnectionString! });
    // A DROP DATABASE ... WITH (FORCE) from a leftover or concurrent run kills
    // idle clients, which surfaces as a pool-level error; without a listener
    // that crashes the worker even when every assertion passed.
    adminPool.on("error", () => {});
    testPool?.on("error", () => {});
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
  });

  it("publishes one atomic run with confirmed results and replays idempotently", async () => {
    const first = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    expect(first.replayed).toBe(false);
    expect(first.counts).toEqual({ orders: 1, events: 1, candidates: 1 });

    const state = await testPool!.query(
      `SELECT
         (SELECT count(*)::int FROM klaviyo_match_run WHERE status = 'published') AS runs,
         (SELECT status FROM klaviyo_event_match_result LIMIT 1) AS event_status,
         (SELECT status FROM klaviyo_order_match_result LIMIT 1) AS order_status,
         (SELECT product_status FROM klaviyo_order_match_result LIMIT 1) AS product_status`,
    );
    expect(state.rows[0]).toEqual({
      runs: 1,
      event_status: "confirmed",
      order_status: "confirmed",
      product_status: "unavailable",
    });

    const replay = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.runId).toBe(first.runId);
    const counts = await testPool!.query(
      `SELECT (SELECT count(*)::int FROM klaviyo_event_match_result) AS events,
              (SELECT count(*)::int FROM klaviyo_match_candidate) AS candidates`,
    );
    expect(counts.rows[0]).toEqual({ events: 1, candidates: 1 });
  });

  it("elects one winner when two publications race the same invocation", async () => {
    const klaviyo = await service.loadKlaviyoProjection({
      scope,
      sourceRunId: "source-run-a",
    });
    const shopify = await service.loadShopifyProjection({
      scope,
      shopifyEvidenceRunId: "evidence-run-a",
    });
    const rules = await service.loadApprovedRules(scope);
    const { computeAdvisoryMatches } = await import("@/lib/klaviyo/matcher");
    const computation = computeAdvisoryMatches({
      scope,
      currentIdentityKeyVersion: null,
      approvedRules: rules,
      events: klaviyo.events
        .filter((event) => event.metricKind === "placed_order")
        .map((event) => ({
          eventId: event.eventId,
          metricKind: "placed_order" as const,
          occurredAt: event.occurredAt,
          explicitOrderIdCandidate: event.explicitOrderIdCandidate,
          providerUniqueIdCandidate: event.providerUniqueIdCandidate,
          products: [],
          productEvidenceCompleteness: event.productEvidenceCompleteness,
        })),
      orderedProductEvents: [],
      orders: shopify.orders.map((order) => ({
        orderId: order.orderId,
        shopifyNumericOrderId: order.shopifyNumericOrderId,
        orderCreatedAt: order.orderCreatedAt,
        lines: order.lines,
      })),
      identityEqualPairs: [],
      klaviyoSourceChecksum: klaviyo.checksum,
      shopifyEvidenceChecksum: shopify.checksum,
    });
    const fingerprints = service.deriveFingerprints({
      scope,
      klaviyo,
      shopify,
      ruleChecksum: computation.ruleChecksum,
      configChecksum: computation.configChecksum,
    });
    const publish = (runId: string) =>
      repository.publishMatchRun({
        scope,
        runId,
        startedAt: new Date(),
        sourceRunId: "source-run-a",
        shopifyEvidenceRunId: "evidence-run-a",
        publicationScopeFingerprint: fingerprints.publicationScopeFingerprint,
        invocationFingerprint: fingerprints.invocationFingerprint,
        computation,
        expectedOrderIds: shopify.orders.map((order) => order.orderId),
        expectedEventIds: klaviyo.events
          .filter((event) => event.metricKind === "placed_order")
          .map((event) => event.eventId),
      });
    const [left, right] = await Promise.all([
      publish("race-run-1"),
      publish("race-run-2"),
    ]);
    expect(left.runId).toBe(right.runId);
    const runs = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_match_run WHERE status = 'published'`,
    );
    expect(runs.rows[0].count).toBe(1);
  });

  it("keeps failed attempts terminal without touching current results", async () => {
    const published = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    const failed = await repository.publishFailedMatchRun({
      scope,
      runId: "failed-attempt-1",
      startedAt: new Date(),
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
      publicationScopeFingerprint: "scope-x",
      invocationFingerprint: "invocation-x",
      matcherVersion: "klaviyo-v2",
      safeFailureCode: "MATCH_COMPUTATION_FAILED",
    });
    expect(failed).toEqual({ runId: "failed-attempt-1", changed: true });
    const replayFailed = await repository.publishFailedMatchRun({
      scope,
      runId: "failed-attempt-1",
      startedAt: new Date(),
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
      publicationScopeFingerprint: "scope-x",
      invocationFingerprint: "invocation-x",
      matcherVersion: "klaviyo-v2",
      safeFailureCode: "MATCH_COMPUTATION_FAILED",
    });
    expect(replayFailed.changed).toBe(false);
    // It cannot rewrite the published run either.
    const cannotRewrite = await repository.publishFailedMatchRun({
      scope,
      runId: published.runId,
      startedAt: new Date(),
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
      publicationScopeFingerprint: "scope-x",
      invocationFingerprint: "invocation-x",
      matcherVersion: "klaviyo-v2",
      safeFailureCode: "MATCH_PUBLICATION_FAILED",
    });
    expect(cannotRewrite.changed).toBe(false);
    const state = await testPool!.query(
      `SELECT
         (SELECT status FROM klaviyo_match_run WHERE id = 'failed-attempt-1') AS failed_status,
         (SELECT status FROM klaviyo_match_run WHERE id = $1) AS published_status,
         (SELECT count(*)::int FROM klaviyo_event_match_result
           WHERE superseded_at IS NULL) AS current_events`,
      [published.runId],
    );
    expect(state.rows[0]).toEqual({
      failed_status: "failed",
      published_status: "published",
      current_events: 1,
    });
  });

  it("rejects publication when the projection changed and leaves no orphan row", async () => {
    const klaviyo = await service.loadKlaviyoProjection({
      scope,
      sourceRunId: "source-run-a",
    });
    const shopify = await service.loadShopifyProjection({
      scope,
      shopifyEvidenceRunId: "evidence-run-a",
    });
    const { computeAdvisoryMatches } = await import("@/lib/klaviyo/matcher");
    const rules = await service.loadApprovedRules(scope);
    const computation = computeAdvisoryMatches({
      scope,
      currentIdentityKeyVersion: null,
      approvedRules: rules,
      events: [],
      orderedProductEvents: [],
      orders: [],
      identityEqualPairs: [],
      klaviyoSourceChecksum: klaviyo.checksum,
      shopifyEvidenceChecksum: shopify.checksum,
    });
    const fingerprints = service.deriveFingerprints({
      scope,
      klaviyo,
      shopify,
      ruleChecksum: computation.ruleChecksum,
      configChecksum: computation.configChecksum,
    });
    // Mutate the source event after computation: revalidation must fail.
    await testPool!.query(
      `UPDATE klaviyo_event SET source_checksum = 'mutated' WHERE id = 'event-a'`,
    );
    await expect(
      repository.publishMatchRun({
        scope,
        runId: "orphan-check",
        startedAt: new Date(),
        sourceRunId: "source-run-a",
        shopifyEvidenceRunId: "evidence-run-a",
        publicationScopeFingerprint: fingerprints.publicationScopeFingerprint,
        invocationFingerprint: fingerprints.invocationFingerprint,
        computation,
        expectedOrderIds: [],
        expectedEventIds: [],
      }),
    ).rejects.toThrow("stale");
    const orphan = await testPool!.query(
      `SELECT count(*)::int AS count FROM klaviyo_match_run`,
    );
    expect(orphan.rows[0].count).toBe(0);
  });

  it("exposes the matcher's evidence acceptability predicate as a callable verdict", async () => {
    // The incremental supervisor consults this exact predicate before
    // reusing a resumed same-store-day evidence run.
    const before = await service.isEvidenceRunAcceptableForMatching({
      scope,
      shopifyEvidenceRunId: "evidence-run-a",
    });
    expect(before).toEqual({ acceptable: true });

    // Later Shopify ingest mutates an in-window order's line content: the
    // recomputed canonical checksum no longer equals the run's immutable
    // observation — the matcher's shopify_content_mutated rejection.
    await testPool!.query(
      `UPDATE shopify_order_line SET quantity = quantity + 1 WHERE id = 'line-a'`,
    );
    const after = await service.isEvidenceRunAcceptableForMatching({
      scope,
      shopifyEvidenceRunId: "evidence-run-a",
    });
    expect(after).toEqual({
      acceptable: false,
      reason: "shopify_content_mutated",
    });
  });

  it("supersedes direct entities and incident edges then recounts the prior run", async () => {
    const first = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });

    // A fresh source run re-observes the same event (new invocation).
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
    expect(second.replayed).toBe(false);
    expect(second.runId).not.toBe(first.runId);

    const state = await testPool!.query(
      `SELECT
         (SELECT supersession_reason FROM klaviyo_event_match_result
           WHERE run_id = $1) AS old_event_reason,
         (SELECT supersession_reason FROM klaviyo_order_match_result
           WHERE run_id = $1) AS old_order_reason,
         (SELECT superseded_at IS NOT NULL FROM klaviyo_match_run
           WHERE id = $1) AS old_run_superseded,
         (SELECT count(*)::int FROM klaviyo_event_match_result
           WHERE run_id = $2 AND superseded_at IS NULL) AS new_current`,
      [first.runId, second.runId],
    );
    expect(state.rows[0]).toEqual({
      old_event_reason: "entity_replaced",
      old_order_reason: "entity_replaced",
      old_run_superseded: true,
      new_current: 1,
    });
  });

  it("publishes a run whose groups span several insert chunks", async () => {
    // PUBLICATION_INSERT_CHUNK is 500, so 600 extra matchable orders/events
    // (601 with the seeded pair) forces every result group across a chunk
    // boundary — the batched inserts must still write each row exactly once.
    const EXTRA = 600;
    await testPool!.query(
      `INSERT INTO shopify_order
         (id, organization_id, store_id, shopify_order_id, order_created_at,
          order_day, net_sales)
       SELECT 'bulk-order-' || lpad(g::text, 4, '0'), 'org-a', 'store-a',
              (20000 + g)::text,
              timestamp '2026-07-02 00:00:00' + (g * interval '1 hour'),
              (timestamp '2026-07-02 00:00:00' + (g * interval '1 hour'))::date,
              10.0
         FROM generate_series(1, $1) AS g`,
      [EXTRA],
    );
    await testPool!.query(
      `INSERT INTO shopify_order_line
         (id, organization_id, store_id, order_id, shopify_line_item_id,
          shopify_product_id, shopify_variant_id, sku, product_title, quantity,
          parent_order_updated_at)
       SELECT 'bulk-line-' || lpad(g::text, 4, '0'), 'org-a', 'store-a',
              'bulk-order-' || lpad(g::text, 4, '0'), 'bulk-li-' || g,
              '77', '88', 'SKU-1', 'Product', 1, now()
         FROM generate_series(1, $1) AS g`,
      [EXTRA],
    );
    // Checksums must be the canonical ones the projection recomputes, so read
    // the stored timestamps back exactly as drizzle will reparse them.
    const stored = await testPool!.query<{
      id: string;
      shopify_order_id: string;
      stored_text: string;
      shopify_line_item_id: string;
    }>(
      `SELECT o.id, o.shopify_order_id, o.order_created_at::text AS stored_text,
              l.shopify_line_item_id
         FROM shopify_order o
         JOIN shopify_order_line l ON l.order_id = o.id
        WHERE o.id LIKE 'bulk-order-%'
        ORDER BY o.id`,
    );
    expect(stored.rows).toHaveLength(EXTRA);
    const checksums = stored.rows.map((row) =>
      evidenceStore.canonicalContentChecksum({
        order: {
          id: row.id,
          shopifyOrderId: row.shopify_order_id,
          orderCreatedAt: new Date(`${row.stored_text.replace(" ", "T")}Z`),
        },
        lines: [
          {
            shopifyLineItemId: row.shopify_line_item_id,
            shopifyProductId: "77",
            shopifyVariantId: "88",
            sku: "SKU-1",
            quantity: 1,
          },
        ],
        lineDisposition: "complete",
        identityDisposition: "unavailable",
      }),
    );
    await testPool!.query(
      `INSERT INTO shopify_evidence_run_observation
         (id, organization_id, store_id, evidence_run_id, order_id,
          line_disposition, identity_disposition, observed_content_checksum)
       SELECT 'obs-' || t.order_id, 'org-a', 'store-a', 'evidence-run-a',
              t.order_id, 'complete', 'unavailable', t.checksum
         FROM unnest($1::text[], $2::text[]) AS t(order_id, checksum)`,
      [stored.rows.map((row) => row.id), checksums],
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          external_event_id, occurred_at, explicit_order_id_candidate,
          attribution_relationship_ids, redacted_properties,
          key_type_fingerprint, warnings, product_evidence_completeness,
          source_checksum, api_revision)
       SELECT 'bulk-event-' || lpad(g::text, 4, '0'), 'org-a', 'store-a',
              'connection-a', 'metric-placed', 'bulk-external-' || g,
              timestamp '2026-07-02 00:00:00' + (g * interval '1 hour')
                + interval '4 minute',
              (20000 + g)::text, '[]', '{}', '[]', '[]', 'unavailable',
              'bulk-checksum-' || g, '2026-07-15'
         FROM generate_series(1, $1) AS g`,
      [EXTRA],
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_run_observation
         (organization_id, shopify_store_id, connection_id, sync_run_id,
          event_id, observed_source_checksum)
       SELECT 'org-a', 'store-a', 'connection-a', 'source-run-a',
              'bulk-event-' || lpad(g::text, 4, '0'), 'bulk-checksum-' || g
         FROM generate_series(1, $1) AS g`,
      [EXTRA],
    );

    const published = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    expect(published.replayed).toBe(false);
    expect(published.counts).toEqual({
      orders: EXTRA + 1,
      events: EXTRA + 1,
      candidates: EXTRA + 1,
    });

    // Every group crossed the 500-row boundary and landed exactly once.
    const counts = await testPool!.query(
      `SELECT
         (SELECT count(*)::int FROM klaviyo_match_candidate WHERE run_id = $1) AS candidates,
         (SELECT count(*)::int FROM klaviyo_event_match_result WHERE run_id = $1) AS events,
         (SELECT count(*)::int FROM klaviyo_order_match_result WHERE run_id = $1) AS orders,
         (SELECT count(*)::int FROM klaviyo_event_match_result
            WHERE run_id = $1 AND status = 'confirmed') AS confirmed_events,
         (SELECT count(DISTINCT selected_candidate_id)::int
            FROM klaviyo_order_match_result WHERE run_id = $1) AS selected_edges,
         (SELECT status FROM klaviyo_match_run WHERE id = $1) AS run_status`,
      [published.runId],
    );
    expect(counts.rows[0]).toEqual({
      candidates: EXTRA + 1,
      events: EXTRA + 1,
      orders: EXTRA + 1,
      confirmed_events: EXTRA + 1,
      selected_edges: EXTRA + 1,
      run_status: "published",
    });
    // Selected edges resolve to candidates written in earlier chunks, so the
    // generated-ID map stayed intact across the whole batch.
    const dangling = await testPool!.query(
      `SELECT count(*)::int AS count
         FROM klaviyo_order_match_result r
         LEFT JOIN klaviyo_match_candidate c ON c.id = r.selected_candidate_id
        WHERE r.run_id = $1 AND c.id IS NULL`,
      [published.runId],
    );
    expect(dangling.rows[0].count).toBe(0);
  });

  it("keeps a zero-result publication fresh until an exact-scope successor", async () => {
    // Empty world: separate windows containing no orders or events.
    await testPool!.query(
      `UPDATE klaviyo_sync_run
          SET requested_from = '2026-01-01T00:00:00Z',
              requested_to = '2026-01-08T00:00:00Z'
        WHERE id = 'source-run-a'`,
    );
    await testPool!.query(
      `DELETE FROM klaviyo_event_run_observation WHERE sync_run_id = 'source-run-a'`,
    );
    await testPool!.query(
      `UPDATE shopify_evidence_sync_run
          SET requested_from = '2026-01-01T00:00:00Z',
              requested_to = '2026-01-08T00:00:00Z'
        WHERE id = 'evidence-run-a'`,
    );
    await testPool!.query(
      `DELETE FROM shopify_evidence_run_observation WHERE evidence_run_id = 'evidence-run-a'`,
    );
    const zero = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    expect(zero.counts).toEqual({ orders: 0, events: 0, candidates: 0 });
    const fresh = await testPool!.query(
      `SELECT superseded_at FROM klaviyo_match_run WHERE id = $1`,
      [zero.runId],
    );
    expect(fresh.rows[0].superseded_at).toBeNull();

    // A later different invocation with the same logical scope supersedes it.
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status, checkpoint, request_parameters,
          requested_from, requested_to)
       VALUES ('source-run-c', 'org-a', 'store-a', 'connection-a', 'events',
         'manual', 'success', NULL,
         '{"sourceMode":"order_core","metricKinds":["placed_order","ordered_product"]}',
         '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z')`,
    );
    const successor = await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-c",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    expect(successor.runId).not.toBe(zero.runId);
    const superseded = await testPool!.query(
      `SELECT superseded_at FROM klaviyo_match_run WHERE id = $1`,
      [zero.runId],
    );
    expect(superseded.rows[0].superseded_at).not.toBeNull();
  });
});
