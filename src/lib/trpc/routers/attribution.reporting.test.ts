import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildReporting } from "@/lib/analytics-reporting";

const mocks = vi.hoisted(() => ({
  getStoreForOrg: vi.fn(), getBucketTotals: vi.fn(), getSyncHealth: vi.fn(),
  getMetaClaims: vi.fn(), getMetaVerified: vi.fn(), getCampaignLedger: vi.fn(),
  getDailyBucketSeries: vi.fn(), getRefundsTotal: vi.fn(), getRoasTarget: vi.fn(),
  loadAnalyticsReporting: vi.fn(),
}));
vi.mock("@/lib/attribution-queries", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/attribution-queries")>(),
  ...Object.fromEntries(Object.entries(mocks).filter(([name]) => name !== "loadAnalyticsReporting")),
}));
vi.mock("@/lib/analytics-reporting-queries", () => ({ loadAnalyticsReporting: mocks.loadAnalyticsReporting }));
const shopifyMocks = vi.hoisted(() => ({ getShopifyShopDomain: vi.fn(), shopifyGraphql: vi.fn(), getUnfulfilledOrders: vi.fn() }));
vi.mock("@/lib/shopify-admin", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/shopify-admin")>(), getShopifyShopDomain: shopifyMocks.getShopifyShopDomain, shopifyGraphql: shopifyMocks.shopifyGraphql }));
vi.mock("@/lib/shopify-fulfillment-queries", () => ({ getUnfulfilledOrders: shopifyMocks.getUnfulfilledOrders }));
import { summarizeFulfillment } from "@/lib/shopify-fulfillment";
const { createApiKeyCaller, createUnauthenticatedCaller } = await import("../test-helpers");
const store = { id: "store-a", shopDomain: "synthetic.myshopify.com", ianaTimezone: "America/New_York", currency: "USD" };
const range = { dateFrom: "2026-03-08", dateTo: "2026-03-08" };
const health = { shopify: { lastSuccessAt: null, stale: true }, meta: { lastSuccessAt: null, stale: false } };

beforeEach(() => {
  vi.clearAllMocks();
  shopifyMocks.getShopifyShopDomain.mockReturnValue(store.shopDomain);
  shopifyMocks.shopifyGraphql.mockResolvedValue({ shop: { myshopifyDomain: store.shopDomain }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }, { handle: "read_all_orders" }] } });
  mocks.getStoreForOrg.mockImplementation(async (org) => org === "org-a" ? store : null);
  mocks.getBucketTotals.mockResolvedValue({ buckets: [], pending: { count: 0, revenueCents: 0 }, totalCents: 0, identity: { sumOfBucketsCents: 0, actualCents: 0, differenceCents: 0, matches: true } });
  mocks.getSyncHealth.mockResolvedValue(health);
  mocks.getMetaClaims.mockResolvedValue({ claimedCents: null, claimed7dClickCents: null, claimed1dViewCents: null, labeledRowShare: 0, spendCents: 0 });
  mocks.getMetaVerified.mockResolvedValue({ verifiedRevenueCents: 0, verifiedOrderCount: 0, verificationPendingCount: 0 });
  mocks.getCampaignLedger.mockResolvedValue({ campaigns: [], unresolved: null });
  mocks.getRoasTarget.mockResolvedValue(1.5);
  mocks.getDailyBucketSeries.mockResolvedValue([]);
  mocks.getRefundsTotal.mockResolvedValue({ refundedCents: 0, count: 0 });
  mocks.loadAnalyticsReporting.mockImplementation(async (input) => buildReporting({
    now: new Date("2026-03-09T04:00:00Z"),
    metaAccounts: input.includeMeta ? [] : undefined,
    shopify: { storeId: input.store.id, timezone: input.store.ianaTimezone, lastSuccessMs: null, latestAttempt: null },
  }));
});

describe("attribution reporting caller contracts", () => {
  it("returns a read-key scoped conversion blocker with null values", async () => {
    const result = await createApiKeyCaller({ organizationId: "org-a", scopes: ["read"] }).attribution.conversionAvailability(range);
    expect(result).toMatchObject({ storeId: store.id, requestedRange: range, requestedTimezone: store.ianaTimezone, blocker: "missing_read_reports", numerator: null, denominator: null, rate: null });
    expect(mocks.getStoreForOrg).toHaveBeenCalledWith("org-a");
    expect(mocks.getBucketTotals).not.toHaveBeenCalled();
  });

  it("does not probe Shopify for another organization", async () => {
    await expect(createApiKeyCaller({ organizationId: "org-b", scopes: ["read"] }).attribution.conversionAvailability(range)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(shopifyMocks.shopifyGraphql).not.toHaveBeenCalled();
  });

  it.each(["conversionAvailability", "unfulfilledOrders"] as const)("requires read authorization for %s", async (procedure) => {
    await expect(createApiKeyCaller({ organizationId: "org-a", scopes: ["write"] }).attribution[procedure](range)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createUnauthenticatedCaller().attribution[procedure](range)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.getStoreForOrg).not.toHaveBeenCalled();
    expect(shopifyMocks.shopifyGraphql).not.toHaveBeenCalled();
  });

  it("rejects reversed conversion ranges before probing", async () => {
    await expect(createApiKeyCaller({ organizationId: "org-a", scopes: ["read"] }).attribution.conversionAvailability({ dateFrom: "2026-09-02", dateTo: "2026-09-01" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(shopifyMocks.shopifyGraphql).not.toHaveBeenCalled();
  });

  it("preserves nullable fulfillment answers through output parsing", async () => {
    shopifyMocks.getUnfulfilledOrders.mockResolvedValue(summarizeFulfillment([{ status: "UNKNOWN", count: 5, oldestMs: null, newestMs: null }]));
    const result = await createApiKeyCaller({ organizationId: "org-a", scopes: ["read"] }).attribution.unfulfilledOrders(range);
    expect(result.answer).toEqual({ unfulfilledCount: null, availability: "unknown", sourceCoverage: "unknown" });
    expect(result.observedUnfulfilledCount).toBe(0);
    expect(shopifyMocks.getUnfulfilledOrders).toHaveBeenCalledWith({ ...range, organizationId: "org-a", storeId: store.id });
  });

  it.each(["overview", "metaCheck", "campaignLedger", "dailySeries", "refundsTotal"] as const)("preserves inclusive ranges and read access on %s", async (procedure) => {
    const caller = createApiKeyCaller({ organizationId: "org-a", scopes: ["read"] });
    const result = await caller.attribution[procedure](range);
    expect(result.range).toEqual(range);
    expect(result.salesDefinition).toMatchObject({
      version: "shopify_order_refund_ledger_v1", currency: "USD", timezone: store.ianaTimezone,
      officialReportReconciled: false,
      arithmetic: procedure === "refundsTotal" ? "refund_amounts_only" : "order_amounts_minus_refund_amounts",
    });
    expect(result.effectiveWindow).toMatchObject({ ...range, boundaries: "inclusive", selection: "explicit" });
    expect(result.reporting.shopify).toMatchObject({ storeId: "store-a", timezone: "America/New_York", coverage: { state: "unknown" } });
    expect(mocks.getStoreForOrg).toHaveBeenCalledWith("org-a");
    expect(mocks.loadAnalyticsReporting).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-a", store }));
    const metricRead = { overview: mocks.getBucketTotals, metaCheck: mocks.getMetaClaims, campaignLedger: mocks.getCampaignLedger, dailySeries: mocks.getDailyBucketSeries, refundsTotal: mocks.getRefundsTotal }[procedure];
    expect(metricRead).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-a", ...result.range }));
  });

  it("keeps existing overview health and store fields", async () => {
    const result = await createApiKeyCaller({ organizationId: "org-a", scopes: ["read"] }).attribution.overview(range);
    expect(result.syncHealth).toEqual(health);
    expect(result.store).toMatchObject(store);
  });

  it.each(["overview", "metaCheck", "campaignLedger", "dailySeries", "refundsTotal"] as const)("does not read another organization's store or evidence through %s", async (procedure) => {
    await expect(createApiKeyCaller({ organizationId: "org-b", scopes: ["read"] }).attribution[procedure](range)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.loadAnalyticsReporting).not.toHaveBeenCalled();
  });
});
