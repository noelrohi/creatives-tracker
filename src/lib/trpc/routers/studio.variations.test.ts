import { beforeEach, describe, expect, it, vi } from "vitest";
import { orgSettings } from "@/schema/org-settings";
import type { FeatureFlags } from "@/lib/feature-flags";

const dbState = {
  selectRows: [] as Array<Record<string, unknown>[]>,
  inserted: [] as Array<Record<string, unknown> | Record<string, unknown>[]>,
  updated: [] as Array<Record<string, unknown>>,
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
      // retryVariant ends its row lock query with .for("update"), so it must
      // resolve rows like limit() does.
      for: vi.fn(async () => dbState.selectRows.shift() ?? []),
      limit: vi.fn(async () =>
        flagLookup ? [{ featureFlags: dbState.featureFlags }] : (dbState.selectRows.shift() ?? []),
      ),
    };
    return chain;
  }),
  delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  insert: vi.fn(() => {
    const chain: Record<string, unknown> = {
      values: vi.fn((row: Record<string, unknown> | Record<string, unknown>[]) => {
        dbState.inserted.push(row);
        return chain;
      }),
      returning: vi.fn(async () => {
        const last = dbState.inserted[dbState.inserted.length - 1] as Record<string, unknown>;
        return [{ id: last.brief ? "generation_new" : "variant_new", ...last }];
      }),
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
      returning: vi.fn(async () => []),
    };
    return chain;
  }),
};
Object.assign(mockDb, {
  transaction: vi.fn(async (callback: (tx: typeof mockDb) => Promise<unknown>) => callback(mockDb)),
});

const triggerMock = {
  trigger: vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({ id: "run_var_1" })),
  createPublicToken: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "public_token_xyz"),
};

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: (...a: unknown[]) => triggerMock.trigger(...a) },
  auth: { createPublicToken: (...a: unknown[]) => triggerMock.createPublicToken(...a) },
}));

const { createMockCaller } = await import("../test-helpers");

const staticCreative = { id: "cr_1", name: "One nightly habit", assetUrl: "https://cdn.test/one.png", format: "static" };

describe("studio.variations", () => {
  beforeEach(() => {
    dbState.selectRows = [];
    dbState.inserted = [];
    dbState.updated = [];
    dbState.featureFlags = { imageStudio: true };
    vi.clearAllMocks();
    triggerMock.trigger.mockResolvedValue({ id: "run_var_1" });
    triggerMock.createPublicToken.mockResolvedValue("public_token_xyz");
  });

  it("create: inserts a kind=variation generation with one pending variant, queues generate-variation, and returns ids + token", async () => {
    const caller = createMockCaller({ role: "owner" });
    dbState.selectRows.push([staticCreative]);

    const result = await caller.studio.variations.create({ sourceCreativeId: "cr_1", note: "keep the blue" });

    expect(result).toEqual({
      generationId: "generation_new",
      variantId: "variant_new",
      realtime: { runId: "run_var_1", publicAccessToken: "public_token_xyz" },
    });
    expect(dbState.inserted[0]).toMatchObject({
      organizationId: "test-org-id",
      kind: "variation",
      count: 1,
      format: "portrait",
      brief: "Variation of One nightly habit",
      sourceCreativeId: "cr_1",
      note: "keep the blue",
      referenceImageUrls: ["https://cdn.test/one.png"],
    });
    expect(dbState.inserted[1]).toMatchObject({ generationId: "generation_new", organizationId: "test-org-id", index: 0, status: "pending" });
    expect(triggerMock.trigger).toHaveBeenCalledWith("generate-variation", {
      organizationId: "test-org-id",
      generationId: "generation_new",
      variantId: "variant_new",
      source: { kind: "creative", id: "cr_1" },
      note: "keep the blue",
    });
    expect(dbState.updated[0]).toMatchObject({ runId: "run_var_1" });
  });

  it("create: rejects a creative that is not a static image", async () => {
    const caller = createMockCaller({ role: "owner" });
    dbState.selectRows.push([{ ...staticCreative, format: "video" }]);
    await expect(caller.studio.variations.create({ sourceCreativeId: "cr_1" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Variations need a static image creative",
    });

    dbState.selectRows.push([{ ...staticCreative, assetUrl: "https://cdn.test/clip.mp4" }]);
    await expect(caller.studio.variations.create({ sourceCreativeId: "cr_1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    dbState.selectRows.push([{ ...staticCreative, assetUrl: null }]);
    await expect(caller.studio.variations.create({ sourceCreativeId: "cr_1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(triggerMock.trigger).not.toHaveBeenCalled();
  });

  it("create: rejects a source the query does not return", async () => {
    const caller = createMockCaller({ role: "owner" });
    dbState.selectRows.push([]);
    await expect(caller.studio.variations.create({ sourceCreativeId: "cr_other" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("create: marks the generation failed when triggering throws", async () => {
    const caller = createMockCaller({ role: "owner" });
    dbState.selectRows.push([staticCreative]);
    triggerMock.trigger.mockRejectedValueOnce(new Error("queue down"));
    await expect(caller.studio.variations.create({ sourceCreativeId: "cr_1" })).rejects.toThrow("queue down");
    expect(dbState.updated.some((row) => row.status === "failed")).toBe(true);
  });

  it("create: members cannot queue variations", async () => {
    const caller = createMockCaller({ role: "member" });
    await expect(caller.studio.variations.create({ sourceCreativeId: "cr_1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listForCreative: returns that source's variations in query order with a token only for generating rows", async () => {
    const caller = createMockCaller({ role: "member" });
    const now = new Date();
    dbState.selectRows.push([
      {
        id: "gen_2", status: "generating", runId: "run_2", note: null, format: "portrait", createdAt: now, updatedAt: now,
        variantId: "var_2", variantStatus: "generating", imageUrl: null, plan: null, attempts: null, mark: null, publishedAt: null, moderationReason: null,
      },
      {
        id: "gen_1", status: "completed", runId: "run_1", note: "blue", format: "square", createdAt: now, updatedAt: now,
        variantId: "var_1", variantStatus: "ready", imageUrl: "https://blob.test/1.png", plan: { summary: "s", kept: [], changed: ["headline"], rationale: "r", evidence: [], inImageCopy: [], finalAttempt: 1 }, attempts: [], mark: "good", publishedAt: null, moderationReason: null,
      },
    ]);

    const result = await caller.studio.variations.listForCreative({ creativeId: "cr_1" });

    expect(result).toEqual([
      expect.objectContaining({
        id: "gen_2",
        status: "generating",
        realtime: { runId: "run_2", publicAccessToken: "public_token_xyz" },
        variant: expect.objectContaining({ id: "var_2", status: "generating" }),
      }),
      expect.objectContaining({
        id: "gen_1",
        status: "completed",
        note: "blue",
        format: "square",
        realtime: null,
        variant: expect.objectContaining({ id: "var_1", status: "ready", imageUrl: "https://blob.test/1.png", mark: "good" }),
      }),
    ]);
    expect(triggerMock.createPublicToken).toHaveBeenCalledTimes(1);
  });

  it("listForCreative: marks a generating row stale after 15 minutes and drops its token", async () => {
    const caller = createMockCaller({ role: "member" });
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    dbState.selectRows.push([
      {
        id: "gen_stale", status: "generating", runId: "run_stale", note: null, format: "portrait",
        createdAt: stale, updatedAt: stale,
        variantId: "var_stale", variantStatus: "pending", imageUrl: null, plan: null, attempts: null,
        mark: null, publishedAt: null, moderationReason: null,
      },
    ]);
    const [row] = await caller.studio.variations.listForCreative({ creativeId: "cr_1" });
    expect(row).toMatchObject({ id: "gen_stale", status: "failed", realtime: null, variant: expect.objectContaining({ id: "var_stale", status: "failed" }) });
    expect(triggerMock.createPublicToken).not.toHaveBeenCalled();
  });

  it("create: stores a whitespace-only note as null", async () => {
    const caller = createMockCaller({ role: "owner" });
    dbState.selectRows.push([staticCreative]);
    await caller.studio.variations.create({ sourceCreativeId: "cr_1", note: "   " });
    expect(dbState.inserted[0]).toMatchObject({ note: null });
    expect(triggerMock.trigger).toHaveBeenCalledWith("generate-variation", expect.objectContaining({ note: null }));
  });
});
