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
const TEST_DATABASE = "adsolute_klaviyo_email_attr_test";
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

const evidenceStore = await import("@/lib/shopify-evidence-store");
const { loadEmailAttribution } = await import("@/lib/klaviyo/email-attribution");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;
// seedMatchWorld's order-a sits at 2026-07-20T10:00Z; use a window around July.
const window = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-08-01T00:00:00.000Z"),
};

/**
 * Insert one published match run all result rows can hang off. The
 * terminal-shape check requires every window, checksum, and count column
 * to be populated on a 'published' row.
 */
async function seedPublishedRun(id = "match-run-1"): Promise<void> {
  await testPool!.query(
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

async function seedOrder(
  id: string,
  shopifyOrderId: string,
  netSales: string,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO shopify_order
       (id, organization_id, store_id, shopify_order_id, order_created_at,
        order_day, net_sales)
     VALUES ($1, 'org-a', 'store-a', $2, '2026-07-21T12:00:00Z', '2026-07-21', $3)`,
    [id, shopifyOrderId, netSales],
  );
}

async function seedEvent(id: string, externalEventId: string): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_event
       (id, organization_id, shopify_store_id, connection_id, metric_id,
        external_event_id, occurred_at, explicit_order_id_candidate,
        attribution_relationship_ids, redacted_properties,
        key_type_fingerprint, warnings, product_evidence_completeness,
        source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'metric-placed',
       $2, '2026-07-21T12:05:00Z', NULL, '[]', '{}', '[]', '[]',
       'unavailable', $2 || '-checksum', '2026-07-15')`,
    [id, externalEventId],
  );
}

async function seedOrderResult(
  id: string,
  orderId: string,
  status: string,
  selectedEventId: string | null,
  options?: { runId?: string; supersededAt?: string },
): Promise<void> {
  const runId = options?.runId ?? "match-run-1";
  const supersededAt = options?.supersededAt ?? null;
  // The selection-shape check requires confirmed rows to point at a
  // deterministic candidate edge in the same run; statuses without a
  // selected event must leave all three selection columns null.
  let selectedCandidateId: string | null = null;
  if (selectedEventId !== null) {
    selectedCandidateId = `${id}-cand`;
    await testPool!.query(
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
  await testPool!.query(
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

/** One current campaign-kind report generation all facts hang off. */
async function seedReportGeneration(): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_report_generation
       (id, organization_id, shopify_store_id, connection_id, sync_run_id,
        kind, requested_from, requested_to, account_timezone,
        publication_scope_fingerprint, refresh_fingerprint, status,
        fact_count, published_at)
     VALUES ('report-gen-1', 'org-a', 'store-a', 'connection-a', 'source-run-a',
       'campaign', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z',
       'America/New_York', 'report-scope-fp-1', 'report-refresh-fp-1',
       'current', 0, now())`,
  );
}

/** Facts are unique on (generation_id, fact_fingerprint): one per seed id. */
async function seedReportFact(
  id: string,
  campaignObjectId: string | null,
  conversionValue: string,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_report_fact
       (id, organization_id, shopify_store_id, connection_id, generation_id,
        report_kind, conversion_metric_id, campaign_object_id, requested_from,
        requested_to, account_timezone, grouping, request_fingerprint,
        fact_fingerprint, conversion_value, api_revision, as_of)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'report-gen-1',
       'campaign', 'metric-placed', $2, '2026-07-01T00:00:00Z',
       '2026-08-01T00:00:00Z', 'America/New_York', '{}', $1 || '-req',
       $1 || '-fact', $3, '2026-07-15', '2026-08-01T00:00:00Z')`,
    [id, campaignObjectId, conversionValue],
  );
}

async function seedClaim(input: {
  id: string;
  conversionEventId: string;
  attributionId: string;
  campaignObjectId?: string | null;
  flowObjectId?: string | null;
  interactionOccurredAt?: string | null;
  botClick?: number | null;
}): Promise<void> {
  await testPool!.query(
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

async function seedMarketingObject(
  id: string,
  objectType: "campaign" | "flow",
  name: string,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_marketing_object
       (id, organization_id, shopify_store_id, connection_id, object_type,
        external_id, name, tracking_projection, source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $2, $1 || '-ext', $3,
       '{}', $1 || '-checksum', '2026-07-15')`,
    [id, objectType, name],
  );
}

/**
 * World, on top of seedMatchWorld's order-a (42.50, event-a):
 * - order-a  42.50 confirmed + campaign claim            -> email (campaign)
 * - order-f  30.00 confirmed + flow claim (last touch),
 *            older campaign claim, newer BOT campaign    -> email (flow)
 * - order-b  10.00 confirmed, no claims                  -> no_email_link
 * - order-c  20.00 no current result                     -> not_evaluated
 * - order-d   5.00 no_klaviyo_event                      -> no_klaviyo_event
 * - order-e   7.25 duplicate_conversion_events           -> duplicate_flagged
 * Total 114.75; email 72.50 (campaigns 42.50, flows 30.00).
 */
async function seedAggregateWorld(): Promise<void> {
  await seedPublishedRun();
  await seedMarketingObject("campaign-row-1", "campaign", "Summer Sale");
  await seedMarketingObject("flow-row-1", "flow", "Welcome");

  await seedOrderResult("res-a", "order-a", "confirmed", "event-a");
  await seedClaim({
    id: "claim-a",
    conversionEventId: "event-a",
    attributionId: "attr-a",
    campaignObjectId: "campaign-row-1",
    interactionOccurredAt: "2026-07-20T09:00:00Z",
  });

  await seedOrder("order-f", "9006", "30.00");
  await seedEvent("event-f", "external-event-f");
  await seedOrderResult("res-f", "order-f", "confirmed", "event-f");
  // Flow touch is the latest NON-BOT interaction -> primary.
  await seedClaim({
    id: "claim-f-flow",
    conversionEventId: "event-f",
    attributionId: "attr-f-flow",
    flowObjectId: "flow-row-1",
    interactionOccurredAt: "2026-07-21T11:00:00Z",
  });
  await seedClaim({
    id: "claim-f-camp-old",
    conversionEventId: "event-f",
    attributionId: "attr-f-camp-old",
    campaignObjectId: "campaign-row-1",
    interactionOccurredAt: "2026-07-19T08:00:00Z",
  });
  await seedClaim({
    id: "claim-f-camp-bot",
    conversionEventId: "event-f",
    attributionId: "attr-f-camp-bot",
    campaignObjectId: "campaign-row-1",
    interactionOccurredAt: "2026-07-21T11:30:00Z",
    botClick: 1,
  });

  await seedOrder("order-b", "9002", "10.00");
  await seedEvent("event-b", "external-event-b");
  await seedOrderResult("res-b", "order-b", "confirmed", "event-b");

  await seedOrder("order-c", "9003", "20.00");

  await seedOrder("order-d", "9004", "5.00");
  await seedOrderResult("res-d", "order-d", "no_klaviyo_event", null);

  await seedOrder("order-e", "9005", "7.25");
  await seedOrderResult("res-e", "order-e", "duplicate_conversion_events", null);
}

describeIfDb("Klaviyo email attribution aggregates on PostgreSQL", () => {
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
      `TRUNCATE klaviyo_connection, shopify_store, organization
         RESTART IDENTITY CASCADE`,
    );
    await seedMatchWorld(testPool!, evidenceStore.canonicalContentChecksum);
  });

  it("partitions every order into exactly one bucket and sums to the total", async () => {
    await seedAggregateWorld();
    const summary = await loadEmailAttribution({ scope, window });

    expect(summary.email).toEqual({
      revenue: "72.50",
      orderCount: 2,
      campaignsRevenue: "42.50",
      flowsRevenue: "30.00",
    });
    expect(summary.gaps.noEmailLink).toEqual({ orders: 1, revenue: "10.00" });
    expect(summary.gaps.notEvaluated).toEqual({ orders: 1, revenue: "20.00" });
    expect(summary.gaps.noKlaviyoEvent).toEqual({ orders: 1, revenue: "5.00" });
    expect(summary.gaps.duplicateFlagged).toEqual({ orders: 1, revenue: "7.25" });

    // Partition invariant: bucket revenues sum to the range total.
    const total =
      Number(summary.email.revenue) +
      Number(summary.gaps.noEmailLink.revenue) +
      Number(summary.gaps.notEvaluated.revenue) +
      Number(summary.gaps.noKlaviyoEvent.revenue) +
      Number(summary.gaps.duplicateFlagged.revenue);
    expect(total).toBeCloseTo(114.75, 2);
  });

  it("assigns sources by the last non-bot touch and names them from the graph", async () => {
    await seedAggregateWorld();
    const summary = await loadEmailAttribution({ scope, window });

    expect(summary.sources).toEqual([
      {
        objectId: "campaign-row-1",
        objectType: "campaign",
        name: "Summer Sale",
        orderCount: 1,
        revenue: "42.50",
        klaviyoConversionValue: null,
        klaviyoWindow: null,
      },
      {
        objectId: "flow-row-1",
        objectType: "flow",
        name: "Welcome",
        orderCount: 1,
        revenue: "30.00",
        klaviyoConversionValue: null,
        klaviyoWindow: null,
      },
    ]);
  });

  it("sums multi-send campaign report facts and counts unattributed facts toward the total", async () => {
    await seedAggregateWorld();
    await seedReportGeneration();
    // Two send-date groupings for the same campaign plus one fact Klaviyo
    // reported without a campaign attribution.
    await seedReportFact("fact-1", "campaign-row-1", "60.00");
    await seedReportFact("fact-2", "campaign-row-1", "15.50");
    await seedReportFact("fact-3", null, "4.50");

    const summary = await loadEmailAttribution({ scope, window });

    const campaignSource = summary.sources.find(
      (source) => source.objectId === "campaign-row-1",
    );
    expect(campaignSource?.klaviyoConversionValue).toBe("75.50");
    expect(summary.klaviyoSays?.conversionValue).toBe("80.00");
    // Same generation, so the per-campaign window equals the headline's
    // (asserted relatively: timestamp columns round-trip via local time).
    expect(campaignSource?.klaviyoWindow).toEqual({
      requestedFrom: summary.klaviyoSays?.requestedFrom,
      requestedTo: summary.klaviyoSays?.requestedTo,
      asOf: summary.klaviyoSays?.asOf,
    });
    // The flow source has no campaign report fact to join against.
    const flowSource = summary.sources.find(
      (source) => source.objectId === "flow-row-1",
    );
    expect(flowSource?.klaviyoConversionValue).toBeNull();
  });

  it("ignores superseded results in favor of the current row", async () => {
    await seedPublishedRun("match-run-0");
    await seedPublishedRun();
    await seedMarketingObject("campaign-row-1", "campaign", "Summer Sale");
    // Superseded confirmed result with a qualifying claim...
    await seedOrderResult("res-a-old", "order-a", "confirmed", "event-a", {
      runId: "match-run-0",
      supersededAt: "2026-07-22T00:00:00Z",
    });
    await seedClaim({
      id: "claim-a",
      conversionEventId: "event-a",
      attributionId: "attr-a",
      campaignObjectId: "campaign-row-1",
      interactionOccurredAt: "2026-07-20T09:00:00Z",
    });
    // ...replaced by a current no_klaviyo_event result.
    await seedOrderResult("res-a-new", "order-a", "no_klaviyo_event", null);

    const summary = await loadEmailAttribution({ scope, window });
    expect(summary.email.orderCount).toBe(0);
    expect(summary.gaps.noKlaviyoEvent).toEqual({ orders: 1, revenue: "42.50" });
  });

  it("treats an order whose only claims are bot clicks as not email-linked", async () => {
    await seedPublishedRun();
    await seedMarketingObject("campaign-row-1", "campaign", "Summer Sale");
    await seedOrderResult("res-a", "order-a", "confirmed", "event-a");
    await seedClaim({
      id: "claim-bot-only",
      conversionEventId: "event-a",
      attributionId: "attr-bot",
      campaignObjectId: "campaign-row-1",
      interactionOccurredAt: "2026-07-20T09:00:00Z",
      botClick: 1,
    });
    const summary = await loadEmailAttribution({ scope, window });
    expect(summary.email.orderCount).toBe(0);
    expect(summary.gaps.noEmailLink).toEqual({ orders: 1, revenue: "42.50" });
  });

  it("returns empty aggregates for a window with no orders", async () => {
    const summary = await loadEmailAttribution({
      scope,
      window: {
        from: new Date("2025-01-01T00:00:00.000Z"),
        to: new Date("2025-02-01T00:00:00.000Z"),
      },
    });
    expect(summary.email).toEqual({
      revenue: "0.00",
      orderCount: 0,
      campaignsRevenue: "0.00",
      flowsRevenue: "0.00",
    });
    expect(summary.sources).toEqual([]);
    expect(summary.gaps.notEvaluated).toEqual({ orders: 0, revenue: "0.00" });
  });

  it("aggregates products over email-linked orders with order revenue", async () => {
    await seedAggregateWorld();
    // seedMatchWorld gave order-a line-a: product 77 "Product" qty 2.
    await testPool!.query(
      `INSERT INTO shopify_order_line
         (id, organization_id, store_id, order_id, shopify_line_item_id,
          shopify_product_id, product_title, quantity, parent_order_updated_at)
       VALUES
         ('line-f1', 'org-a', 'store-a', 'order-f', 'li-f1', '77', 'Product', 1, now()),
         ('line-f2', 'org-a', 'store-a', 'order-f', 'li-f2', '99', 'Other Thing', 4, now()),
         ('line-b1', 'org-a', 'store-a', 'order-b', 'li-b1', '77', 'Product', 9, now())`,
    );
    const summary = await loadEmailAttribution({ scope, window });

    // order-b is NOT email-linked; its 9 units never appear.
    expect(summary.products).toEqual([
      {
        productKey: "77",
        title: "Product",
        units: 3,
        orderCount: 2,
        orderRevenue: "72.50",
      },
      {
        productKey: "99",
        title: "Other Thing",
        units: 4,
        orderCount: 1,
        orderRevenue: "30.00",
      },
    ]);
  });

  it("counts non-confirmed placed-order events in range as unmatched", async () => {
    await seedAggregateWorld();
    // No row in this test file ever inserts into klaviyo_event_match_result,
    // so every placed-order event in range is unmatched: event-a
    // (seedMatchWorld), event-f and event-b (seedAggregateWorld), plus the
    // extra stray event-x seeded below. Four total.
    await seedEvent("event-x", "external-event-x");
    const summary = await loadEmailAttribution({ scope, window });
    expect(summary.gaps.unmatchedEvents).toBe(4);
  });
});
