import { beforeEach, describe, expect, it, vi } from "vitest";
import { orgSettings } from "@/schema/org-settings";
import type { FeatureFlags } from "@/lib/feature-flags";

// --- Mocked DB: supports the studio router's select/insert/update chains.
const dbState = {
  groupByRows: [] as Array<Record<string, unknown>[]>,
  selectRows: [] as Array<Record<string, unknown>[]>,
  inserted: [] as Array<Record<string, unknown> | Record<string, unknown>[]>,
  updated: [] as Array<Record<string, unknown>>,
  // The studio procedures gate on this via getOrgFeatureFlags before any
  // handler runs; it is answered off-queue so `selectRows` stays aligned with
  // what each test queues for the handler itself.
  featureFlags: {} as FeatureFlags,
};

const mockDb = {
  select: vi.fn(() => {
    let flagLookup = false;
    const chain: Record<string, unknown> = {
      from: vi.fn((table: unknown) => {
        flagLookup = table === orgSettings;
        return chain;
      }),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      for: vi.fn(() => chain),
      limit: vi.fn(async () =>
        flagLookup
          ? [{ featureFlags: dbState.featureFlags }]
          : (dbState.selectRows.shift() ?? []),
      ),
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
      returning: vi.fn(async () => {
        const updated = dbState.updated.at(-1) ?? {};
        return [{
          id: "variant_1",
          mark: updated.mark ?? null,
          publishedAt: updated.publishedAt ?? null,
          linkedCreativeId: updated.linkedCreativeId ?? null,
        }];
      }),
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
    dbState.selectRows = [];
    dbState.inserted = [];
    dbState.updated = [];
    dbState.featureFlags = { imageStudio: true };
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
      expect.objectContaining({
        generationId: "generation_new",
        organizationId: "test-org-id",
        index: 0,
        status: "pending",
      }),
      expect.objectContaining({
        generationId: "generation_new",
        organizationId: "test-org-id",
        index: 1,
        status: "pending",
      }),
      expect.objectContaining({
        generationId: "generation_new",
        organizationId: "test-org-id",
        index: 2,
        status: "pending",
      }),
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

  it("linkCandidates: ranks a template id hit above angle, fuzzy, and recent matches", async () => {
    dbState.selectRows.push(
      [{ id: "abcdef12-3456-7890-abcd-ef1234567890", angle: "Price anchor" }],
      [
        {
          id: "creative_recent",
          name: "Newest creative",
          assetUrl: null,
          format: "static",
          createdAt: new Date("2026-07-18T00:00:00Z"),
        },
        {
          id: "creative_fuzzy",
          name: "Summer sale",
          assetUrl: null,
          format: "static",
          createdAt: new Date("2026-07-17T00:00:00Z"),
        },
        {
          id: "creative_angle",
          name: "REVIV-ST-price-anchor-111111",
          assetUrl: null,
          format: "static",
          createdAt: new Date("2026-07-16T00:00:00Z"),
        },
        {
          id: "creative_template",
          name: "REVIV-ST-other-angle-abcdef",
          assetUrl: null,
          format: "static",
          createdAt: new Date("2026-07-15T00:00:00Z"),
        },
      ],
    );
    queueGroupBy([]);

    const result = await createMockCaller({ role: "owner" }).studio.linkCandidates({
      variantId: "abcdef12-3456-7890-abcd-ef1234567890",
      search: "sale",
    });

    expect(result.map((row) => [row.id, row.matchReason])).toEqual([
      ["creative_template", "template"],
      ["creative_angle", "angle"],
      ["creative_fuzzy", "fuzzy"],
      ["creative_recent", "recent"],
    ]);
  });

  it("publishAndLink: atomically publishes and links an org creative", async () => {
    dbState.selectRows.push(
      [{ id: "variant_1", publishedAt: null }],
      [{ id: "creative_1" }],
    );

    await createMockCaller({ role: "owner" }).studio.publishAndLink({
      variantId: "variant_1",
      creativeId: "creative_1",
    });

    expect(dbState.updated.at(-1)).toMatchObject({
      publishedAt: expect.any(Date),
      linkedCreativeId: "creative_1",
    });
  });

  it("publishAndLink: publishes without linking and preserves an existing timestamp", async () => {
    const publishedAt = new Date("2026-07-15T00:00:00Z");
    dbState.selectRows.push([{ id: "variant_1", publishedAt }]);

    await createMockCaller({ role: "owner" }).studio.publishAndLink({
      variantId: "variant_1",
      creativeId: null,
    });

    expect(dbState.updated.at(-1)).toMatchObject({ publishedAt });
    expect(dbState.updated.at(-1)?.linkedCreativeId).toBeUndefined();
  });

  it("extendVariant: rejects an image that is not linked to a live creative", async () => {
    dbState.selectRows.push([{
      imageUrl: "https://cdn.test/winner.png",
      linkedCreativeId: null,
      brief: "Original brief",
      angle: "Price anchor",
      format: "square",
      copyPackageId: null,
    }]);

    await expect(
      createMockCaller({ role: "owner" }).studio.extendVariant({
        variantId: "variant_1",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Link this image to a live ad before extending it",
    });
    expect(dbState.inserted).toEqual([]);
  });

  it("extendVariant: queues three variants with the winner as its reference", async () => {
    dbState.selectRows.push(
      [{
        imageUrl: "https://cdn.test/winner.png",
        linkedCreativeId: "creative_1",
        brief: "Original brief",
        angle: "Price anchor",
        format: "portrait",
        copyPackageId: null,
      }],
      [{ id: "creative_1" }],
    );

    const result = await createMockCaller({ role: "owner" }).studio.extendVariant({
      variantId: "variant_1",
    });

    expect(result).toEqual({
      generationId: "generation_new",
      runId: "run_abc123",
    });
    expect(dbState.inserted[0]).toMatchObject({
      brief: expect.stringContaining("Make 3 more like this proven winner"),
      angle: "Price anchor",
      count: 3,
      format: "portrait",
      referenceImageUrls: ["https://cdn.test/winner.png"],
      sourceCreativeId: "creative_1",
    });
    expect(dbState.inserted[1]).toHaveLength(3);
    expect(triggerMock.trigger).toHaveBeenCalledWith(
      "generate-static-ads",
      expect.objectContaining({
        count: 3,
        referenceImageUrls: ["https://cdn.test/winner.png"],
      }),
    );
  });

  it("linkVariantToCreative: links a published variant to an org creative", async () => {
    dbState.selectRows.push(
      [{ id: "variant_1", publishedAt: new Date("2026-07-15T00:00:00Z") }],
      [{ id: "creative_1" }],
    );
    const caller = createMockCaller({ role: "owner" });

    await expect(
      caller.studio.linkVariantToCreative({
        variantId: "variant_1",
        creativeId: "creative_1",
      }),
    ).resolves.toEqual({ ok: true });

    expect(dbState.updated.at(-1)).toMatchObject({
      linkedCreativeId: "creative_1",
      updatedAt: expect.any(Date),
    });
  });

  it("linkVariantToCreative: requires publishing before linking", async () => {
    dbState.selectRows.push([{ id: "variant_1", publishedAt: null }]);
    const caller = createMockCaller({ role: "owner" });

    await expect(
      caller.studio.linkVariantToCreative({
        variantId: "variant_1",
        creativeId: "creative_1",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Publish the image first",
    });

    expect(dbState.updated).toEqual([]);
    expect(dbState.selectRows).toEqual([]);
  });

  it("setVariantMark: marks a ready variant Good", async () => {
    const caller = createMockCaller({ role: "owner" });

    await caller.studio.setVariantMark({
      variantId: "variant_1",
      mark: "good",
    });

    expect(dbState.updated[0].mark).toBe("good");
  });

  it("setVariantMark: clears the mark and published state", async () => {
    const caller = createMockCaller({ role: "owner" });

    await caller.studio.setVariantMark({ variantId: "variant_1", mark: null });

    expect(dbState.updated[0]).toMatchObject({ mark: null, publishedAt: null });
  });

  it("studioProcedure: hides the router behind NOT_FOUND when the org's imageStudio flag is off", async () => {
    dbState.featureFlags = {};
    const caller = createMockCaller({ role: "owner" });

    await expect(caller.studio.winningAngles()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // The gate runs before the handler, so no query was queued or consumed.
    expect(dbState.groupByRows).toHaveLength(0);
  });
});
