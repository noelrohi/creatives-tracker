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
    expect(query.params.filter((value) => value === "org-a")).toHaveLength(3);
    expect(query.params).toContain("account-b");
    expect(query.sql).toContain("LEFT JOIN LATERAL");
    expect(query.sql).not.toContain("AND a.is_disabled");
    expect(query.sql).not.toContain("AND a.meta_access_token");
    expect(query.sql).toContain("AT TIME ZONE 'UTC'");
    expect(result.meta?.freshness).toBe("no_accounts");
  });

  it("scopes Shopify evidence to org and store and excludes local rebucketing from ingestion success", async () => {
    execute.mockResolvedValue({ rows: [{ evidence: { lastSuccessMs: null, latestAttempt: null } }] });
    const result = await loadAnalyticsReporting({ organizationId: "org-a", store: { id: "store-a", ianaTimezone: "Asia/Tokyo" }, includeMeta: false });
    const query = compile(execute.mock.calls[0][0]);
    expect(query.params).toEqual(["org-a", "store-a", "org-a", "store-a"]);
    expect(query.sql).toContain("r.phase IN ('incremental', 'backfill')");
    expect(result).toMatchObject({ meta: null, shopify: { freshness: "never_synced", storeId: "store-a" } });
  });
});
