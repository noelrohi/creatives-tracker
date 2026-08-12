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
// Refunds are windowed separately by store-day strings on refund_day.
const days = { dateFrom: "2026-07-01", dateTo: "2026-07-31" };

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
  options?: { createdAt?: string; orderDay?: string },
): Promise<void> {
  await testPool!.query(
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

async function seedRefund(
  id: string,
  orderId: string,
  refundDay: string,
  amount: string,
): Promise<void> {
  await testPool!.query(
    `INSERT INTO shopify_refund
       (id, organization_id, store_id, order_id, shopify_refund_id,
        refund_day, amount)
     VALUES ($1, 'org-a', 'store-a', $2, $1 || '-shopify', $3, $4)`,
    [id, orderId, refundDay, amount],
  );
}

async function seedEvent(
  id: string,
  externalEventId: string,
  occurredAt = "2026-07-21T12:05:00Z",
): Promise<void> {
  await testPool!.query(
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

/**
 * One event_match_result row, mirroring seedOrderResult's shape guards. Per
 * klaviyo_event_match_result_selection_check, a superseded row (any status)
 * is exempt from the selected-candidate requirement, so only a CURRENT
 * confirmed row needs a backing deterministic candidate. That candidate is
 * anchored to `order-c` (an order with no other candidates in this world)
 * purely to satisfy the candidate table's not-null order_id — it has no
 * bearing on which order the event actually resolves to.
 */
async function seedEventResult(
  id: string,
  eventId: string,
  status: string,
  options?: { runId?: string; supersededAt?: string; anchorOrderId?: string },
): Promise<void> {
  const runId = options?.runId ?? "match-run-1";
  const supersededAt = options?.supersededAt ?? null;
  let selectedCandidateId: string | null = null;
  let selectedClass: string | null = null;
  if (supersededAt === null && status === "confirmed") {
    selectedCandidateId = `${id}-cand`;
    selectedClass = "deterministic";
    await testPool!.query(
      `INSERT INTO klaviyo_match_candidate
         (id, organization_id, shopify_store_id, connection_id, run_id,
          event_id, order_id, candidate_class, method, feature_vector,
          weights, tolerances, score, confidence, reason_codes)
       VALUES ($1, 'org-a', 'store-a', 'connection-a', $2,
         $3, $4, 'deterministic', 'explicit_order_id', '{}', '{}', '{}',
         '1', '1', '[]')`,
      [selectedCandidateId, runId, eventId, options?.anchorOrderId ?? "order-c"],
    );
  }
  // Superseded rows need published_at <= superseded_at and a supersession
  // reason, same as seedOrderResult's rows.
  await testPool!.query(
    `INSERT INTO klaviyo_event_match_result
       (id, organization_id, shopify_store_id, connection_id, run_id, event_id,
        status, selected_candidate_id, selected_class, reason_codes,
        published_at, superseded_at, supersession_reason)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $6, $2,
       $3, $4, $5, '[]', coalesce($7::timestamp, now()), $7, $8)`,
    [
      id,
      eventId,
      status,
      selectedCandidateId,
      selectedClass,
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
    const summary = await loadEmailAttribution({ scope, window, days });

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

  it("nets in-window refunds against the parent order's bucket and source", async () => {
    await seedAggregateWorld();
    // order-a (email-linked via campaign) gives back 5.00 inside the window.
    await seedRefund("refund-a", "order-a", "2026-07-22", "5.00");
    const summary = await loadEmailAttribution({ scope, window, days });

    expect(summary.email).toEqual({
      // 72.50 gross - 5.00 refunded = 67.50; the refund hits the campaign
      // side (42.50 - 5.00 = 37.50) and leaves flows untouched. The two
      // linked orders still both count — refunds move money, not orders.
      revenue: "67.50",
      orderCount: 2,
      campaignsRevenue: "37.50",
      flowsRevenue: "30.00",
    });
    const campaignSource = summary.sources.find(
      (source) => source.objectId === "campaign-row-1",
    );
    expect(campaignSource?.revenue).toBe("37.50");
    expect(campaignSource?.orderCount).toBe(1);

    // Partition invariant survives netting: bucket revenues sum to the
    // overview-style total, 114.75 gross - 5.00 in-window refunds = 109.75.
    const total =
      Number(summary.email.revenue) +
      Number(summary.gaps.noEmailLink.revenue) +
      Number(summary.gaps.notEvaluated.revenue) +
      Number(summary.gaps.noKlaviyoEvent.revenue) +
      Number(summary.gaps.duplicateFlagged.revenue);
    expect(total).toBeCloseTo(109.75, 2);
  });

  it("nets an in-window refund whose parent order is outside the window", async () => {
    await seedAggregateWorld();
    // order-g was placed in June — outside the July window — but is
    // email-linked (confirmed result + flow claim) and gives back 3.00 on
    // an in-window day. Mirroring getBucketTotals, the refund nets against
    // email revenue even though order-g itself never counts.
    await seedOrder("order-g", "9007", "50.00", {
      createdAt: "2026-06-15T12:00:00Z",
      orderDay: "2026-06-15",
    });
    await seedEvent("event-g", "external-event-g");
    await seedOrderResult("res-g", "order-g", "confirmed", "event-g");
    await seedClaim({
      id: "claim-g-flow",
      conversionEventId: "event-g",
      attributionId: "attr-g-flow",
      flowObjectId: "flow-row-1",
      interactionOccurredAt: "2026-06-15T11:00:00Z",
    });
    await seedRefund("refund-g", "order-g", "2026-07-22", "3.00");
    const summary = await loadEmailAttribution({ scope, window, days });

    expect(summary.email).toEqual({
      // 72.50 - 3.00 = 69.50; order-g's 50.00 gross stays out (June), so
      // orderCount holds at 2 and only the flow side drops: 30.00 - 3.00.
      revenue: "69.50",
      orderCount: 2,
      campaignsRevenue: "42.50",
      flowsRevenue: "27.00",
    });
    const flowSource = summary.sources.find(
      (source) => source.objectId === "flow-row-1",
    );
    expect(flowSource?.revenue).toBe("27.00");
    expect(flowSource?.orderCount).toBe(1);
  });

  it("surfaces a refund-only source with zero orders and negative revenue", async () => {
    await seedAggregateWorld();
    // campaign-row-2 has NO in-window orders at all: its only order sits in
    // June, email-linked to it via a confirmed result + campaign claim, and
    // gives back 3.00 on an in-window day. The source must still surface —
    // this exercises the refund-only side of the FULL OUTER JOIN (a LEFT
    // JOIN from orders would silently drop the row and re-break
    // reconciliation).
    await seedMarketingObject("campaign-row-2", "campaign", "Winter Promo");
    await seedOrder("order-h", "9008", "40.00", {
      createdAt: "2026-06-10T12:00:00Z",
      orderDay: "2026-06-10",
    });
    await seedEvent("event-h", "external-event-h");
    await seedOrderResult("res-h", "order-h", "confirmed", "event-h");
    await seedClaim({
      id: "claim-h-camp",
      conversionEventId: "event-h",
      attributionId: "attr-h-camp",
      campaignObjectId: "campaign-row-2",
      interactionOccurredAt: "2026-06-10T11:00:00Z",
    });
    await seedRefund("refund-h", "order-h", "2026-07-24", "3.00");
    const summary = await loadEmailAttribution({ scope, window, days });

    // Ordered by net revenue desc, the refund-only source comes last.
    expect(summary.sources).toEqual([
      expect.objectContaining({ objectId: "campaign-row-1", revenue: "42.50" }),
      expect.objectContaining({ objectId: "flow-row-1", revenue: "30.00" }),
      {
        objectId: "campaign-row-2",
        objectType: "campaign",
        name: "Winter Promo",
        // 0 in-window orders - 3.00 refunded = pure give-back.
        orderCount: 0,
        revenue: "-3.00",
        klaviyoConversionValue: null,
        klaviyoWindow: null,
      },
    ]);

    expect(summary.email).toEqual({
      // 72.50 - 3.00 = 69.50 and 42.50 - 3.00 = 39.50: the headline nets
      // the refund on the campaign side while order-h's 40.00 gross stays
      // out (June), so orderCount holds at 2.
      revenue: "69.50",
      orderCount: 2,
      campaignsRevenue: "39.50",
      flowsRevenue: "30.00",
    });

    // Partition invariant: 114.75 gross - 3.00 in-window refunds = 111.75.
    const total =
      Number(summary.email.revenue) +
      Number(summary.gaps.noEmailLink.revenue) +
      Number(summary.gaps.notEvaluated.revenue) +
      Number(summary.gaps.noKlaviyoEvent.revenue) +
      Number(summary.gaps.duplicateFlagged.revenue);
    expect(total).toBeCloseTo(111.75, 2);
  });

  it("nets a refund on a non-email-linked order against its gap bucket", async () => {
    await seedAggregateWorld();
    // order-b (confirmed but claimless -> no_email_link) gives back 2.00.
    await seedRefund("refund-b", "order-b", "2026-07-23", "2.00");
    const summary = await loadEmailAttribution({ scope, window, days });

    // 10.00 - 2.00 = 8.00; email revenue is untouched.
    expect(summary.gaps.noEmailLink).toEqual({ orders: 1, revenue: "8.00" });
    expect(summary.email.revenue).toBe("72.50");
  });

  it("assigns sources by the last non-bot touch and names them from the graph", async () => {
    await seedAggregateWorld();
    const summary = await loadEmailAttribution({ scope, window, days });

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

    const summary = await loadEmailAttribution({ scope, window, days });

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

    const summary = await loadEmailAttribution({ scope, window, days });
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
    const summary = await loadEmailAttribution({ scope, window, days });
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
      days: { dateFrom: "2025-01-01", dateTo: "2025-01-31" },
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
    // A second, distinct line for the same product on the SAME order
    // (e.g. a separate variant line) must add to units without doubling
    // order-f's revenue — the inner query groups by (product, order) before
    // summing net_sales, so one order contributes its revenue once no
    // matter how many lines of a product it has.
    await testPool!.query(
      `INSERT INTO shopify_order_line
         (id, organization_id, store_id, order_id, shopify_line_item_id,
          shopify_product_id, product_title, quantity, parent_order_updated_at)
       VALUES
         ('line-f3', 'org-a', 'store-a', 'order-f', 'li-f3', '77', 'Product', 2, now())`,
    );
    const summary = await loadEmailAttribution({ scope, window, days });

    // order-b is NOT email-linked; its 9 units never appear.
    expect(summary.products).toEqual([
      {
        productKey: "77",
        title: "Product",
        // 2 (order-a) + 1 (order-f, line-f1) + 2 (order-f, line-f3) = 5;
        // orderCount and orderRevenue are unaffected by the extra line.
        units: 5,
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
    // Before this point, no row in this test file inserts into
    // klaviyo_event_match_result, so every placed-order event in range is
    // unmatched: event-a (seedMatchWorld), event-f and event-b
    // (seedAggregateWorld), plus the extra stray event-x seeded below. Four
    // total.
    await seedEvent("event-x", "external-event-x");
    let summary = await loadEmailAttribution({ scope, window, days });
    expect(summary.gaps.unmatchedEvents).toBe(4);

    // A CURRENT confirmed event-match-result excludes event-b from the
    // count: only 3 remain (a, f, x).
    await seedEventResult("evres-b", "event-b", "confirmed");
    summary = await loadEmailAttribution({ scope, window, days });
    expect(summary.gaps.unmatchedEvents).toBe(3);

    // Symmetry with the order-side "ignores superseded results" test: a
    // SUPERSEDED confirmed result does NOT exclude its event. event-x keeps
    // its confirmed row, but that row is history (superseded_at is not
    // null), so event-x still counts and the total stays 3, not 2.
    await seedPublishedRun("match-run-x");
    await seedEventResult("evres-x-old", "event-x", "confirmed", {
      runId: "match-run-x",
      supersededAt: "2026-07-22T00:00:00Z",
    });
    summary = await loadEmailAttribution({ scope, window, days });
    expect(summary.gaps.unmatchedEvents).toBe(3);

    // A CURRENT non-confirmed result also does NOT exclude its event: event-x
    // gains a current 'ambiguous' row (its only prior row was superseded, so
    // no current-row conflict), and the total stays 3, not 2. This exercises
    // the second arm of `er.status is null or er.status <> 'confirmed'` —
    // dropping that arm would leave only `er.status is null`, which is false
    // here (er.status is 'ambiguous', not null) and would wrongly drop
    // event-x from the count.
    await seedEventResult("evres-x-new", "event-x", "ambiguous");
    summary = await loadEmailAttribution({ scope, window, days });
    expect(summary.gaps.unmatchedEvents).toBe(3);
  });

  it("windows orders and events by UTC wall time regardless of process timezone", async () => {
    // node-postgres serializes a raw Date parameter for a naive timestamp
    // column in the PROCESS's local time; before the utcTimestamp() fix,
    // any off-UTC environment shifted every window boundary by the local
    // offset (live repro: Asia/Manila, +8h — the first 8 hours of orders
    // vanished from the partition). These seeds straddle both edges so a
    // shifted boundary moves money in a direction the assertions catch:
    // under a +8h shift, both in-edge orders fall out and the past-range
    // order falls in, yielding { orders: 2, revenue: "122.50" }.
    await seedOrder("order-edge-in-lo", "9101", "10.00", {
      createdAt: "2026-07-01T00:00:00Z", // exact from-boundary: included
      orderDay: "2026-07-01",
    });
    await seedOrder("order-edge-in-hi", "9102", "20.00", {
      createdAt: "2026-07-01T03:00:00Z", // early window: a +8h shift drops it
      orderDay: "2026-07-01",
    });
    await seedOrder("order-edge-out-lo", "9103", "40.00", {
      createdAt: "2026-06-30T23:59:59Z", // 1s before the range: excluded
      orderDay: "2026-06-30",
    });
    await seedOrder("order-edge-out-hi", "9104", "80.00", {
      createdAt: "2026-08-01T05:00:00Z", // past the range: a +8h shift admits it
      orderDay: "2026-08-01",
    });
    await seedEvent("event-edge-in", "external-event-edge-in", "2026-07-01T03:00:00Z");
    await seedEvent("event-edge-out", "external-event-edge-out", "2026-08-01T05:00:00Z");

    const summary = await loadEmailAttribution({ scope, window, days });
    // order-a (harness, 42.50, mid-window) + the two in-edge orders.
    expect(summary.gaps.notEvaluated).toEqual({ orders: 3, revenue: "72.50" });
    // event-a (harness, mid-window) + event-edge-in only.
    expect(summary.gaps.unmatchedEvents).toBe(2);
  });
});
