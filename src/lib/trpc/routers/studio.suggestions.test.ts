import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  selects: [] as Array<Record<string, unknown>[]>,
  returning: [] as Array<Record<string, unknown>[]>,
  inserts: [] as Array<Record<string, unknown> | Record<string, unknown>[]>,
  updates: [] as Array<Record<string, unknown>>,
  wheres: [] as unknown[],
  orderBys: [] as unknown[][],
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
    where: vi.fn((clause: unknown) => {
      state.wheres.push(clause);
      return chain;
    }),
    orderBy: vi.fn((...clauses: unknown[]) => {
      state.orderBys.push(clauses);
      return chain;
    }),
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
      where: vi.fn((clause: unknown) => {
        state.wheres.push(clause);
        return chain;
      }),
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
    state.wheres = [];
    state.orderBys = [];
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
    const refreshWhere = new PgDialect().sqlToQuery(
      state.wheres.at(-1) as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    expect(refreshWhere.sql).toContain('"evidence" is null');
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped" }),
        expect.objectContaining({ status: "expired" }),
      ]),
    );
  });

  it("home exposes thin evidence cards and the recently dropped watch count", async () => {
    const thin = suggestion({ id: "thin_1", evidence: "thin" });
    state.selects.push(
      [thin],
      // recent generations
      [],
      // recently expired cards
      [
        { id: "dropped_1", evidence: "thin" },
        { id: "expired_main", evidence: null },
      ],
    );

    const home = await createMockCaller({ role: "owner" }).studio.home();

    expect(home.cards[0].evidence).toBe("thin");
    expect(home.droppedWatch).toBe(1);
    expect(home.expiredCount).toBe(2);
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

  it("soft-warns on a second identical image hash without blocking creation", async () => {
    const createdAt = new Date("2026-07-14T12:00:00Z");
    state.selects.push([], [{ id: "swipe_first", brandName: "Acme", createdAt }]);
    const caller = createMockCaller({ role: "owner" });
    const imageHash = "a".repeat(64);

    const first = await caller.studio.createSwipe({
      imageUrl: "https://store.public.blob.vercel-storage.com/first.png",
      imageHash,
    });
    const second = await caller.studio.createSwipe({
      imageUrl: "https://store.public.blob.vercel-storage.com/second.png",
      imageHash,
    });

    expect(first.duplicateImage).toBeNull();
    expect(second).toMatchObject({
      duplicate: false,
      duplicateImage: { id: "swipe_first", brandName: "Acme", createdAt },
    });
    expect(state.inserts).toHaveLength(2);
  });

  it("combines swipe filter dimensions with AND and selections within each with IN", async () => {
    state.selects.push([], []);
    await createMockCaller({ role: "owner" }).studio.swipes({
      angleIds: ["angle_1", "angle_2"],
      visualStyleIds: ["style_1"],
      hookTypeIds: ["hook_1", "hook_2"],
    });

    const query = new PgDialect().sqlToQuery(state.wheres[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(query.sql).toContain("and");
    expect(query.sql.match(/ in \(/g)).toHaveLength(3);
    expect(query.params).toEqual(expect.arrayContaining([
      "test-org-id", "angle_1", "angle_2", "style_1", "hook_1", "hook_2",
    ]));
  });

  it("uses trigram filtering and ranked ordering for typo-tolerant swipe search", async () => {
    state.selects.push([
      { id: "benefit", brandName: "Benefit Cosmetics", whyItWorks: "Strong offer", angleId: null, hookTypeId: null, visualStyleId: null },
      { id: "other", brandName: "Other", whyItWorks: "Benefit-led layout", angleId: null, hookTypeId: null, visualStyleId: null },
    ], []);
    const rows = await createMockCaller({ role: "owner" }).studio.swipes({ q: "benfit" });

    const where = new PgDialect().sqlToQuery(state.wheres[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    const order = new PgDialect().sqlToQuery(state.orderBys[0][0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(rows.map((row) => row.id)).toEqual(["benefit", "other"]);
    expect(where.sql).toContain(" % ");
    expect(order.sql).toContain("GREATEST(similarity(");
  });

  it("falls back to plain ILIKE for swipe searches shorter than three characters", async () => {
    state.selects.push([], []);
    await createMockCaller({ role: "owner" }).studio.swipes({ q: "be" });

    const where = new PgDialect().sqlToQuery(state.wheres[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(where.sql).toContain("ilike");
    expect(where.sql).not.toContain(" % ");
    expect(where.params).toContain("%be%");
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

  it("queues an extend_winner card through the shared proven-variant path", async () => {
    const claimed = suggestion({
      kind: "extend_winner",
      sourceCreativeId: "creative_1",
      status: "approved",
      claimedAt: new Date(),
    });
    state.returning.push([claimed]);
    state.selects.push(
      [{
        imageUrl: "https://cdn.test/proven.png",
        linkedCreativeId: "creative_1",
        brief: "Original winning brief",
        angle: "Price anchor",
        format: "portrait",
        copyPackageId: null,
      }],
      [{ id: "creative_1" }],
    );

    const result = await createMockCaller({ role: "owner" }).studio.approveSuggestion({
      id: "suggestion_1",
    });

    expect(result).toMatchObject({ generationId: "generation_1" });
    expect(state.inserts[0]).toMatchObject({
      count: 3,
      referenceImageUrls: ["https://cdn.test/proven.png"],
      sourceCreativeId: "creative_1",
    });
    expect(trigger).toHaveBeenCalledWith(
      "generate-static-ads",
      expect.objectContaining({
        count: 3,
        referenceImageUrls: ["https://cdn.test/proven.png"],
      }),
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
