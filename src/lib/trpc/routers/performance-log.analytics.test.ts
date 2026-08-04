import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

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

function compileSql(query: unknown): string {
  return new PgDialect().sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));

const { createMockCaller } = await import("../test-helpers");

describe("performanceLog analytics procedures", () => {
  beforeEach(() => {
    mockState.executeRows = [];
    mockState.executedSql = [];
    vi.clearAllMocks();
  });

  it("demographicBreakdown returns raw breakdown rows", async () => {
    mockState.executeRows.push([
      {
        label: "25-34",
        spend: "120.5",
        conversions: "3",
        roas: "2.4",
        impressions: "10000",
      },
    ]);

    const caller = createMockCaller({ role: "admin" });
    const result = await caller.performanceLog.demographicBreakdown({
      dimension: "age",
      from: "2026-06-01",
      to: "2026-06-07",
      format: "video",
    });

    expect(result).toEqual([
      {
        label: "25-34",
        spend: "120.5",
        conversions: "3",
        roas: "2.4",
        impressions: "10000",
      },
    ]);
    const query = compileSql(mockState.executedSql[0]).toLowerCase();
    expect(query).toContain("join ad_creative ac");
    expect(query).toContain("ac.format =");
  });
});
