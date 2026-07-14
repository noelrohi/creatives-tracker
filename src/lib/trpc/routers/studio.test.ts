import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocked DB: supports the studio router's
//   select().from().innerJoin().innerJoin().where().groupBy() chain,
// resolving groupBy() with the next queued row set. setStarred() uses
//   update().set().where().returning(). generate() uses insert/update chains.
const dbState = {
  groupByRows: [] as Array<Record<string, unknown>[]>,
  inserted: [] as Array<Record<string, unknown> | Record<string, unknown>[]>,
  updated: [] as Array<Record<string, unknown>>,
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
      values: vi.fn((row: Record<string, unknown> | Record<string, unknown>[]) => {
        dbState.inserted.push(row);
        return chain;
      }),
      returning: vi.fn(async () => [
        {
          id: Array.isArray(dbState.inserted[dbState.inserted.length - 1])
            ? "row_new"
            : (dbState.inserted[dbState.inserted.length - 1] as Record<string, unknown>)
                  .brief
              ? "generation_new"
              : "creative_new",
          ...dbState.inserted[dbState.inserted.length - 1],
        },
      ]),
    };
    return chain;
  }),
  update: vi.fn(() => {
    const chain: Record<string, unknown> = {
      set: vi.fn((row: Record<string, unknown>) => {
        dbState.updated.push(row);
        return chain;
      }),
      where: vi.fn(() => chain),
      returning: vi.fn(async () => [{ id: "variant_1" }]),
    };
    return chain;
  }),
};

Object.assign(mockDb, {
  transaction: vi.fn(
    async (callback: (tx: typeof mockDb) => Promise<unknown>) => callback(mockDb),
  ),
});

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
    dbState.updated = [];
    vi.clearAllMocks();
    triggerMock.trigger.mockResolvedValue({ id: "run_abc123" });
    triggerMock.createPublicToken.mockResolvedValue("public_token_xyz");
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

  it("generate: persists generation scaffolding, queues the Trigger.dev job with the brief + reference image, and returns ids + public token", async () => {
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
      generationId: "generation_new",
    });

    expect(dbState.inserted[0]).toMatchObject({
      organizationId: "test-org-id",
      brief: "Bright summer skincare promo",
      angle: "Bold offer",
      awarenessLevel: "most_aware",
      count: 3,
      referenceImageUrls: ["https://cdn.test/bold-high.png"],
    });
    expect(dbState.inserted[1]).toEqual([
      {
        generationId: "generation_new",
        organizationId: "test-org-id",
        index: 0,
        status: "pending",
      },
      {
        generationId: "generation_new",
        organizationId: "test-org-id",
        index: 1,
        status: "pending",
      },
      {
        generationId: "generation_new",
        organizationId: "test-org-id",
        index: 2,
        status: "pending",
      },
    ]);
    expect(dbState.updated[0]).toMatchObject({ runId: "run_abc123" });

    expect(triggerMock.trigger).toHaveBeenCalledWith(
      "generate-static-ads",
      expect.objectContaining({
        generationId: "generation_new",
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

  it("generate: marks persisted scaffolding failed when Trigger enqueueing fails", async () => {
    const caller = createMockCaller({ role: "owner" });
    triggerMock.trigger.mockRejectedValueOnce(new Error("Trigger unavailable"));

    await expect(
      caller.studio.generate({ brief: "A launch ad", count: 2 }),
    ).rejects.toThrow("Trigger unavailable");

    expect(dbState.updated).toEqual([
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  it("generate: rejects non-HTTP reference image URLs before persisting", async () => {
    const caller = createMockCaller({ role: "owner" });

    await expect(
      caller.studio.generate({
        brief: "A launch ad",
        referenceImageUrls: ["file:///etc/passwd"],
      }),
    ).rejects.toThrow("Reference images must use HTTP or HTTPS");

    expect(dbState.inserted).toEqual([]);
    expect(triggerMock.trigger).not.toHaveBeenCalled();
  });

  it("setStarred: stamps starredAt on ready variants and reports the count", async () => {
    const caller = createMockCaller({ role: "owner" });

    const result = await caller.studio.setStarred({
      variantIds: ["variant_1"],
      starred: true,
    });

    expect(result).toEqual({ updatedCount: 1 });
    expect(dbState.updated[0].starredAt).toBeInstanceOf(Date);
  });

  it("setStarred: clears starredAt when unstarring", async () => {
    const caller = createMockCaller({ role: "owner" });

    await caller.studio.setStarred({ variantIds: ["variant_1"], starred: false });

    expect(dbState.updated[0].starredAt).toBeNull();
  });
});
