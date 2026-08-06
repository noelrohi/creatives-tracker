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
const TEST_DATABASE = "adsolute_klaviyo_queries_test";
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
const queries = await import("@/lib/klaviyo/queries");
const evidenceStore = await import("@/lib/shopify-evidence-store");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;
const window = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-30T00:00:00.000Z"),
};

describeIfDb("Klaviyo evidence queries on PostgreSQL", () => {
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
    await service.computeAndPublishMatches({
      scope,
      sourceRunId: "source-run-a",
      shopifyEvidenceRunId: "evidence-run-a",
    });
    // A second order arriving after publication: genuinely not evaluated.
    await testPool!.query(
      `INSERT INTO shopify_order
         (id, organization_id, store_id, shopify_order_id, order_created_at,
          order_day, net_sales)
       VALUES ('order-b', 'org-a', 'store-a', '9002',
         '2026-07-21T10:00:00Z', '2026-07-21', 10)`,
    );
  });

  it("counts coverage including explicit not_evaluated on both sides", async () => {
    const coverage = await queries.loadEvidenceCoverage({ scope, window });
    expect(coverage.orders).toEqual({ confirmed: 1, not_evaluated: 1 });
    expect(coverage.events).toEqual({ confirmed: 1 });
  });

  it("lists the order ledger with left-joined current results", async () => {
    const all = await queries.listEvidenceOrders({ scope, window });
    expect(all.items).toHaveLength(2);
    const byId = new Map(all.items.map((item) => [item.orderId, item]));
    expect(byId.get("order-a")).toMatchObject({
      orderStatus: "confirmed",
      productStatus: "unavailable",
    });
    expect(byId.get("order-b")).toMatchObject({
      orderStatus: "not_evaluated",
      matchRunId: null,
      boundaryWarning: false,
    });

    const notEvaluated = await queries.listEvidenceOrders({
      scope,
      window,
      orderStatus: "not_evaluated",
    });
    expect(notEvaluated.items.map((item) => item.orderId)).toEqual(["order-b"]);
    const confirmed = await queries.listEvidenceOrders({
      scope,
      window,
      orderStatus: "confirmed",
    });
    expect(confirmed.items.map((item) => item.orderId)).toEqual(["order-a"]);
  });

  it("explains an order with candidate edges and selection", async () => {
    const explanation = await queries.loadOrderExplanation({
      scope,
      orderId: "order-a",
    });
    expect(explanation).toMatchObject({
      orderStatus: "confirmed",
      matcherVersion: "klaviyo-v1",
    });
    expect(explanation!.candidates).toHaveLength(1);
    expect(explanation!.candidates[0]).toMatchObject({
      candidateClass: "deterministic",
      selected: true,
    });
    const missing = await queries.loadOrderExplanation({
      scope,
      orderId: "order-nope",
    });
    expect(missing).toBeNull();
    const notEvaluated = await queries.loadOrderExplanation({
      scope,
      orderId: "order-b",
    });
    expect(notEvaluated).toMatchObject({
      orderStatus: "not_evaluated",
      candidates: [],
    });
  });

  it("returns canonical products, diagnostic candidate rows, and NOT_FOUND", async () => {
    const canonical = await queries.loadOrderProducts({
      scope,
      orderId: "order-a",
    });
    expect(canonical).toMatchObject({
      kind: "canonical",
      productStatus: "unavailable",
    });

    const explanation = await queries.loadOrderExplanation({
      scope,
      orderId: "order-a",
    });
    const candidateId = explanation!.candidates[0].candidateId;
    const diagnostic = await queries.loadOrderProducts({
      scope,
      orderId: "order-a",
      candidateId,
    });
    expect(diagnostic.kind).toBe("diagnostic");
    expect(JSON.stringify(diagnostic)).not.toContain('"productStatus"');

    const wrongOrder = await queries.loadOrderProducts({
      scope,
      orderId: "order-b",
      candidateId,
    });
    expect(wrongOrder.kind).toBe("not_found");

    // Superseding the requested order's result makes its candidate
    // inaccessible even though the run row still exists.
    await testPool!.query(
      `UPDATE klaviyo_order_match_result
          SET superseded_at = now(), supersession_reason = 'entity_replaced'
        WHERE order_id = 'order-a'`,
    );
    const afterSupersede = await queries.loadOrderProducts({
      scope,
      orderId: "order-a",
      candidateId,
    });
    expect(afterSupersede.kind).toBe("not_found");
  });

  it("lists unmatched events symmetrically with the read-union filter", async () => {
    // Default ledger excludes the confirmed event.
    const defaultLedger = await queries.listUnmatchedEvents({ scope, window: {
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-30T00:00:00.000Z"),
    } });
    expect(defaultLedger.items).toHaveLength(0);

    // Supersede the event result with an incident boundary: the event
    // becomes API-only not_evaluated with a boundary warning.
    await testPool!.query(
      `UPDATE klaviyo_event_match_result
          SET superseded_at = now(),
              supersession_reason = 'incident_edge_boundary',
              selected_candidate_id = NULL, selected_class = NULL
        WHERE event_id = 'event-a'`,
    );
    const afterBoundary = await queries.listUnmatchedEvents({
      scope,
      window,
      eventStatus: "not_evaluated",
    });
    expect(afterBoundary.items).toEqual([
      expect.objectContaining({
        eventId: "event-a",
        eventStatus: "not_evaluated",
        boundaryWarning: true,
      }),
    ]);
  });

  it("never mutates results and never leaks identity material", async () => {
    const before = await testPool!.query(
      `SELECT count(*)::int AS results FROM klaviyo_order_match_result`,
    );
    const ledger = await queries.listEvidenceOrders({ scope, window });
    const explanation = await queries.loadOrderExplanation({
      scope,
      orderId: "order-a",
    });
    const after = await testPool!.query(
      `SELECT count(*)::int AS results FROM klaviyo_order_match_result`,
    );
    expect(after.rows[0].results).toBe(before.rows[0].results);
    const serialized = JSON.stringify({ ledger, explanation });
    expect(serialized).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(serialized).not.toContain("digest");
  });

  it("returns canonical claim chains with nullable named nodes and replay freshness", async () => {
    await testPool!.query(
      `INSERT INTO klaviyo_marketing_object
         (id, organization_id, shopify_store_id, connection_id, object_type,
          external_id, name, tracking_projection, source_checksum, api_revision)
       VALUES ('campaign-row-1', 'org-a', 'store-a', 'connection-a',
         'campaign', 'campaign-ext-1', 'Summer Sale', '{}', 'checksum',
         '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_attribution_claim
         (id, organization_id, shopify_store_id, connection_id,
          conversion_event_id, klaviyo_attribution_id, campaign_object_id,
          interaction_type, interaction_host, interaction_path,
          unknown_reason_codes, source_checksum, api_revision)
       VALUES ('claim-1', 'org-a', 'store-a', 'connection-a', 'event-a',
         'attribution-1', 'campaign-row-1', 'click', 'shop.example.com',
         '/products/x', '["message_unknown"]', 'checksum', '2026-07-15')`,
    );
    const run = await testPool!.query(
      `SELECT run_id FROM klaviyo_order_match_result
        WHERE order_id = 'order-a' AND superseded_at IS NULL`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_claim_replay_state
         (id, organization_id, shopify_store_id, connection_id, source_run_id,
          match_run_id, conversion_event_id, source_checksum, status,
          reason_codes, attempted_at)
       VALUES ('state-1', 'org-a', 'store-a', 'connection-a', 'source-run-a',
         $1, 'event-a', 'event-checksum-a', 'incomplete',
         '["attribution_relationship_truncated"]', now())`,
      [run.rows[0].run_id],
    );
    const claims = await queries.loadOrderClaims({ scope, orderId: "order-a" });
    expect(claims).not.toBeNull();
    if (claims === null || claims.kind === "none") throw new Error("no chain");
    expect(claims.kind).toBe("canonical");
    expect(claims.claims[0]).toMatchObject({
      attributionId: "attribution-1",
      campaign: { id: "campaign-row-1", name: "Summer Sale" },
      flow: null,
      message: null,
      interaction: { type: "click", host: "shop.example.com" },
      unknownReasonCodes: ["message_unknown"],
    });
    expect(claims.replay?.status).toBe("incomplete");
    expect(claims.caveats).toContain("claims_stale_or_incomplete");
    const notEvaluated = await queries.loadOrderClaims({
      scope,
      orderId: "order-b",
    });
    expect(notEvaluated).toEqual({ kind: "none", reason: "order_not_evaluated" });
    const badCandidate = await queries.loadOrderClaims({
      scope,
      orderId: "order-a",
      candidateId: "candidate-from-elsewhere",
    });
    expect(badCandidate).toBeNull();
  });

  it("builds journeys only from canonical journey observations of the exact profile", async () => {
    await testPool!.query(
      `UPDATE klaviyo_event SET profile_id = 'profile-a' WHERE id = 'event-a'`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_metric
         (id, organization_id, shopify_store_id, connection_id,
          external_metric_id, name, canonical_kind, ingestion_enabled, api_revision)
       VALUES ('metric-click', 'org-a', 'store-a', 'connection-a',
         'metric-ext-click', 'Clicked Email', 'clicked_email', 0, '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          external_event_id, occurred_at, profile_id,
          attribution_relationship_ids, redacted_properties,
          key_type_fingerprint, warnings, product_evidence_completeness,
          source_checksum, api_revision)
       VALUES
         ('event-click', 'org-a', 'store-a', 'connection-a', 'metric-click',
          'external-click', '2026-07-20T09:00:00Z', 'profile-a', '[]', '{}',
          '[]', '[]', 'unavailable', 'click-checksum', '2026-07-15'),
         ('event-click-other', 'org-a', 'store-a', 'connection-a',
          'metric-click', 'external-click-other', '2026-07-20T09:30:00Z',
          'profile-other', '[]', '{}', '[]', '[]', 'unavailable',
          'other-checksum', '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status, checkpoint, request_parameters,
          requested_from, requested_to, finished_at)
       VALUES ('journey-run-a', 'org-a', 'store-a', 'connection-a', 'events',
         'manual', 'success', NULL,
         '{"sourceMode":"journey","metricKinds":["clicked_email","clicked_sms","active_on_site","viewed_product","added_to_cart","checkout_started"]}',
         '2026-07-01T00:00:00Z', '2026-07-30T00:00:00Z', now())`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_run_observation
         (organization_id, shopify_store_id, connection_id, sync_run_id,
          event_id, observed_source_checksum)
       VALUES
         ('org-a', 'store-a', 'connection-a', 'journey-run-a', 'event-click',
          'click-checksum'),
         ('org-a', 'store-a', 'connection-a', 'journey-run-a',
          'event-click-other', 'other-checksum')`,
    );
    const journey = await queries.loadOrderJourney({
      scope,
      orderId: "order-a",
      lookbackDays: 7,
    });
    if (journey.kind !== "journey") throw new Error("expected journey");
    expect(journey.label).toBe("same_klaviyo_profile");
    expect(journey.events.map((event) => event.eventRowId)).toEqual([
      "event-click",
    ]);
    expect(JSON.stringify(journey)).not.toContain("profile-a");
    const notEvaluated = await queries.loadOrderJourney({
      scope,
      orderId: "order-b",
      lookbackDays: 7,
    });
    expect(notEvaluated.kind).toBe("none");
  });

  it("excludes checksum-mismatched and failed-run-only journey observations", async () => {
    await testPool!.query(
      `UPDATE klaviyo_event SET profile_id = 'profile-a' WHERE id = 'event-a'`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_metric
         (id, organization_id, shopify_store_id, connection_id,
          external_metric_id, name, canonical_kind, ingestion_enabled, api_revision)
       VALUES ('metric-click', 'org-a', 'store-a', 'connection-a',
         'metric-ext-click', 'Clicked Email', 'clicked_email', 0, '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event
         (id, organization_id, shopify_store_id, connection_id, metric_id,
          external_event_id, occurred_at, profile_id,
          attribution_relationship_ids, redacted_properties,
          key_type_fingerprint, warnings, product_evidence_completeness,
          source_checksum, api_revision)
       VALUES
         ('event-mutated', 'org-a', 'store-a', 'connection-a', 'metric-click',
          'external-mutated', '2026-07-20T09:00:00Z', 'profile-a', '[]', '{}',
          '[]', '[]', 'unavailable', 'newer-checksum', '2026-07-15'),
         ('event-failed-only', 'org-a', 'store-a', 'connection-a',
          'metric-click', 'external-failed-only', '2026-07-20T09:10:00Z',
          'profile-a', '[]', '{}', '[]', '[]', 'unavailable',
          'failed-checksum', '2026-07-15')`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_sync_run
         (id, organization_id, shopify_store_id, connection_id, operation,
          trigger_type, status, checkpoint, request_parameters, finished_at)
       VALUES
         ('journey-run-b', 'org-a', 'store-a', 'connection-a', 'events',
          'manual', 'success', NULL,
          '{"sourceMode":"journey","metricKinds":["clicked_email","clicked_sms","active_on_site","viewed_product","added_to_cart","checkout_started"]}',
          now()),
         ('journey-run-failed', 'org-a', 'store-a', 'connection-a', 'events',
          'manual', 'failed', NULL,
          '{"sourceMode":"journey","metricKinds":["clicked_email","clicked_sms","active_on_site","viewed_product","added_to_cart","checkout_started"]}',
          now())`,
    );
    await testPool!.query(
      `INSERT INTO klaviyo_event_run_observation
         (organization_id, shopify_store_id, connection_id, sync_run_id,
          event_id, observed_source_checksum)
       VALUES
         ('org-a', 'store-a', 'connection-a', 'journey-run-b', 'event-mutated',
          'stale-checksum'),
         ('org-a', 'store-a', 'connection-a', 'journey-run-failed',
          'event-failed-only', 'failed-checksum')`,
    );
    const journey = await queries.loadOrderJourney({
      scope,
      orderId: "order-a",
      lookbackDays: 7,
    });
    if (journey.kind !== "journey") throw new Error("expected journey");
    expect(journey.events).toEqual([]);
  });

  it("projects a redacted inspector without raw journeys, profiles, or reports", async () => {
    await testPool!.query(
      `UPDATE shopify_order
          SET customer_journey = '{"moments":[{"landing_page":"https://x.example/secret?email=a@b.com"}]}',
              last_click_utm_source = 'klaviyo',
              last_click_utm_medium = 'email'
        WHERE id = 'order-a'`,
    );
    await testPool!.query(
      `UPDATE klaviyo_event SET profile_id = 'profile-a' WHERE id = 'event-a'`,
    );
    const inspector = await queries.loadOrderInspector({
      scope,
      orderId: "order-a",
    });
    expect(inspector).not.toBeNull();
    expect(inspector?.order.lastClickUtm).toEqual({
      source: "klaviyo",
      medium: "email",
      campaign: null,
    });
    expect(inspector?.conversionEvent).toMatchObject({
      externalEventId: "external-event-a",
      profile: "present",
    });
    const serialized = JSON.stringify(inspector);
    expect(serialized).not.toContain("profile-a");
    expect(serialized).not.toContain("landing_page");
    expect(serialized).not.toContain("customer_journey");
    expect(serialized).not.toContain("a@b.com");
    const missing = await queries.loadOrderInspector({
      scope,
      orderId: "order-missing",
    });
    expect(missing).toBeNull();
  });

});
