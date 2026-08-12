import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = {
  rows: [] as Array<Record<string, unknown>>,
  where: null as unknown,
  limit: null as number | null,
};

const selectChain = {
  from: vi.fn(() => selectChain),
  where: vi.fn((condition: unknown) => {
    mockState.where = condition;
    return selectChain;
  }),
  orderBy: vi.fn(() => selectChain),
  limit: vi.fn(async (value: number) => {
    mockState.limit = value;
    return mockState.rows;
  }),
};

const mockDb = { select: vi.fn(() => selectChain) };

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));

const { createMockCaller, createUnauthenticatedCaller } = await import(
  "../test-helpers"
);

function summaryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sum_1",
    organizationId: "test-org-id",
    month: "2026-08-01",
    spend: "200",
    purchaseValue: "600",
    purchaseValue7dClick: "500",
    purchaseValue1dView: "100",
    conversions: 10,
    impressions: 2000,
    linkClicks: 100,
    clicksAll: 150,
    landingPageViews: 90,
    addToCart: 30,
    initiateCheckout: 20,
    videoViews3s: 500,
    videoThruplay: 200,
    daysWithData: 12,
    sourceRowCount: 340,
    rolledUpAt: new Date("2026-08-12T00:00:00Z"),
    createdAt: new Date("2026-08-12T00:00:00Z"),
    updatedAt: new Date("2026-08-12T00:00:00Z"),
    ...overrides,
  };
}

describe("performanceSummary.monthlyOverview", () => {
  beforeEach(() => {
    mockState.rows = [];
    mockState.where = null;
    mockState.limit = null;
    vi.clearAllMocks();
  });

  it("returns stored sums with derived ratios", async () => {
    mockState.rows = [summaryRow()];

    const caller = createMockCaller({ role: "member" });
    const [row] = await caller.performanceSummary.monthlyOverview({ months: 6 });

    expect(mockState.limit).toBe(6);
    expect(row).toMatchObject({
      month: "2026-08-01",
      spend: "200",
      purchaseValue: "600",
      conversions: 10,
      impressions: 2000,
      linkClicks: 100,
      daysWithData: 12,
      sourceRowCount: 340,
    });
    expect(row.roas).toBeCloseTo(3, 10);
    expect(row.cpa).toBeCloseTo(20, 10);
    expect(row.ctr).toBeCloseTo(0.05, 10);
  });

  it("nulls ratios when the denominator is zero or missing", async () => {
    mockState.rows = [
      summaryRow({
        spend: "0",
        conversions: 0,
        impressions: null,
        linkClicks: 10,
      }),
    ];

    const caller = createMockCaller({ role: "member" });
    const [row] = await caller.performanceSummary.monthlyOverview();

    expect(row.roas).toBeNull();
    expect(row.cpa).toBeNull();
    expect(row.ctr).toBeNull();
  });

  it("defaults to 24 months and caps the range", async () => {
    const caller = createMockCaller({ role: "member" });
    await caller.performanceSummary.monthlyOverview();
    expect(mockState.limit).toBe(24);

    await expect(
      caller.performanceSummary.monthlyOverview({ months: 61 }),
    ).rejects.toThrow();
  });

  it("requires an authenticated organization", async () => {
    const caller = createUnauthenticatedCaller();
    await expect(caller.performanceSummary.monthlyOverview()).rejects.toThrow();
  });
});
