// The loaders read naive `timestamp` columns holding UTC wall time, and
// node-postgres parses those in the PROCESS's zone. Pin a non-UTC zone so the
// suite fails if that conversion is ever dropped; CI's TZ=UTC would hide it.
process.env.TZ = "Asia/Bangkok";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_SCOPE,
  type SeedClaimInput,
  type SeedOrderOptions,
  type SeedOrderResultOptions,
  applyMatchFixture,
  resolveConnectionString,
  seedClaim as seedClaimIn,
  seedEvent as seedEventIn,
  seedMatchWorld,
  seedOrder as seedOrderIn,
  seedOrderResult as seedOrderResultIn,
  seedPublishedRun as seedPublishedRunIn,
  seedRefund as seedRefundIn,
  withDatabase,
} from "@/lib/klaviyo/match-test-harness";

const baseConnectionString = resolveConnectionString();
const TEST_DATABASE = "adsolute_klaviyo_ledger_test";
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
const { loadLedgerRows, loadLedgerMessages, loadLedgerDetail } = await import(
  "@/lib/klaviyo/campaign-ledger"
);
const { listEvidenceOrders } = await import("@/lib/klaviyo/queries");
const describeIfDb = baseConnectionString ? describe : describe.skip;

const scope = MATCH_SCOPE;
// seedMatchWorld's order-a sits at 2026-07-20T10:00Z; use a window around July.
const window = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-08-01T00:00:00.000Z"),
};

/**
 * The generic order/event/claim seeds live in the harness, shared with the
 * attribution suite; these bind them to this file's pool.
 */
const seedPublishedRun = (id?: string) => seedPublishedRunIn(testPool!, id);
const seedOrder = (
  id: string,
  shopifyOrderId: string,
  netSales: string,
  options?: SeedOrderOptions,
) => seedOrderIn(testPool!, id, shopifyOrderId, netSales, options);
const seedRefund = (
  id: string,
  orderId: string,
  refundDay: string,
  amount: string,
) => seedRefundIn(testPool!, id, orderId, refundDay, amount);
const seedEvent = (id: string, externalEventId: string, occurredAt?: string) =>
  seedEventIn(testPool!, id, externalEventId, occurredAt);
const seedOrderResult = (
  id: string,
  orderId: string,
  status: string,
  selectedEventId: string | null,
  options?: SeedOrderResultOptions,
) => seedOrderResultIn(testPool!, id, orderId, status, selectedEventId, options);
const seedClaim = (input: SeedClaimInput) => seedClaimIn(testPool!, input);

async function seedObject(input: {
  id: string;
  objectType: "campaign" | "flow" | "campaign_message" | "flow_message";
  name: string;
  parentId?: string | null;
  sentAt?: string | null;
  channel?: string | null;
  subject?: string | null;
}): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_marketing_object
       (id, organization_id, shopify_store_id, connection_id, object_type,
        external_id, parent_id, name, channel, sent_at, subject,
        tracking_projection, source_checksum, api_revision)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $2, $1 || '-ext', $3, $4,
       $5, $6, $7, '{}', $1 || '-checksum', '2026-07-15')`,
    [
      input.id,
      input.objectType,
      input.parentId ?? null,
      input.name,
      input.channel ?? "email",
      input.sentAt ?? null,
      input.subject ?? null,
    ],
  );
}

/**
 * One current generation per kind, covering the July window by default. The
 * nightly only ever produces last-30 windows, so a test can pass a different
 * `reportWindow` to prove the loaders read the newest current generation
 * regardless of what window it covers.
 */
async function seedGeneration(
  kind: string,
  id = `gen-${kind}`,
  publishedAt = "2026-08-02T00:00:00Z",
  syncRunId = "source-run-a",
  reportWindow: { from: string; to: string } = {
    from: "2026-07-01T00:00:00Z",
    to: "2026-08-01T00:00:00Z",
  },
): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_report_generation
       (id, organization_id, shopify_store_id, connection_id, sync_run_id,
        kind, requested_from, requested_to, account_timezone,
        publication_scope_fingerprint, refresh_fingerprint, status,
        fact_count, published_at)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $4, $2,
       $5, $6, 'UTC',
       $1 || '-scope', $1 || '-refresh', 'current', 0, $3)`,
    [id, kind, publishedAt, syncRunId, reportWindow.from, reportWindow.to],
  );
}

/** A second reports run, so two generations of one kind can coexist. */
async function seedReportRun(id: string): Promise<void> {
  await testPool!.query(
    `INSERT INTO klaviyo_sync_run
       (id, organization_id, shopify_store_id, connection_id, operation,
        trigger_type, status, checkpoint, request_parameters,
        requested_from, requested_to)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', 'reports', 'scheduled',
       'success', NULL, '{}', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
    [id],
  );
}

async function seedFact(input: {
  id: string;
  kind: string;
  generationId?: string;
  campaignObjectId?: string | null;
  flowObjectId?: string | null;
  messageObjectId?: string | null;
  stats: Partial<
    Record<
      | "recipients"
      | "delivered"
      | "unique_opens"
      | "unique_clicks"
      | "bounced"
      | "unsubscribes"
      | "spam_complaints"
      | "conversions"
      | "conversion_value",
      string
    >
  >;
}): Promise<void> {
  const s = input.stats;
  await testPool!.query(
    `INSERT INTO klaviyo_report_fact
       (id, organization_id, shopify_store_id, connection_id, generation_id,
        report_kind, conversion_metric_id, campaign_object_id, flow_object_id,
        message_object_id, requested_from, requested_to, account_timezone,
        grouping, request_fingerprint, fact_fingerprint, recipients, delivered,
        unique_opens, unique_clicks, bounced, unsubscribes, spam_complaints,
        conversions, conversion_value, api_revision, as_of)
     VALUES ($1, 'org-a', 'store-a', 'connection-a', $15, $2,
       'metric-placed', $3, $4, $5, '2026-07-01T00:00:00Z',
       '2026-08-01T00:00:00Z', 'UTC', '{}', $1 || '-req', $1 || '-fact',
       $6, $7, $8, $9, $10, $11, $12, $13, $14, '2026-07-15',
       '2026-08-02T00:00:00Z')`,
    [
      input.id,
      input.kind,
      input.campaignObjectId ?? null,
      input.flowObjectId ?? null,
      input.messageObjectId ?? null,
      s.recipients ?? null,
      s.delivered ?? null,
      s.unique_opens ?? null,
      s.unique_clicks ?? null,
      s.bounced ?? null,
      s.unsubscribes ?? null,
      s.spam_complaints ?? null,
      s.conversions ?? null,
      s.conversion_value ?? null,
      input.generationId ?? `gen-${input.kind}`,
    ],
  );
}

/**
 * World on top of seedMatchWorld's order-a (42.50, event-a, created 07-20):
 * - campaign "July Sale" sent 07-10 (in window) with two messages; order-a
 *   (07-20, message m1) and order-late (08-05, OUTSIDE the window) both name it.
 * - campaign "June Blast" sent 06-15 (out of window); order-june names it.
 * - flow "Welcome": order-flow-in (interaction 07-22, in window) and
 *   order-flow-out (interaction 06-30, out of window).
 * - flow "Dormant": no facts, no orders -> never a row.
 * - a 5.00 refund on order-a.
 */
async function seedLedgerWorld(): Promise<void> {
  await seedPublishedRun();
  await seedObject({
    id: "camp-july",
    objectType: "campaign",
    name: "July Sale",
    sentAt: "2026-07-10T09:00:00Z",
  });
  await seedObject({
    id: "msg-a",
    objectType: "campaign_message",
    name: "Variant A",
    parentId: "camp-july",
    subject: "20% off",
  });
  await seedObject({
    id: "msg-b",
    objectType: "campaign_message",
    name: "Variant B",
    parentId: "camp-july",
    subject: "Last call",
  });
  await seedObject({
    id: "camp-june",
    objectType: "campaign",
    name: "June Blast",
    sentAt: "2026-06-15T09:00:00Z",
  });
  await seedObject({ id: "camp-draft", objectType: "campaign", name: "Draft" });
  await seedObject({
    id: "flow-welcome",
    objectType: "flow",
    name: "Welcome",
    channel: null,
  });
  await seedObject({
    id: "flow-dormant",
    objectType: "flow",
    name: "Dormant",
    channel: null,
  });

  await seedOrderResult("res-a", "order-a", "confirmed", "event-a");
  await seedClaim({
    id: "claim-a",
    conversionEventId: "event-a",
    attributionId: "attr-a",
    campaignObjectId: "camp-july",
    interactionOccurredAt: "2026-07-10T10:00:00Z",
  });
  await testPool!.query(
    `UPDATE klaviyo_attribution_claim SET message_object_id = 'msg-a' WHERE id = 'claim-a'`,
  );
  await seedRefund("refund-a", "order-a", "2026-07-25", "5.00");

  await seedOrder("order-late", "9101", "60.00", {
    createdAt: "2026-08-05T12:00:00Z",
    orderDay: "2026-08-05",
  });
  await seedEvent("event-late", "external-event-late", "2026-08-05T12:05:00Z");
  await seedOrderResult("res-late", "order-late", "confirmed", "event-late");
  await seedClaim({
    id: "claim-late",
    conversionEventId: "event-late",
    attributionId: "attr-late",
    campaignObjectId: "camp-july",
    interactionOccurredAt: "2026-07-10T11:00:00Z",
  });
  await testPool!.query(
    `UPDATE klaviyo_attribution_claim SET message_object_id = 'msg-b' WHERE id = 'claim-late'`,
  );

  await seedOrder("order-june", "9102", "15.00", {
    createdAt: "2026-07-02T12:00:00Z",
    orderDay: "2026-07-02",
  });
  await seedEvent("event-june", "external-event-june", "2026-07-02T12:05:00Z");
  await seedOrderResult("res-june", "order-june", "confirmed", "event-june");
  await seedClaim({
    id: "claim-june",
    conversionEventId: "event-june",
    attributionId: "attr-june",
    campaignObjectId: "camp-june",
    interactionOccurredAt: "2026-06-15T10:00:00Z",
  });

  await seedOrder("order-flow-in", "9103", "30.00", {
    createdAt: "2026-07-22T12:00:00Z",
    orderDay: "2026-07-22",
  });
  await seedEvent(
    "event-flow-in",
    "external-event-flow-in",
    "2026-07-22T12:05:00Z",
  );
  await seedOrderResult("res-flow-in", "order-flow-in", "confirmed", "event-flow-in");
  await seedClaim({
    id: "claim-flow-in",
    conversionEventId: "event-flow-in",
    attributionId: "attr-flow-in",
    flowObjectId: "flow-welcome",
    interactionOccurredAt: "2026-07-22T11:00:00Z",
  });

  await seedOrder("order-flow-out", "9104", "25.00", {
    createdAt: "2026-07-03T12:00:00Z",
    orderDay: "2026-07-03",
  });
  await seedEvent(
    "event-flow-out",
    "external-event-flow-out",
    "2026-07-03T12:05:00Z",
  );
  await seedOrderResult(
    "res-flow-out",
    "order-flow-out",
    "confirmed",
    "event-flow-out",
  );
  await seedClaim({
    id: "claim-flow-out",
    conversionEventId: "event-flow-out",
    attributionId: "attr-flow-out",
    flowObjectId: "flow-welcome",
    interactionOccurredAt: "2026-06-30T11:00:00Z",
  });
}

describeIfDb("Klaviyo campaign ledger on PostgreSQL", () => {
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

  it("applies the send-time rule to campaigns and the interaction rule to flows", async () => {
    await seedLedgerWorld();
    const { rows } = await loadLedgerRows({ scope, window });
    const byId = new Map(rows.map((row) => [row.objectId, row]));
    // July Sale: both orders, including the August one; refund-net 42.50 + 60 - 5.
    expect(byId.get("camp-july")).toMatchObject({
      objectType: "campaign",
      name: "July Sale",
      orderCount: 2,
      revenue: "97.50",
      messageCount: 2,
      klaviyo: null,
    });
    expect(byId.get("camp-july")?.sentAt?.toISOString()).toBe(
      "2026-07-10T09:00:00.000Z",
    );
    // Sent in June: not a row, even though an order landed in July.
    expect(byId.has("camp-june")).toBe(false);
    expect(byId.has("camp-draft")).toBe(false);
    // Welcome flow: only the interaction-in-window order.
    expect(byId.get("flow-welcome")).toMatchObject({
      objectType: "flow",
      orderCount: 1,
      revenue: "30.00",
      sentAt: null,
    });
    expect(byId.has("flow-dormant")).toBe(false);
    expect(rows.map((row) => row.objectId)).toEqual(["camp-july", "flow-welcome"]);
  });

  it("joins the current generations and computes rates with Klaviyo's denominators", async () => {
    await seedLedgerWorld();
    await seedGeneration("campaign");
    await seedGeneration("flow");
    await seedFact({
      id: "f1",
      kind: "campaign",
      campaignObjectId: "camp-july",
      stats: {
        recipients: "1000",
        delivered: "990",
        unique_opens: "400",
        unique_clicks: "40",
        unsubscribes: "2",
        bounced: "10",
        spam_complaints: "0",
        conversions: "3",
        conversion_value: "120.00",
      },
    });
    // A second send-date fact for the same campaign sums.
    await seedFact({
      id: "f2",
      kind: "campaign",
      campaignObjectId: "camp-july",
      stats: { recipients: "10", delivered: "10", conversion_value: "5.00" },
    });
    await seedFact({
      id: "f3",
      kind: "flow",
      flowObjectId: "flow-dormant",
      stats: { recipients: "50", delivered: "50" },
    });
    const result = await loadLedgerRows({ scope, window });
    const july = result.rows.find((row) => row.objectId === "camp-july");
    expect(july?.klaviyo).toEqual({
      recipients: 1010,
      delivered: 1000,
      uniqueOpens: 400,
      uniqueClicks: 40,
      bounced: 10,
      unsubscribes: 2,
      spamComplaints: 0,
      conversions: 3,
      conversionValue: "125.00",
    });
    expect(july?.rates).toEqual({
      delivered: 1000 / 1010,
      open: 0.4,
      click: 0.04,
      unsubscribe: 0.002,
    });
    // A flow with a fact but no orders is a row now.
    expect(
      result.rows.find((row) => row.objectId === "flow-dormant"),
    ).toMatchObject({ orderCount: 0, revenue: "0.00" });
    expect(result.report).toMatchObject({
      hasCampaignGeneration: true,
      hasFlowGeneration: true,
    });
    expect(result.report.asOf?.toISOString()).toBe("2026-08-02T00:00:00.000Z");
    expect(result.report.reportFrom?.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(result.report.reportTo?.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });

  it("reads only the newest current generation per kind", async () => {
    await seedLedgerWorld();
    // The unique index that keeps a generation `current` is per publication
    // fingerprint, so a historical duplicate for the same kind and window can
    // survive alongside the live one. Summing both would double the numbers.
    await seedReportRun("source-run-old");
    await seedGeneration("campaign", "gen-campaign", "2026-08-02T00:00:00Z");
    await seedGeneration(
      "campaign",
      "gen-campaign-old",
      "2026-08-01T00:00:00Z",
      "source-run-old",
    );
    await seedFact({
      id: "f-new",
      kind: "campaign",
      campaignObjectId: "camp-july",
      stats: { recipients: "1000", delivered: "1000" },
    });
    await seedFact({
      id: "f-old",
      kind: "campaign",
      generationId: "gen-campaign-old",
      campaignObjectId: "camp-july",
      stats: { recipients: "5000", delivered: "5000" },
    });
    const result = await loadLedgerRows({ scope, window });
    expect(
      result.rows.find((row) => row.objectId === "camp-july")?.klaviyo,
    ).toMatchObject({ recipients: 1000, delivered: 1000 });
    expect(result.report.asOf?.toISOString()).toBe("2026-08-02T00:00:00.000Z");
    expect(result.report.hasCampaignGeneration).toBe(true);
    expect(result.report.reportFrom?.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(result.report.reportTo?.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });

  it("filters by kind, channel, and name", async () => {
    await seedLedgerWorld();
    expect(
      (await loadLedgerRows({ scope, window, kind: "flow" })).rows.map(
        (r) => r.objectId,
      ),
    ).toEqual(["flow-welcome"]);
    // The channel filter is a CAMPAIGN filter: flows carry no channel and
    // must survive it, or the UI's default "email" would hide every flow.
    expect(
      (await loadLedgerRows({ scope, window, channel: "email" })).rows.map(
        (r) => r.objectId,
      ),
    ).toEqual(["camp-july", "flow-welcome"]);
    expect(
      (await loadLedgerRows({ scope, window, channel: "sms" })).rows.map(
        (r) => r.objectId,
      ),
    ).toEqual(["flow-welcome"]);
    expect(
      (await loadLedgerRows({ scope, window, search: "july" })).rows.map(
        (r) => r.objectId,
      ),
    ).toEqual(["camp-july"]);
    expect((await loadLedgerRows({ scope, window, search: "%" })).rows).toEqual([]);
  });

  it("reports the newest current generation even when its window differs from the range", async () => {
    await seedLedgerWorld();
    // The nightly only ever produces last-30 windows; a generation covering
    // a month before the query window (07-01..08-01) is still the newest
    // current one and must not be ignored just because its window differs.
    await seedGeneration(
      "campaign",
      "gen-campaign",
      "2026-07-02T00:00:00Z",
      "source-run-a",
      { from: "2026-06-01T00:00:00Z", to: "2026-07-01T00:00:00Z" },
    );
    const { report } = await loadLedgerRows({ scope, window });
    expect(report.hasCampaignGeneration).toBe(true);
    expect(report.hasFlowGeneration).toBe(false);
    expect(report.reportFrom?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(report.reportTo?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("reports all-null metadata when there is no current generation at all", async () => {
    await seedLedgerWorld();
    const { report } = await loadLedgerRows({ scope, window });
    expect(report).toEqual({
      asOf: null,
      hasCampaignGeneration: false,
      hasFlowGeneration: false,
      reportFrom: null,
      reportTo: null,
    });
  });

  it("returns child rows joined by message id, or null for an unknown object", async () => {
    await seedLedgerWorld();
    await seedGeneration("campaign_message");
    await seedFact({
      id: "fm-a",
      kind: "campaign_message",
      campaignObjectId: "camp-july",
      messageObjectId: "msg-a",
      stats: { recipients: "600", delivered: "600", unique_opens: "300" },
    });
    const messages = await loadLedgerMessages({
      scope,
      window,
      objectId: "camp-july",
    });
    expect(messages).toEqual([
      expect.objectContaining({
        objectId: "msg-a",
        name: "Variant A",
        subject: "20% off",
        orderCount: 1,
        revenue: "37.50",
        klaviyo: expect.objectContaining({ recipients: 600 }),
        rates: expect.objectContaining({ open: 0.5 }),
      }),
      expect.objectContaining({
        objectId: "msg-b",
        name: "Variant B",
        orderCount: 1,
        revenue: "60.00",
        klaviyo: null,
      }),
    ]);
    expect(await loadLedgerMessages({ scope, window, objectId: "nope" })).toBeNull();
  });

  it("builds the detail: header, reconciliation, day offsets, products, and variants", async () => {
    await seedLedgerWorld();
    await seedGeneration("campaign");
    await seedFact({
      id: "f1",
      kind: "campaign",
      campaignObjectId: "camp-july",
      stats: {
        recipients: "1000",
        delivered: "990",
        conversions: "5",
        conversion_value: "150.00",
      },
    });
    const detail = await loadLedgerDetail({ scope, window, objectId: "camp-july" });
    expect(detail?.object).toMatchObject({
      name: "July Sale",
      objectType: "campaign",
      subject: "20% off",
      messageCount: 2,
    });
    expect(detail?.ours).toEqual({ orderCount: 2, revenue: "97.50" });
    expect(detail?.reconciliation).toEqual({
      unconfirmedOrders: 3,
      revenuePerRecipient: "0.10",
      averageOrderValue: "48.75",
    });
    expect(detail?.ordersByDay.mode).toBe("offset");
    expect(detail?.ordersByDay.points).toHaveLength(14);
    // order-a is 10 days after the 07-10 send; order-late is 26 days after
    // (outside the 14-day strip). 42.50 less its 5.00 refund, the same money
    // `ours` and the per-message rows report for it.
    expect(detail?.ordersByDay.points[10]).toEqual({
      label: "10",
      orders: 1,
      revenue: "37.50",
    });
    expect(
      detail?.ordersByDay.points.reduce((sum, point) => sum + point.orders, 0),
    ).toBe(1);
    // seedMatchWorld gave order-a product 77 "Product" qty 2.
    expect(detail?.topProducts).toEqual([
      { productKey: "77", title: "Product", units: 2, orderCount: 1, orderRevenue: "37.50" },
    ]);
    expect(detail?.messages.map((message) => message.objectId)).toEqual([
      "msg-a",
      "msg-b",
    ]);
  });

  it("uses calendar days and in-window orders for a flow detail", async () => {
    await seedLedgerWorld();
    const detail = await loadLedgerDetail({
      scope,
      window,
      objectId: "flow-welcome",
    });
    expect(detail?.ordersByDay.mode).toBe("calendar");
    expect(detail?.ordersByDay.points).toHaveLength(31);
    expect(
      detail?.ordersByDay.points.find((point) => point.label === "2026-07-22"),
    ).toEqual({ label: "2026-07-22", orders: 1, revenue: "30.00" });
    expect(detail?.reconciliation).toEqual({
      unconfirmedOrders: null,
      revenuePerRecipient: null,
      averageOrderValue: "30.00",
    });
    expect(detail?.messages).toEqual([]);
    expect(await loadLedgerDetail({ scope, window, objectId: "nope" })).toBeNull();
  });

  it("agrees with the attribution panel's per-source totals for the same orders", async () => {
    await seedLedgerWorld();
    // Restrict to orders created in July so both loaders see the same set:
    // July Sale's August order is out of the panel's window by design.
    await testPool!.query(`DELETE FROM shopify_order WHERE id = 'order-late'`);
    const panel = await loadEmailAttribution({
      scope,
      window,
      days: { dateFrom: "2026-07-01", dateTo: "2026-07-31" },
    });
    const ledger = await loadLedgerRows({ scope, window });
    const panelJuly = panel.sources.find(
      (source) => source.objectId === "camp-july",
    );
    const ledgerJuly = ledger.rows.find((row) => row.objectId === "camp-july");
    expect(ledgerJuly?.orderCount).toBe(panelJuly?.orderCount);
    expect(ledgerJuly?.revenue).toBe(panelJuly?.revenue);
  });

  it("filters the orders ledger by the same primary-claim rule", async () => {
    await seedLedgerWorld();
    // A second, EARLIER non-bot claim on order-a's event naming flow-welcome:
    // if the predicate were a naive "any claim names it" exists(), order-a
    // would wrongly show up under flow-welcome too. The primary-claim rule
    // (latest non-bot claim wins) must keep order-a under camp-july only.
    await seedClaim({
      id: "claim-a-older",
      conversionEventId: "event-a",
      attributionId: "attr-a-older",
      flowObjectId: "flow-welcome",
      interactionOccurredAt: "2026-07-09T08:00:00Z",
    });
    // A later BOT claim on order-flow-in's event naming camp-july: a
    // predicate that didn't exclude bot clicks would wrongly pull
    // order-flow-in into camp-july's orders.
    await seedClaim({
      id: "claim-flow-in-bot",
      conversionEventId: "event-flow-in",
      attributionId: "attr-flow-in-bot",
      campaignObjectId: "camp-july",
      interactionOccurredAt: "2026-07-23T00:00:00Z",
      botClick: 1,
    });
    // A candidate-status order whose primary claim also names camp-july: the
    // ledger counts only confirmed orders, so the source link must not show
    // it either.
    await seedOrder("order-cand", "9105", "9.00", {
      createdAt: "2026-07-24T12:00:00Z",
      orderDay: "2026-07-24",
    });
    await seedEvent("event-cand", "external-event-cand", "2026-07-24T12:05:00Z");
    await seedOrderResult("res-cand", "order-cand", "candidate", "event-cand");
    await seedClaim({
      id: "claim-cand",
      conversionEventId: "event-cand",
      attributionId: "attr-cand",
      campaignObjectId: "camp-july",
      interactionOccurredAt: "2026-07-23T10:00:00Z",
    });
    const july = await listEvidenceOrders({ scope, window: { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-09-01T00:00:00Z") }, sourceObjectId: "camp-july" });
    expect(july.items.map((item) => item.orderId).sort()).toEqual(["order-a", "order-late"]);
    const flow = await listEvidenceOrders({ scope, window, sourceObjectId: "flow-welcome" });
    expect(flow.items.map((item) => item.orderId).sort()).toEqual(["order-flow-in", "order-flow-out"]);
  });
});
