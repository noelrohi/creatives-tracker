import { describe, expect, it } from "vitest";
import { buildReporting, explicitStoreWindow, reportingSchema, type RequestedWindowAttemptEvidence, type MetaAccountEvidence } from "./analytics-reporting";
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

describe("bounded requested-window evidence", () => {
  const attempt: RequestedWindowAttemptEvidence = {
    runId: "run-a", requestedMs: now.getTime() - 1000, finishedMs: now.getTime(),
    dateFrom: "2026-10-01", dateTo: "2026-10-31", basis: "meta_insight_request_dates",
    windowPrecision: "inclusive_account_calendar_dates", result: "success",
    breakdownsRequested: ["age", "gender"], breakdownsCompleted: ["age"],
  };

  it.each([
    { result: "success", finishedMs: now.getTime(), outcome: "success" },
    { result: "partial_success", finishedMs: now.getTime(), outcome: "partial_success" },
    { result: "failed", finishedMs: now.getTime(), outcome: "failed" },
    { result: null, finishedMs: null, outcome: "unfinished" },
    { result: "success", finishedMs: null, outcome: "unfinished" },
    { result: null, finishedMs: now.getTime(), outcome: "unknown" },
    { result: "cancelled", finishedMs: now.getTime(), outcome: "unknown" },
  ])("exposes $result/$outcome without promoting coverage", ({ result, finishedMs, outcome }) => {
    const reporting = reportingSchema.parse(buildReporting({ now, metaAccounts: [{
      ...fresh, requestedWindowAttempts: [{ ...attempt, result, finishedMs }],
    }] }));
    const account = reporting.meta!.accounts[0];
    expect(account.requestedWindowAttempts.attempts[0]).toMatchObject({
      result, outcome, dateFrom: "2026-10-01", dateTo: "2026-10-31",
      basis: "meta_insight_request_dates", breakdownsRequested: ["age", "gender"], breakdownsCompleted: ["age"],
    });
    expect(account.coverage.state).toBe("unknown");
    expect(reporting.meta?.coverage.state).toBe("unknown");
  });

  it("bounds the recent history deterministically and leaves input unchanged", () => {
    const attempts = Array.from({ length: 12 }, (_, i) => ({ ...attempt, runId: `run-${String(11 - i).padStart(2, "0")}` }));
    const result = buildReporting({ now, metaAccounts: [{ ...fresh, requestedWindowAttempts: attempts }] });
    const history = result.meta!.accounts[0].requestedWindowAttempts;
    expect(history.limit).toBe(10);
    expect(history.attempts.map((row) => row.runId)).toEqual(Array.from({ length: 10 }, (_, i) => `run-${String(i).padStart(2, "0")}`));
    expect(attempts[0].runId).toBe("run-11");
    expect(buildReporting({ now, metaAccounts: [fresh] }).meta!.accounts[0].requestedWindowAttempts.attempts).toEqual([]);
  });

  it.each(["shopify_incremental_updated_at", "shopify_backfill_created_at"] as const)("discloses %s day-label precision and nullable bounds", (basis) => {
    const result = reportingSchema.parse(buildReporting({ now, shopify: {
      storeId: "store", timezone: "Asia/Tokyo", lastSuccessMs: now.getTime(), latestAttempt: null,
      requestedWindowAttempts: [{ ...attempt, basis, dateFrom: null, dateTo: null,
        windowPrecision: "utc_day_labels_not_exact_query_bounds", breakdownsRequested: null, breakdownsCompleted: null }],
    } }));
    expect(result.shopify?.requestedWindowAttempts.attempts[0]).toMatchObject({ basis, dateFrom: null, dateTo: null, windowPrecision: "utc_day_labels_not_exact_query_bounds", outcome: "success" });
    expect(result.shopify?.coverage.state).toBe("unknown");
  });
});

describe("Meta currency evidence", () => {
  it.each([
    { currencies: ["USD"], state: "uniform", currency: "USD", usable: true },
    { currencies: ["USD", "USD"], state: "uniform", currency: "USD", usable: true },
    { currencies: ["USD", "EUR"], state: "mixed", currency: null, usable: false },
    { currencies: ["USD", null], state: "unknown", currency: null, usable: false },
    { currencies: [null], state: "unknown", currency: null, usable: false },
    { currencies: [], state: "unknown", currency: null, usable: false },
    { currencies: ["USD", "EUR", null], state: "mixed", currency: null, usable: false },
    { currencies: ["usd"], state: "unknown", currency: null, usable: false },
  ])("marks $currencies as $state without converting money", ({ currencies, state, currency, usable }) => {
    const accounts = currencies.map((currency, i) => ({ ...fresh, accountId: `account-${i}`, currency }));
    const result = reportingSchema.parse(buildReporting({ now, metaAccounts: accounts }));
    expect(result.meta?.currencyEvidence).toMatchObject({ state, currency, aggregateAmountsUsable: usable, source: "meta_account_currency", conversion: "none" });
  });

  it("includes disconnected/disabled currency evidence and identifies missing accounts", () => {
    const result = buildReporting({ now, metaAccounts: [
      { ...fresh, currency: "USD" },
      { ...fresh, accountId: "b", currency: "EUR", connection: "disabled" },
      { ...fresh, accountId: "c", currency: null, connection: "disconnected" },
    ] });
    expect(result.meta?.currencyEvidence).toMatchObject({ currencies: ["EUR", "USD"], unknownAccountIds: ["c"], aggregateAmountsUsable: false });
    expect(result.meta?.accounts[0].currency).toBe("USD");
  });

  it("never infers missing currency from timezone or the presence of Shopify", () => {
    const result = buildReporting({ now, metaAccounts: [fresh], shopify: { storeId: "store", timezone: "America/New_York", lastSuccessMs: now.getTime(), latestAttempt: null } });
    expect(result.meta?.accounts[0].currency).toBeNull();
    expect(result.meta?.currencyEvidence).toMatchObject({ state: "unknown", currency: null, aggregateAmountsUsable: false });
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
