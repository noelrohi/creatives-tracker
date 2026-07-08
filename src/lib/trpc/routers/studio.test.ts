import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocked DB: supports the studio router's
//   select().from().innerJoin().innerJoin().where().groupBy() chain,
// resolving groupBy() with the next queued row set. save() uses
//   insert().values().returning().
const dbState = {
  groupByRows: [] as Array<Record<string, unknown>[]>,
  inserted: [] as Array<Record<string, unknown>>,
};

const mockDb = {
  select: vi.fn(() => {
    const chain: Record<string, unknown> = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      groupBy: vi.fn(async () => dbState.groupByRows.shift() ?? []),
    };
    return chain;
  }),
  insert: vi.fn(() => {
    const chain: Record<string, unknown> = {
      values: vi.fn((row: Record<string, unknown>) => {
        dbState.inserted.push(row);
        return chain;
      }),
      returning: vi.fn(async () => [
        { id: "creative_new", ...dbState.inserted[dbState.inserted.length - 1] },
      ]),
    };
    return chain;
  }),
};

const triggerMock = {
  trigger: vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({
    id: "run_abc123",
  })),
  createPublicToken: vi.fn<(...args: unknown[]) => Promise<string>>(
    async () => "public_token_xyz",
  ),
};

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: (...a: unknown[]) => triggerMock.trigger(...a) },
  auth: { createPublicToken: (...a: unknown[]) => triggerMock.createPublicToken(...a) },
}));

const { createMockCaller } = await import("../test-helpers");

function queueGroupBy(...rowSets: Array<Record<string, unknown>[]>) {
  dbState.groupByRows.push(...rowSets);
}

describe("studio router — static-ad composer starters", () => {
  beforeEach(() => {
    dbState.groupByRows = [];
    dbState.inserted = [];
    vi.clearAllMocks();
  });

  it("winningAngles: aggregates per angle, ranks by ROAS, and keeps the highest-value creative's image as the thumbnail", async () => {
    const caller = createMockCaller({ role: "owner" });
    queueGroupBy([
      // "Bold offer": two creatives; the higher purchaseValue one owns the thumbnail
      {
        creativeId: "c1",
        name: "Bold A",
        angle: "Bold offer",
        persona: "Deal seekers",
        awarenessLevel: "most_aware",
        assetUrl: "https://cdn.test/bold-low.png",
        spend: "100",
        purchases: 5,
        purchaseValue: "300",
        roas: "3",
      },
      {
        creativeId: "c2",
        name: "Bold B",
        angle: "Bold offer",
        persona: "Deal seekers",
        awarenessLevel: "most_aware",
        assetUrl: "https://cdn.test/bold-high.png",
        spend: "100",
        purchases: 8,
        purchaseValue: "900",
        roas: "9",
      },
      // "Founder story": lower blended ROAS -> should sort below Bold offer
      {
        creativeId: "c3",
        name: "Founder",
        angle: "Founder story",
        persona: null,
        awarenessLevel: "unaware",
        assetUrl: "https://cdn.test/founder.png",
        spend: "200",
        purchases: 4,
        purchaseValue: "300",
        roas: "1.5",
      },
    ]);

    const result = await caller.studio.winningAngles();

    expect(result.map((r) => r.angle)).toEqual(["Bold offer", "Founder story"]);

    const bold = result[0];
    // blended ROAS = (300 + 900) / (100 + 100) = 6
    expect(bold.roas).toBeCloseTo(6);
    expect(bold.adCount).toBe(2);
    expect(bold.awarenessLevel).toBe("most_aware");
    // representative thumbnail = highest purchaseValue creative's asset
    expect(bold.assetUrl).toBe("https://cdn.test/bold-high.png");

    // Snapshot-ish view of what the starter list receives
    console.log("winningAngles response:\n" + JSON.stringify(result, null, 2));
  });

  it("winningAngles: returns [] for a fresh account with no performance data (drives the empty-state fallback)", async () => {
    const caller = createMockCaller({ role: "owner" });
    queueGroupBy([]);
    const result = await caller.studio.winningAngles();
    expect(result).toEqual([]);
  });

  it("topByPurchases: ranks high-purchase creatives and carries their real thumbnails", async () => {
    const caller = createMockCaller({ role: "owner" });
    queueGroupBy([
      {
        creativeId: "c_top",
        name: "Winner",
        angle: "Social proof",
        persona: "Moms",
        awarenessLevel: "product_aware",
        assetUrl: "https://cdn.test/winner.png",
        spend: "500",
        purchases: 40,
        purchaseValue: "2000",
        roas: "4",
      },
      {
        creativeId: "c_mid",
        name: "Runner up",
        angle: "Before & after",
        persona: null,
        awarenessLevel: "solution_aware",
        assetUrl: "https://cdn.test/runner.png",
        spend: "500",
        purchases: 10,
        purchaseValue: "1500",
        roas: "3",
      },
    ]);

    const result = await caller.studio.topByPurchases();

    expect(result.map((r) => r.name)).toEqual(["Winner", "Runner up"]);
    expect(result[0].purchases).toBe(40);
    expect(result[0].assetUrl).toBe("https://cdn.test/winner.png");
    console.log("topByPurchases response:\n" + JSON.stringify(result, null, 2));
  });

  it("generate: queues the Trigger.dev job with the brief + reference image and returns a run + public token", async () => {
    const caller = createMockCaller({ role: "owner" });

    const result = await caller.studio.generate({
      brief: "Bright summer skincare promo",
      angle: "Bold offer",
      awarenessLevel: "most_aware",
      count: 3,
      referenceImageUrls: ["https://cdn.test/bold-high.png"],
    });

    expect(result).toEqual({
      runId: "run_abc123",
      publicAccessToken: "public_token_xyz",
    });

    expect(triggerMock.trigger).toHaveBeenCalledWith(
      "generate-static-ads",
      expect.objectContaining({
        organizationId: "test-org-id",
        brief: "Bright summer skincare promo",
        angle: "Bold offer",
        awarenessLevel: "most_aware",
        count: 3,
        referenceImageUrls: ["https://cdn.test/bold-high.png"],
      }),
    );
    console.log(
      "generate -> trigger payload:\n" +
        JSON.stringify(triggerMock.trigger.mock.calls[0][1], null, 2),
    );
  });

  it("save: persists a generated variant as a static creative with its targeting", async () => {
    const caller = createMockCaller({ role: "owner" });

    const creative = await caller.studio.save({
      assetUrl: "https://cdn.test/generated-0.png",
      angle: "Bold offer",
      persona: "Deal seekers",
      awarenessLevel: "most_aware",
    });

    expect(creative.id).toBe("creative_new");
    expect(dbState.inserted[0]).toMatchObject({
      assetUrl: "https://cdn.test/generated-0.png",
      format: "static",
      angle: "Bold offer",
      persona: "Deal seekers",
      awarenessLevel: "most_aware",
      organizationId: "test-org-id",
    });
  });
});
