import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = {
  executeRows: [] as Array<Record<string, unknown>[]>,
};

const mockDb = {
  execute: vi.fn(async () => ({ rows: mockState.executeRows.shift() ?? [] })),
};

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));

const { createMockCaller } = await import("../test-helpers");

describe("performanceLog analytics procedures", () => {
  beforeEach(() => {
    mockState.executeRows = [];
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
  });
});
