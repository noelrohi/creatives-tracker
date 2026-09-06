import { describe, expect, it } from "vitest";
import { buildReporting, explicitStoreWindow, reportingSchema, type MetaAccountEvidence } from "./analytics-reporting";
import { deriveDayInTimezone } from "./shopify-ingest";

const now = new Date("2026-11-02T12:00:00Z");
const fresh: MetaAccountEvidence = {
  accountId: "account-a", timezone: "America/New_York", connection: "connected",
  observedImportedThrough: "2026-11-02", lastSuccessMs: now.getTime() - 3_600_000,
  latestAttempt: { requestedMs: now.getTime() - 3_600_000, finishedMs: now.getTime(), result: "partial_success" },
};

describe("analytics source evidence", () => {
  it("keeps recent partial success, coverage and revisability separate", () => {
    const result = reportingSchema.parse(buildReporting({ now, metaAccounts: [fresh] }));
    expect(result.meta).toMatchObject({ freshness: "fresh", coverage: { state: "unknown" }, revisability: "provisional" });
    expect(result.meta?.accounts[0]).toMatchObject({ observedImportedThrough: "2026-11-02", latestAttempt: { result: "partial_success" } });
    expect(JSON.stringify(result)).not.toContain("finalizedThrough");
  });

  it.each([
    { lastSuccessMs: null, expected: "never_synced" },
    { lastSuccessMs: now.getTime() - 49 * 3_600_000, expected: "stale" },
  ])("does not hide a $expected account behind the newest success", ({ lastSuccessMs, expected }) => {
    const result = buildReporting({ now, metaAccounts: [fresh, { ...fresh, accountId: "lagging", lastSuccessMs }] });
    expect(result.meta?.freshness).toBe(expected);
    expect(result.meta?.accounts).toHaveLength(2);
  });

  it("retains failed attempt alongside older success and disconnected/disabled inventory", () => {
    const result = buildReporting({ now, metaAccounts: [
      { ...fresh, connection: "disconnected", latestAttempt: { ...fresh.latestAttempt!, result: "failed" } },
      { ...fresh, accountId: "disabled", connection: "disabled", lastSuccessMs: null },
    ] });
    expect(result.meta?.allAccountsConnected).toBe(false);
    expect(result.meta?.accounts[0]).toMatchObject({ freshness: "fresh", connection: "disconnected", latestAttempt: { result: "failed" } });
    expect(result.meta?.freshness).toBe("never_synced");
  });

  it("makes mixed and missing timezones explicit, without inventing a common zone", () => {
    const mixed = buildReporting({ now, metaAccounts: [fresh, { ...fresh, accountId: "b", timezone: "Asia/Tokyo" }] });
    expect(mixed.meta).toMatchObject({ timezoneState: "mixed", timezones: ["America/New_York", "Asia/Tokyo"] });
    const unknown = buildReporting({ now, metaAccounts: [fresh, { ...fresh, accountId: "b", timezone: null }] });
    expect(unknown.meta?.timezoneState).toBe("unknown");
    expect(buildReporting({ now, metaAccounts: [] }).meta).toMatchObject({ freshness: "no_accounts", timezoneState: "unknown", allAccountsConnected: false });
  });

  it("does not merge Shopify freshness with Meta", () => {
    const result = buildReporting({ now, metaAccounts: [fresh], shopify: { storeId: "store", timezone: "Europe/London", lastSuccessMs: now.getTime() - 3 * 3_600_000, latestAttempt: null } });
    expect(result.meta?.freshness).toBe("fresh");
    expect(result.shopify).toMatchObject({ freshness: "stale", timezone: "Europe/London", coverage: { state: "unknown" }, revisability: "unknown" });
  });
});

describe("inclusive source calendar labels", () => {
  it.each([
    ["2026-03-08T04:59:59Z", "2026-03-07"],
    ["2026-03-08T05:00:00Z", "2026-03-08"],
    ["2026-03-09T03:59:59Z", "2026-03-08"],
    ["2026-03-09T04:00:00Z", "2026-03-09"],
    ["2026-11-01T05:30:00Z", "2026-11-01"],
    ["2026-11-01T06:30:00Z", "2026-11-01"],
  ])("uses the store calendar for %s, including midnight and DST", (instant, day) => {
    expect(deriveDayInTimezone(instant, "America/New_York")).toBe(day);
    expect(explicitStoreWindow({ dateFrom: day, dateTo: day })).toMatchObject({ dateFrom: day, dateTo: day, boundaries: "inclusive" });
  });

  it("uses distinct event bases for mixed reporting and refunds", () => {
    const range = { dateFrom: "2026-03-01", dateTo: "2026-03-08" };
    expect(explicitStoreWindow(range, "mixed").rowSelection).toBe("meta_date_start_and_store_order_refund_days");
    expect(explicitStoreWindow(range, "refund").rowSelection).toBe("store_refund_day");
  });
});
