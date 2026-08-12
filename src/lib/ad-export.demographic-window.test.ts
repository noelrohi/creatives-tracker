import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { formatDateOnly } from "@/lib/date";
import { breakdownWindowStart } from "@/lib/retention/policy";

const mockState = {
  executeRows: [] as Array<Record<string, unknown>[]>,
  executedSql: [] as unknown[],
};

const mockDb = {
  execute: vi.fn(async (query: unknown) => {
    mockState.executedSql.push(query);
    return { rows: mockState.executeRows.shift() ?? [] };
  }),
};

function compileSql(query: unknown) {
  return new PgDialect().sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]);
}

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));

const { fetchAgentExportRows } = await import("./ad-export");

const today = formatDateOnly(new Date());
const windowStart = breakdownWindowStart(today);

/** Minimal ad row — only the identity columns the mapper needs. */
const AD_ROW = {
  ad_id: "ad-1",
  ad_name: "Ad One",
  creative_id: "creative-1",
  creative_name: "Creative One",
};

/** One demographic row per dimension query (gender, age, country, device). */
function pushDemographicRows() {
  for (let i = 0; i < 4; i++) {
    mockState.executeRows.push([
      { ad_id: "ad-1", label: "female", spend: "100", conversions: "2", roas: "3" },
    ]);
  }
}

describe("agent export demographic window", () => {
  beforeEach(() => {
    mockState.executeRows = [];
    mockState.executedSql = [];
    vi.clearAllMocks();
  });

  it("clamps the demographic queries to the breakdown window and labels the summary", async () => {
    const from = "2020-01-01";
    mockState.executeRows.push([AD_ROW]);
    pushDemographicRows();

    const result = await fetchAgentExportRows({
      organizationId: "org-1",
      from,
      to: today,
    });

    // The ad's own window is untouched; only the demographic section is clamped.
    expect(result.ads[0]!.windowFrom).toBe(from);
    expect(result.ads[0]!.demoWindowFrom).toBe(windowStart);
    expect(result.ads[0]!.demoWindowTo).toBe(today);

    const demoQueries = mockState.executedSql.slice(1).map(compileSql);
    expect(demoQueries).toHaveLength(4);
    for (const query of demoQueries) {
      expect(query.params).toContain(windowStart);
      expect(query.params).not.toContain(from);
    }

    // Nothing silently partial: every breakdown cell names the window it covers.
    for (const value of [
      result.ads[0]!.genderBreakdown,
      result.ads[0]!.ageBreakdown,
      result.ads[0]!.countryBreakdown,
      result.ads[0]!.deviceBreakdown,
    ]) {
      expect(value).toContain(`[${windowStart} to ${today}]`);
    }
  });

  it("leaves an in-window range unclamped and unlabelled", async () => {
    mockState.executeRows.push([AD_ROW]);
    pushDemographicRows();

    const result = await fetchAgentExportRows({
      organizationId: "org-1",
      from: windowStart,
      to: today,
    });

    expect(result.ads[0]!.demoWindowFrom).toBe(windowStart);
    expect(result.ads[0]!.genderBreakdown).not.toContain("[");
  });
});
