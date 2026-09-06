import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MATCH_FIXTURE_DDL, migrationStatements, resolveConnectionString, withDatabase } from "./klaviyo/match-test-harness";
import { FULFILLMENT_STATUSES } from "./shopify-fulfillment";
import type { ShopifyOrderNode } from "./shopify-admin";

const fetchOrders = vi.hoisted(() => vi.fn());
vi.mock("./shopify-admin", async (importOriginal) => ({
  ...await importOriginal<typeof import("./shopify-admin")>(),
  fetchOrdersByIds: fetchOrders,
}));
const connection = resolveConnectionString();
const database = "adsolute_shopify_fulfillment_test";
const pool = connection ? new Pool({ connectionString: withDatabase(connection, database) }) : null;
const testDb = pool ? drizzle(pool) : null;
vi.mock("@/db", () => ({ get db() { return testDb; } }));
const { ingestOrderNodes } = await import("./shopify-ingest");
const { getUnfulfilledOrders } = await import("./shopify-fulfillment-queries");
const { backfillFulfillmentStatuses } = await import("./shopify-fulfillment-backfill");
const { createApiKeyCaller } = await import("./trpc/test-helpers");
const scope = { organizationId: "org-a", storeId: "store-a", dateFrom: "2026-03-08", dateTo: "2026-03-08" };
const store = { id: "store-a", ianaTimezone: "America/New_York" };
const now = new Date("2026-04-01T12:00:00Z");
function order(id: string, status: string | null = "UNFULFILLED", overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return { id, createdAt: "2026-03-08T05:00:00Z", updatedAt: "2026-04-01T10:00:00Z", displayFulfillmentStatus: status, refunds: [], customerJourneySummary: { ready: true }, ...overrides };
}
async function ingest(orders: ShopifyOrderNode[], observed = now) {
  return ingestOrderNodes({ organizationId: scope.organizationId, store, orders, now: observed });
}

(connection ? describe : describe.skip)("Shopify fulfillment ingestion and summary on PostgreSQL", () => {
  let legacyStatus: unknown;
  beforeAll(async () => {
    const admin = new Pool({ connectionString: withDatabase(connection!, "postgres") });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`CREATE DATABASE ${database}`);
    } finally { await admin.end(); }
    for (const statement of MATCH_FIXTURE_DDL) await pool!.query(statement);
    await pool!.query(`ALTER TABLE shopify_order ADD COLUMN shopify_customer_id text, ADD COLUMN meta_ad_set_id text, ADD COLUMN meta_ad_id text, ADD COLUMN meta_ad_match_method text, ADD COLUMN landing_page_id text`);
    await pool!.query(`ALTER TABLE shopify_store ADD COLUMN findings_evaluated_at timestamp`);
    await pool!.query(`INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone) VALUES ('store-a', 'org-a', 'synthetic.myshopify.com', 'America/New_York')`);
    await pool!.query(`INSERT INTO shopify_order (id, organization_id, store_id, shopify_order_id, order_created_at, order_day, net_sales) VALUES ('legacy', 'org-a', 'store-a', 'legacy', now(), '2026-03-08', 0)`);
    for (const statement of migrationStatements("0071_exotic_epoch.sql")) await pool!.query(statement);
    legacyStatus = (await pool!.query(`SELECT fulfillment_status, fulfillment_status_observed_at FROM shopify_order WHERE id = 'legacy'`)).rows[0];
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    fetchOrders.mockReset();
    await pool!.query("TRUNCATE shopify_refund, shopify_order");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("migrates existing rows without inventing known statuses", () => {
    expect(legacyStatus).toEqual({ fulfillment_status: null, fulfillment_status_observed_at: null });
  });

  it("counts every supported status distinctly, excluding cancellations independent of payment", async () => {
    const orders = FULFILLMENT_STATUSES.map((status) => order(status, status));
    await ingest([...orders, order("unknown", "FUTURE_STATUS"), order("missing", null),
      order("cancelled", "UNFULFILLED", { cancelledAt: "2026-04-01T09:00:00Z", displayFinancialStatus: "PAID" }),
      order("unpaid", "UNFULFILLED", { displayFinancialStatus: "PENDING" }),
      order("test", "UNFULFILLED", { test: true })]);
    await ingest(orders); // Upserts, not another count of the same identities.
    const result = await getUnfulfilledOrders(scope);
    expect(result).toMatchObject({ observedUnfulfilledCount: 4, observedNonCancelledCount: 13, excludedCancelledCount: 1, unknownStatusCount: 2, statusCoverage: { state: "partial", knownCount: 11, unknownCount: 2 } });
    expect(result.statusCounts.find((row) => row.status === "PARTIALLY_FULFILLED")?.count).toBe(1);
    expect(result.statusCounts.find((row) => row.status === "ON_HOLD")?.count).toBe(1);
  });

  it.each([
    ["2026-03-08", "2026-03-08T04:59:59Z", "2026-03-08T05:00:00Z", "2026-03-09T03:59:59Z", "2026-03-09T04:00:00Z"],
    ["2026-11-01", "2026-11-01T03:59:59Z", "2026-11-01T04:00:00Z", "2026-11-02T04:59:59Z", "2026-11-02T05:00:00Z"],
  ])("selects inclusive creation days across midnight and DST on %s", async (day, before, start, end, after) => {
    await ingest([before, start, end, after].map((createdAt, i) => order(`order-${i}`, "UNFULFILLED", { createdAt })));
    expect((await getUnfulfilledOrders({ ...scope, dateFrom: day, dateTo: day })).observedUnfulfilledCount).toBe(2);
  });

  it("reflects later fulfillment of a historical order and rejects stale/missing observations", async () => {
    await ingest([order("changing")]);
    expect((await getUnfulfilledOrders(scope)).observedUnfulfilledCount).toBe(1);
    await ingest([order("changing", "FULFILLED", { updatedAt: "2026-04-02T10:00:00Z" })], new Date("2026-04-02T12:00:00Z"));
    await ingest([order("changing", "UNFULFILLED")], new Date("2026-04-03T12:00:00Z"));
    await ingest([order("changing", null, { updatedAt: "2026-04-04T10:00:00Z" })], new Date("2026-04-04T12:00:00Z"));
    await ingest([order("changing", "UNFULFILLED", { updatedAt: "2026-04-03T10:00:00Z" })], new Date("2026-04-05T12:00:00Z"));
    const result = await getUnfulfilledOrders(scope);
    expect(result.observedUnfulfilledCount).toBe(0);
    expect(result.statusCounts.find((row) => row.status === "FULFILLED")?.count).toBe(1);
    expect(result.statusCoverage.oldestObservedAt).toBe("2026-04-02T12:00:00.000Z");
  });

  it("does not let stale refreshes erase cancellation evidence", async () => {
    await ingest([order("cancelled", "UNFULFILLED", { updatedAt: "2026-04-02T10:00:00Z", cancelledAt: "2026-04-02T10:00:00Z" })]);
    await ingest([order("cancelled")]);
    expect((await getUnfulfilledOrders(scope)).excludedCancelledCount).toBe(1);
  });

  it("keeps empty/missing populations unknown rather than presenting complete zero", async () => {
    expect((await getUnfulfilledOrders(scope)).statusCoverage.state).toBe("unknown");
    await ingest([order("missing", null)]);
    expect((await getUnfulfilledOrders(scope))).toMatchObject({ observedUnfulfilledCount: 0, unknownStatusCount: 1, statusCoverage: { state: "unknown" } });
  });

  it("backfills scoped missing statuses in bounded resumable batches using the real ingest path", async () => {
    vi.stubEnv("SHOPIFY_SHOP_DOMAIN", "synthetic.myshopify.com");
    await pool!.query(`INSERT INTO shopify_store (id, organization_id, shop_domain, iana_timezone) VALUES ('store-b', 'org-b', 'other.myshopify.com', 'UTC') ON CONFLICT DO NOTHING`);
    await ingest([order("a1", null), order("a2", null)]);
    await ingestOrderNodes({ organizationId: "org-b", store: { id: "store-b", ianaTimezone: "UTC" }, orders: [order("b1", null)] });
    fetchOrders.mockImplementation(async (ids: string[]) => ids.map((id) => order(id, "FULFILLED")));
    const payload = { organizationId: "org-a", storeId: "store-a", batchSize: 1, maxBatches: 1 };
    const first = await backfillFulfillmentStatuses(payload);
    expect(first).toMatchObject({ scanned: 1, fetched: 1, hasMore: true });
    expect((await getUnfulfilledOrders(scope)).unknownStatusCount).toBe(1);
    const second = await backfillFulfillmentStatuses({ ...payload, afterId: first.nextCursor! });
    expect(second).toMatchObject({ scanned: 1, fetched: 1, hasMore: false });
    expect((await getUnfulfilledOrders(scope)).statusCoverage.state).toBe("complete_for_observed_orders");
    expect(fetchOrders.mock.calls.flatMap(([ids]) => ids).sort()).toEqual(["a1", "a2"]);
    expect((await getUnfulfilledOrders({ ...scope, organizationId: "org-b", storeId: "store-b" })).unknownStatusCount).toBe(1);
    await expect(backfillFulfillmentStatuses({ ...payload, organizationId: "org-b" })).rejects.toThrow("does not match");
    expect(fetchOrders).toHaveBeenCalledTimes(2);
  });

  it("exposes aggregate-only read access and isolates organization/store scopes", async () => {
    await ingest([order("private-order")]);
    const read = createApiKeyCaller({ organizationId: "org-a", scopes: ["read"] });
    const result = await read.attribution.unfulfilledOrders({ dateFrom: scope.dateFrom, dateTo: scope.dateTo });
    expect(result.observedUnfulfilledCount).toBe(1);
    expect(result.effectiveWindow).toMatchObject({ dateFrom: scope.dateFrom, dateTo: scope.dateTo, boundaries: "inclusive", rowSelection: "store_order_day" });
    expect(result.reporting.shopify).toMatchObject({ timezone: "America/New_York", coverage: { state: "unknown" } });
    expect(JSON.stringify(result)).not.toContain("private-order");
    expect((await getUnfulfilledOrders({ ...scope, organizationId: "org-b" })).observedNonCancelledCount).toBe(0);
    expect((await getUnfulfilledOrders({ ...scope, storeId: "other-store" })).observedNonCancelledCount).toBe(0);
    await expect(createApiKeyCaller({ organizationId: "org-without-store", scopes: ["read"] }).attribution.unfulfilledOrders({ dateFrom: scope.dateFrom, dateTo: scope.dateTo })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createApiKeyCaller({ organizationId: "org-a", scopes: ["write"] }).attribution.unfulfilledOrders({ dateFrom: scope.dateFrom, dateTo: scope.dateTo })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
