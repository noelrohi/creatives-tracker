import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/db", () => ({ db: { execute } }));
const { loadAnalyticsReporting, resolveDashboardWindow } = await import("./analytics-reporting-queries");
const compile = (query: SQL) => new PgDialect().sqlToQuery(query);

beforeEach(() => execute.mockReset());

describe("database-resolved reporting windows", () => {
  it.each([
    undefined,
    { days: 7 },
    { from: "1999-01-01", days: 7 },
    { to: "1999-01-01", days: 7 },
  ])("uses database current_date, not application midnight: %j", async (input) => {
    execute.mockResolvedValue({ rows: [{ date_from: "2026-11-01", date_to: "2026-11-08", timezone: "Pacific/Auckland" }] });
    const result = await resolveDashboardWindow(input);
    const query = compile(execute.mock.calls[0][0]);
    expect(query.sql).toContain("current_date -");
    expect(query.sql).toContain("current_setting('TimeZone')");
    expect(query.params).toEqual([7]);
    expect(result).toMatchObject({ dateFrom: "2026-11-01", dateTo: "2026-11-08", selection: "rolling", rollingDays: 7, resolutionTimezone: "Pacific/Auckland", ignoredOneSidedBound: Boolean(input?.from || input?.to) });
  });

  it.each(["2026-03-08", "2026-03-12"])("both explicit bounds override days through %s", async (to) => {
    execute.mockResolvedValue({ rows: [{ date_from: "2026-03-08", date_to: to, timezone: "UTC" }] });
    const result = await resolveDashboardWindow({ from: "2026-03-08", to, days: 90 });
    const query = compile(execute.mock.calls[0][0]);
    expect(query.params).toEqual(["2026-03-08", to]);
    expect(query.sql).not.toContain("current_date");
    expect(result).toMatchObject({ dateFrom: "2026-03-08", dateTo: to, selection: "explicit", rollingDays: null, resolutionTimezone: null, ignoredOneSidedBound: false });
  });
});

describe("reporting evidence query isolation", () => {
  it("scopes account inventory and both run lookups, retaining disconnected accounts", async () => {
    execute.mockResolvedValue({ rows: [] });
    const result = await loadAnalyticsReporting({ organizationId: "org-a", accountId: "account-b" });
    const query = compile(execute.mock.calls[0][0]);
    expect(query.params.filter((value) => value === "org-a")).toHaveLength(4);
    expect(query.params).toContain("account-b");
    expect(query.sql).toContain("LEFT JOIN LATERAL");
    expect(query.sql).toContain("'currency', a.currency");
    expect(query.sql).toContain("'basis', 'meta_insight_request_dates'");
    expect(query.sql).toContain("r.breakdowns_completed");
    expect(query.params).toContain(10);
    expect(query.sql).toMatch(/ORDER BY r.requested_at DESC, r.id ASC LIMIT \$\d+/);
    expect(query.sql).not.toContain("r.error_message");
    expect(result.meta?.coverage.state).toBe("unknown");
    expect(query.sql).not.toContain("AND a.is_disabled");
    expect(query.sql).not.toContain("AND a.meta_access_token");
    expect(query.sql).toContain("AT TIME ZONE 'UTC'");
    expect(result.meta?.freshness).toBe("no_accounts");
  });

  it("exposes account-scoped authoritative currency through reporting", async () => {
    execute.mockResolvedValue({ rows: [{ evidence: {
      accountId: "account-a", timezone: "Asia/Tokyo", currency: "USD", connection: "connected",
      observedImportedThrough: null, lastSuccessMs: null, latestAttempt: null,
    } }] });
    const result = await loadAnalyticsReporting({ organizationId: "org-a", accountId: "account-a" });
    expect(result.meta?.accounts[0].currency).toBe("USD");
    expect(result.meta?.currencyEvidence).toMatchObject({ state: "uniform", currency: "USD", aggregateAmountsUsable: true });
  });

  it("scopes Shopify evidence to org and store and excludes local rebucketing from ingestion success", async () => {
    execute.mockResolvedValue({ rows: [{ evidence: { lastSuccessMs: null, latestAttempt: null } }] });
    const result = await loadAnalyticsReporting({ organizationId: "org-a", store: { id: "store-a", ianaTimezone: "Asia/Tokyo" }, includeMeta: false });
    const query = compile(execute.mock.calls[0][0]);
    expect(query.params).toEqual(["org-a", "store-a", 10, "org-a", "store-a", "org-a", "store-a"]);
    expect(query.sql.match(/r.phase IN \('incremental', 'backfill'\)/g)).toHaveLength(3);
    expect(query.sql).toContain("shopify_incremental_updated_at");
    expect(query.sql).toContain("shopify_backfill_created_at");
    expect(query.sql).toContain("utc_day_labels_not_exact_query_bounds");
    expect(query.sql).toMatch(/ORDER BY r.requested_at DESC, r.id ASC LIMIT \$\d+/);
    expect(query.sql).not.toContain("r.error");
    expect(result.shopify?.requestedWindowAttempts).toMatchObject({ limit: 10, attempts: [] });
    expect(result).toMatchObject({ meta: null, shopify: { freshness: "never_synced", storeId: "store-a" } });
  });
});
