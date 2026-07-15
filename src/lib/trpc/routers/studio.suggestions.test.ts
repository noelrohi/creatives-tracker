import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  selects: [] as Array<Record<string, unknown>[]>,
  returning: [] as Array<Record<string, unknown>[]>,
  inserts: [] as Array<Record<string, unknown> | Record<string, unknown>[]>,
  updates: [] as Array<Record<string, unknown>>,
  generation: 0,
};

function selectChain() {
  let consumed = false;
  let rows: Record<string, unknown>[] = [];
  const consume = () => {
    if (!consumed) {
      consumed = true;
      rows = state.selects.shift() ?? [];
    }
    return rows;
  };
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    for: vi.fn(() => chain),
    then: (resolve: (value: Record<string, unknown>[]) => unknown) =>
      Promise.resolve(consume()).then(resolve),
  };
  return chain;
}

const mockDb = {
  select: vi.fn(() => selectChain()),
  insert: vi.fn(() => {
    let inserted: Record<string, unknown> | Record<string, unknown>[] = {};
    const chain: Record<string, unknown> = {
      values: vi.fn((value: typeof inserted) => {
        inserted = value;
        state.inserts.push(value);
        return chain;
      }),
      returning: vi.fn(async () => {
        if (!Array.isArray(inserted) && inserted.brief && inserted.count) {
          state.generation += 1;
          return [{ id: `generation_${state.generation}`, ...inserted }];
        }
        return [{ id: "inserted_row", ...inserted }];
      }),
      onConflictDoNothing: vi.fn(() => chain),
      onConflictDoUpdate: vi.fn(() => chain),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
    };
    return chain;
  }),
  update: vi.fn(() => {
    const chain: Record<string, unknown> = {
      set: vi.fn((value: Record<string, unknown>) => {
        state.updates.push(value);
        return chain;
      }),
      where: vi.fn(() => chain),
      returning: vi.fn(async () => state.returning.shift() ?? []),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
    };
    return chain;
  }),
  delete: vi.fn(() => {
    const chain: Record<string, unknown> = {
      where: vi.fn(() => chain),
      returning: vi.fn(async () => state.returning.shift() ?? []),
    };
    return chain;
  }),
};
Object.assign(mockDb, {
  transaction: vi.fn(async (callback: (tx: typeof mockDb) => Promise<unknown>) =>
    callback(mockDb),
  ),
});

const trigger = vi.fn(async (...args: unknown[]) => {
  void args;
  return { id: "run_1" };
});
vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));
vi.mock("@vercel/blob", () => ({ del: vi.fn(async () => undefined) }));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: (...args: unknown[]) => trigger(...args) },
  auth: { createPublicToken: vi.fn(async () => "token") },
}));

const { createMockCaller } = await import("../test-helpers");

function suggestion(overrides: Record<string, unknown> = {}) {
  return {
    id: "suggestion_1",
    organizationId: "test-org-id",
    sourceCreativeId: null,
    swipeId: null,
    kind: "new_hooks",
    title: "Try a sharper hook",
    whyLine: "The winner has room for another hook.",
    brief: "Keep the winner and change the headline.",
    elements: null,
    angle: "Problem first",
    angleId: null,
    visualStyleId: null,
    persona: null,
    awarenessLevel: null,
    roas: "4",
    purchases: 12,
    spend: "100",
    format: "square",
    count: 3,
    copyPackageId: null,
    generationId: null,
    status: "proposed",
    claimedAt: null,
    actionedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("studio router — v2 lifecycle", () => {
  beforeEach(() => {
    state.selects = [];
    state.returning = [];
    state.inserts = [];
    state.updates = [];
    state.generation = 0;
    vi.clearAllMocks();
  });

  it("moves a proposal to skipped and refresh expires unactioned proposals", async () => {
    state.returning.push(
      [{ id: "suggestion_1", status: "skipped" }],
      [{ id: "old_1" }, { id: "old_2" }],
    );
    const caller = createMockCaller({ role: "owner" });

    await expect(
      caller.studio.setSuggestionStatus({
        suggestionId: "suggestion_1",
        status: "skipped",
      }),
    ).resolves.toEqual({ id: "suggestion_1", status: "skipped" });
    const refreshed = await caller.studio.refreshSuggestions();

    expect(refreshed).toMatchObject({ expiredCount: 2, runId: "run_1" });
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped" }),
        expect.objectContaining({ status: "expired" }),
      ]),
    );
  });

  it("warns on a duplicate swipe URL and archives an existing swipe", async () => {
    const existing = {
      id: "swipe_1",
      organizationId: "test-org-id",
      imageUrl: "https://store.public.blob.vercel-storage.com/swipe.png",
      sourceUrl: "https://example.test/ad",
    };
    state.selects.push([existing]);
    state.returning.push([{ ...existing, archivedAt: new Date() }]);
    const caller = createMockCaller({ role: "owner" });

    const duplicate = await caller.studio.createSwipe({
      imageUrl: "https://store.public.blob.vercel-storage.com/new.png",
      sourceUrl: "https://example.test/ad",
    });
    expect(duplicate).toMatchObject({ duplicate: true, swipe: { id: "swipe_1" } });
    expect(state.inserts).toHaveLength(0);

    await caller.studio.archiveSwipe({ id: "swipe_1", archived: true });
    expect(state.updates.at(-1)?.archivedAt).toBeInstanceOf(Date);
  });

  it("rejects a foreign screenshot URL instead of storing an expiring asset", async () => {
    await expect(
      createMockCaller({ role: "owner" }).studio.createSwipe({
        imageUrl: "https://competitor.example/ad.png",
      }),
    ).rejects.toThrow("must be uploaded before saving");
    expect(state.inserts).toHaveLength(0);
  });

  it("creates, updates, and hard-deletes a swipe", async () => {
    state.returning.push(
      [{ id: "inserted_row", brandName: "Updated brand" }],
      [{ id: "inserted_row" }],
    );
    state.selects.push([{ imageUrl: "https://store.public.blob.vercel-storage.com/swipe.png" }]);
    const caller = createMockCaller({ role: "owner" });

    const created = await caller.studio.createSwipe({
      imageUrl: "https://store.public.blob.vercel-storage.com/swipe.png",
      brandName: "Brand",
    });
    expect(created).toMatchObject({ duplicate: false, swipe: { id: "inserted_row" } });

    await caller.studio.updateSwipe({ id: "inserted_row", brandName: "Updated brand" });
    await expect(caller.studio.deleteSwipe({ id: "inserted_row" })).resolves.toEqual({
      deleted: true,
    });
  });

  it("creates a manual Meta-trio copy package", async () => {
    state.selects.push([{ id: "angle_1" }]);
    const result = await createMockCaller({ role: "owner" }).studio.createCopyPackage({
      name: "Problem-first winner",
      angleId: "angle_1",
      primaryText: "Primary text",
      headline: "Headline",
      description: "Description",
    });

    expect(result).toMatchObject({
      name: "Problem-first winner",
      primaryText: "Primary text",
      headline: "Headline",
      description: "Description",
    });
  });

  it("saves a synced creative's Meta copy as an angle-tagged package", async () => {
    state.selects.push(
      [
        {
          id: "creative_1",
          name: "Winning ad",
          angle: "Problem first",
          caption: "Proven primary text",
        },
      ],
      [{ id: "angle_1" }],
    );
    const result = await createMockCaller({ role: "owner" })
      .studio.createCopyPackageFromCreative({
        creativeId: "creative_1",
        angleId: "angle_1",
      });

    expect(result).toMatchObject({
      sourceCreativeId: "creative_1",
      angleId: "angle_1",
      primaryText: "Proven primary text",
      headline: "Winning ad",
    });
  });

  it("defaults approval to the angle's latest package and claim-first prevents a double queue", async () => {
    const claimed = suggestion({
      angleId: "angle_1",
      kind: "rebrand_swipe",
      swipeId: "swipe_1",
      status: "approved",
      claimedAt: new Date(),
    });
    state.returning.push([claimed], []);
    state.selects.push(
      [{
        id: "swipe_1",
        imageUrl: "https://store.public.blob.vercel-storage.com/swipe.png",
        brandName: "Competitor",
        elements: null,
      }],
      [{ id: "package_latest" }],
      // brand profile lookup (none configured)
      [],
      [{ id: "swipe_1" }],
      [{ id: "package_latest" }],
    );
    const caller = createMockCaller({ role: "owner" });

    const attempts = await Promise.allSettled([
      caller.studio.approveSuggestion({ id: "suggestion_1" }),
      caller.studio.approveSuggestion({ id: "suggestion_1" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "fulfilled",
          value: expect.objectContaining({ generationId: "generation_1" }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ message: "This suggestion is already queued" }),
        }),
      ]),
    );
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      "generate-static-ads",
      expect.objectContaining({
        referenceImageUrls: ["https://store.public.blob.vercel-storage.com/swipe.png"],
      }),
    );
    expect(state.inserts).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({ copyPackageId: "package_latest" }),
      ]),
    );
  });

  it("marks Good/Bad/null and only publishes through the Good transition", async () => {
    state.returning.push(
      [{ id: "variant_1", mark: "good", publishedAt: null }],
      [{ id: "variant_1", publishedAt: new Date() }],
      [{ id: "variant_1", mark: "bad", publishedAt: null }],
    );
    const caller = createMockCaller({ role: "owner" });

    await caller.studio.setVariantMark({ variantId: "variant_1", mark: "good" });
    await caller.studio.setVariantPublished({ variantId: "variant_1", published: true });
    await caller.studio.setVariantMark({ variantId: "variant_1", mark: "bad" });

    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mark: "good" }),
        expect.objectContaining({ publishedAt: expect.any(Date) }),
        expect.objectContaining({ mark: "bad", publishedAt: null }),
      ]),
    );
  });
});
