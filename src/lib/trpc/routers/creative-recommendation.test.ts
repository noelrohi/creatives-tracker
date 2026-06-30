import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = {
  executeRows: [] as Array<Record<string, unknown>[]>,
  insertValues: [] as unknown[],
  insertRows: [] as Array<Record<string, unknown>[]>,
  updateValues: [] as unknown[],
  updateRows: [] as Array<Record<string, unknown>[]>,
};

const mockDb = {
  execute: vi.fn(async () => ({ rows: mockState.executeRows.shift() ?? [] })),
  transaction: vi.fn(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb)),
  insert: vi.fn(() => ({
    values: vi.fn((values: unknown) => {
      mockState.insertValues.push(values);
      return {
        returning: vi.fn(async () => mockState.insertRows.shift() ?? []),
      };
    }),
  })),
  update: vi.fn(() => ({
    set: vi.fn((values: unknown) => {
      mockState.updateValues.push(values);
      return {
        where: vi.fn(() => ({
          returning: vi.fn(async () => mockState.updateRows.shift() ?? []),
        })),
      };
    }),
  })),
  select: vi.fn(),
};

const mockGenerateCreativeVariants = vi.fn();
const mockHasCreativeVariantAiConfig = vi.fn(() => true);

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("@/lib/creative-recommendations", () => ({
  CREATIVE_VARIANT_PROMPT_VERSION: "static-winner-variant-v1",
  generateCreativeVariants: mockGenerateCreativeVariants,
  hasCreativeVariantAiConfig: mockHasCreativeVariantAiConfig,
}));
vi.mock("server-only", () => ({}));

const { createMockCaller } = await import("../test-helpers");

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    creative_id: "creative-1",
    creative_name: "Winning creative",
    asset_url: "https://example.com/win.jpg",
    video_url: null,
    format: "static",
    angle: "sleep quality",
    persona: "busy professionals",
    awareness_level: "problem_aware",
    hook: "Stop waking up tired",
    tone: ["clinical"],
    cta: "Shop Now",
    source_ad_id: "ad-1",
    source_ad_name: "Winning ad",
    caption: "This is the winning primary text.",
    destination_url: "https://example.com/products",
    status: "active",
    spend: "150",
    revenue: "450",
    conversions: "9",
    impressions: "10000",
    roas: "3",
    cpa: "16.6667",
    ctr: "1.25",
    video_views_3s: "0",
    video_thruplay: "0",
    ...overrides,
  };
}

const generatedCopy = {
  variantName: "Hook shift",
  primaryText: "You noticed the problem. This is the next step.",
  headline: "A cleaner daily routine",
  hook: "Stop ignoring the signal",
  cta: "Shop Now",
  visualDirection: "Single-frame product close-up with a concise benefit overlay.",
  changeSummary: "Leads with the pain point instead of the benefit.",
  rationale: "Tests a more urgent opening while preserving the winning premise.",
  riskNotes: null,
};

describe("creativeRecommendationRouter", () => {
  beforeEach(() => {
    mockState.executeRows = [];
    mockState.insertValues = [];
    mockState.insertRows = [];
    mockState.updateValues = [];
    mockState.updateRows = [];
    vi.clearAllMocks();
    process.env.ADSOLUTE_RECOMMENDATIONS_ENABLED = "true";
    mockHasCreativeVariantAiConfig.mockReturnValue(true);
    mockGenerateCreativeVariants.mockResolvedValue({
      model: "test-model",
      variants: [generatedCopy, generatedCopy, generatedCopy, generatedCopy],
    });
  });

  it("blocks API access when the recommendations feature flag is disabled", async () => {
    process.env.ADSOLUTE_RECOMMENDATIONS_ENABLED = "false";
    const caller = createMockCaller({
      role: "admin",
      organizationId: "org-1",
    });

    await expect(
      caller.creativeRecommendation.listCandidates({
        from: "2026-06-01",
        to: "2026-06-30",
      }),
    ).rejects.toThrow("recommendations is not enabled");
  });

  it("returns SQL-filtered static candidate results", async () => {
    mockState.executeRows.push(
      [candidateRow()],
      [],
    );

    const caller = createMockCaller({
      role: "admin",
      organizationId: "org-1",
    });
    const result = await caller.creativeRecommendation.listCandidates({
      from: "2026-06-01",
      to: "2026-06-30",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.sourceCreativeId).toBe("creative-1");
    expect(result[0]?.format).toBe("static");
  });

  it("returns current-window candidate batches with variants from the server view model", async () => {
    mockState.executeRows.push(
      [candidateRow()],
      [
        {
          id: "batch-1",
          source_creative_id: "creative-1",
          source_ad_id: "ad-1",
          generated_count: 4,
          created_at: new Date("2026-06-20T00:00:00.000Z"),
          pending_count: 3,
          good_count: 1,
          bad_count: 0,
        },
        {
          id: "other-ad-batch",
          source_creative_id: "creative-1",
          source_ad_id: "other-ad",
          generated_count: 4,
          created_at: new Date("2026-06-21T00:00:00.000Z"),
          pending_count: 4,
          good_count: 0,
          bad_count: 0,
        },
      ],
      [
        {
          id: "variant-1",
          batch_id: "batch-1",
          position: 1,
          status: "good",
          copy: generatedCopy,
        },
      ],
    );

    const caller = createMockCaller({
      role: "admin",
      organizationId: "org-1",
    });
    const result = await caller.creativeRecommendation.listCandidates({
      from: "2026-06-01",
      to: "2026-06-30",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.performanceSnapshot).toMatchObject({
      from: "2026-06-01",
      to: "2026-06-30",
      roas: 3,
    });
    expect(result[0]?.latestBatch).toMatchObject({
      id: "batch-1",
      sourceAdId: "ad-1",
      goodCount: 1,
    });
    expect(result[0]?.latestBatch?.variants).toHaveLength(1);
    expect(result[0]?.latestBatch?.variants[0]?.id).toBe("variant-1");
  });

  it("returns approved variants from their own endpoint", async () => {
    mockState.executeRows.push([
      {
        batch_id: "batch-1",
        source_creative_id: "creative-1",
        source_name: "Winning creative",
        window_from: "2026-06-01",
        window_to: "2026-06-30",
        variant_id: "variant-1",
        position: 1,
        status: "good",
        copy: generatedCopy,
      },
    ]);

    const caller = createMockCaller({
      role: "admin",
      organizationId: "org-1",
    });
    const result = await caller.creativeRecommendation.listApprovedVariants();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      batchId: "batch-1",
      sourceCreativeId: "creative-1",
      sourceName: "Winning creative",
      variant: { id: "variant-1", status: "good" },
    });
  });

  it("persists a generated batch and child variants after model validation", async () => {
    mockState.executeRows.push([candidateRow()]);
    mockState.insertRows.push(
      [
        {
          id: "batch-1",
          organizationId: "org-1",
          sourceCreativeId: "creative-1",
          sourceAdId: "ad-1",
          generatedCount: 4,
        },
      ],
      [
        { id: "variant-1", batchId: "batch-1", position: 1, copy: generatedCopy },
        { id: "variant-2", batchId: "batch-1", position: 2, copy: generatedCopy },
        { id: "variant-3", batchId: "batch-1", position: 3, copy: generatedCopy },
        { id: "variant-4", batchId: "batch-1", position: 4, copy: generatedCopy },
      ],
    );

    const caller = createMockCaller({
      role: "admin",
      userId: "user-1",
      organizationId: "org-1",
    });
    const result = await caller.creativeRecommendation.generateVariants({
      sourceCreativeId: "creative-1",
      sourceAdId: "ad-1",
      from: "2026-06-01",
      to: "2026-06-30",
    });

    expect(result.variants).toHaveLength(4);
    expect(mockGenerateCreativeVariants).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ creativeName: "Winning creative" }),
        performance: expect.objectContaining({ roas: 3, conversions: 9 }),
      }),
    );
    expect(mockState.insertValues[0]).toMatchObject({
      organizationId: "org-1",
      sourceCreativeId: "creative-1",
      sourceAdId: "ad-1",
      model: "test-model",
      promptVersion: "static-winner-variant-v1",
      generatedCount: 4,
      createdByUserId: "user-1",
    });
    expect(mockState.insertValues[1]).toHaveLength(4);
  });

  it("rejects direct generation when SQL eligibility returns no candidate", async () => {
    mockState.executeRows.push([]);

    const caller = createMockCaller({
      role: "admin",
      organizationId: "org-1",
    });

    await expect(
      caller.creativeRecommendation.generateVariants({
        sourceCreativeId: "creative-1",
        from: "2026-06-01",
        to: "2026-06-30",
      }),
    ).rejects.toThrow("eligible static winner");

    expect(mockGenerateCreativeVariants).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("rejects direct generation for candidates without source context before calling the model", async () => {
    mockState.executeRows.push([]);

    const caller = createMockCaller({
      role: "admin",
      organizationId: "org-1",
    });

    await expect(
      caller.creativeRecommendation.generateVariants({
        sourceCreativeId: "creative-1",
        from: "2026-06-01",
        to: "2026-06-30",
      }),
    ).rejects.toThrow("eligible static winner");

    expect(mockGenerateCreativeVariants).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("blocks generation for read-only members", async () => {
    const caller = createMockCaller({ role: "member" });

    await expect(
      caller.creativeRecommendation.generateVariants({
        sourceCreativeId: "creative-1",
        from: "2026-06-01",
        to: "2026-06-30",
      }),
    ).rejects.toThrow("Only organization admins can modify data");
  });

  it("updates review status and reviewer", async () => {
    mockState.updateRows.push([
      {
        id: "variant-1",
        status: "good",
        reviewedByUserId: "user-1",
      },
    ]);

    const caller = createMockCaller({
      role: "admin",
      userId: "user-1",
      organizationId: "org-1",
    });
    const result = await caller.creativeRecommendation.reviewVariant({
      variantId: "variant-1",
      status: "good",
    });

    expect(result).toMatchObject({ id: "variant-1", status: "good" });
    expect(mockState.updateValues[0]).toMatchObject({
      status: "good",
      reviewedByUserId: "user-1",
    });
  });

  it("returns not found when review cannot find an org-scoped variant", async () => {
    mockState.updateRows.push([]);
    const caller = createMockCaller({ role: "admin", organizationId: "org-1" });

    await expect(
      caller.creativeRecommendation.reviewVariant({
        variantId: "variant-from-another-org",
        status: "bad",
      }),
    ).rejects.toThrow("Variant not found");
  });
});
