import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = {
  selectRows: [] as Array<Record<string, unknown>[]>,
  updateReturningRows: [] as Array<Record<string, unknown>[]>,
  inserted: [] as Array<Record<string, unknown> | Record<string, unknown>[]>,
  updates: [] as Array<{
    values: Record<string, unknown>;
    where?: unknown;
  }>,
  generationNumber: 0,
};

function queuedSelectChain() {
  let consumed = false;
  let result: Record<string, unknown>[] = [];
  const resolveRows = () => {
    if (!consumed) {
      consumed = true;
      result = dbState.selectRows.shift() ?? [];
    }
    return result;
  };
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    groupBy: vi.fn(async () => resolveRows()),
    then: (
      resolve: (rows: Record<string, unknown>[]) => unknown,
      reject: (error: unknown) => unknown,
    ) => Promise.resolve(resolveRows()).then(resolve, reject),
  };
  return chain;
}

const mockDb = {
  select: vi.fn(() => queuedSelectChain()),
  insert: vi.fn(() => {
    let inserted: Record<string, unknown> | Record<string, unknown>[] = {};
    const chain: Record<string, unknown> = {
      values: vi.fn((value: Record<string, unknown> | Record<string, unknown>[]) => {
        inserted = value;
        dbState.inserted.push(value);
        return chain;
      }),
      returning: vi.fn(async () => {
        if (!Array.isArray(inserted) && inserted.brief) {
          dbState.generationNumber += 1;
          return [{ id: `generation_${dbState.generationNumber}`, ...inserted }];
        }
        return [{ id: "inserted_row", ...inserted }];
      }),
      then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    return chain;
  }),
  update: vi.fn(() => {
    const update = { values: {} as Record<string, unknown>, where: undefined as unknown };
    const chain: Record<string, unknown> = {
      set: vi.fn((values: Record<string, unknown>) => {
        update.values = values;
        dbState.updates.push(update);
        return chain;
      }),
      where: vi.fn((condition: unknown) => {
        update.where = condition;
        return chain;
      }),
      returning: vi.fn(async () => dbState.updateReturningRows.shift() ?? []),
      then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    return chain;
  }),
};

Object.assign(mockDb, {
  transaction: vi.fn(
    async (callback: (tx: typeof mockDb) => Promise<unknown>) => callback(mockDb),
  ),
});

const triggerMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(
  async () => ({ id: "run_1" }),
);

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: (...args: unknown[]) => triggerMock(...args) },
  auth: { createPublicToken: vi.fn(async () => "public_token") },
}));

const { createMockCaller } = await import("../test-helpers");

function queueSelect(...rows: Array<Record<string, unknown>[]>) {
  dbState.selectRows.push(...rows);
}

function collectPrimitiveValues(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value == null || typeof value !== "object") return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  const values: unknown[] = [];
  for (const child of Object.values(value as Record<string, unknown>)) {
    values.push(...collectPrimitiveValues(child, seen));
  }
  return values;
}

const elements = {
  headline: { action: "change" as const, value: "A sharper hook" },
  heroImage: { action: "keep" as const },
  background: { action: "keep" as const },
  offer: { action: "keep" as const },
  cta: { action: "keep" as const },
};

function approvedVariant(id: string) {
  return {
    id,
    headline: "A sharper hook",
    diffSummary: "Only the headline changes from the winner.",
    copyLine: "Wake up ready.",
    elements,
    format: "square",
    sourceCreativeId: "creative_1",
    title: "Our top winner",
    angle: "Problem first",
    persona: "Busy parents",
    awarenessLevel: "problem_aware",
  };
}

function queueSourceCreative() {
  queueSelect(
    [
      {
        id: "creative_1",
        name: "Airflow winner",
        assetUrl: "https://cdn.test/winner.png",
      },
    ],
    [
      {
        creativeId: "creative_1",
        name: "Airflow winner",
        angle: "Problem first",
        persona: "Busy parents",
        awarenessLevel: "problem_aware",
        assetUrl: "https://cdn.test/winner.png",
        spend: "100",
        purchases: 12,
        purchaseValue: "400",
        roas: "4",
        adCount: 1,
      },
    ],
  );
}

describe("studio router — suggestions", () => {
  beforeEach(() => {
    dbState.selectRows = [];
    dbState.updateReturningRows = [];
    dbState.inserted = [];
    dbState.updates = [];
    dbState.generationNumber = 0;
    vi.clearAllMocks();
    triggerMock.mockResolvedValue({ id: "run_1" });
  });

  it("setSuggestionStatus updates mutable rows and refuses generated rows in the where clause", async () => {
    const caller = createMockCaller({ role: "owner" });
    dbState.updateReturningRows.push(
      [{ id: "variant_1", status: "approved" }],
      [],
    );

    await expect(
      caller.studio.setSuggestionStatus({
        variantId: "variant_1",
        status: "approved",
      }),
    ).resolves.toEqual({ id: "variant_1", status: "approved" });

    const whereValues = collectPrimitiveValues(dbState.updates[0].where);
    expect(whereValues).toEqual(
      expect.arrayContaining(["suggested", "approved", "skipped"]),
    );
    expect(whereValues).not.toContain("generated");

    await expect(
      caller.studio.setSuggestionStatus({
        variantId: "variant_generated",
        status: "skipped",
      }),
    ).rejects.toThrow("Generated suggestions cannot be changed");
  });

  it("suggestions maps active cards to ordered variants and source creative summaries", async () => {
    const createdAt = new Date("2026-07-13T08:00:00.000Z");
    queueSelect(
      [
        {
          id: "suggestion_1",
          sourceCreativeId: "creative_1",
          kind: "new_hooks",
          title: "Airflow — your top ad",
          whyLine: "This winner has room for fresh hooks.",
          angle: "Problem first",
          persona: "Busy parents",
          awarenessLevel: "problem_aware",
          roas: "4",
          purchases: 12,
          spend: "100",
          status: "active",
          createdAt,
          updatedAt: createdAt,
        },
      ],
      [
        {
          id: "variant_1",
          suggestionId: "suggestion_1",
          index: 0,
          headline: "A sharper hook",
          diffSummary: "Only the headline changes from the winner.",
          copyLine: "Wake up ready.",
          elements,
          format: "square",
          status: "suggested",
          generationId: null,
          createdAt,
          updatedAt: createdAt,
        },
      ],
    );
    queueSourceCreative();

    const result = await createMockCaller({ role: "owner" }).studio.suggestions();

    expect(result).toMatchObject({
      generatedAt: createdAt,
      isRefreshing: false,
      cards: [
        {
          id: "suggestion_1",
          source: {
            id: "creative_1",
            name: "Airflow winner",
            assetUrl: "https://cdn.test/winner.png",
            roas: 4,
          },
          variants: [{ id: "variant_1", index: 0 }],
        },
      ],
    });
  });

  it("generateApproved creates a one-image generation and marks the suggestion generated", async () => {
    queueSelect([approvedVariant("variant_1")]);
    queueSourceCreative();
    queueSelect([{ id: "creative_1" }]);

    const result = await createMockCaller({ role: "owner" }).studio.generateApproved();

    expect(result).toEqual({ queued: 1, failed: 0 });
    expect(dbState.inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: "test-org-id",
          count: 1,
          format: "square",
          referenceImageUrls: ["https://cdn.test/winner.png"],
          sourceCreativeId: "creative_1",
        }),
        [
          {
            generationId: "generation_1",
            organizationId: "test-org-id",
            index: 0,
            status: "pending",
          },
        ],
      ]),
    );
    expect(triggerMock).toHaveBeenCalledWith(
      "generate-static-ads",
      expect.objectContaining({
        generationId: "generation_1",
        count: 1,
        referenceImageUrls: ["https://cdn.test/winner.png"],
      }),
    );
    expect(dbState.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({
            status: "generated",
            generationId: "generation_1",
          }),
        }),
      ]),
    );
  });

  it("generateApproved continues after one variant trigger fails", async () => {
    queueSelect([
      approvedVariant("variant_1"),
      approvedVariant("variant_2"),
    ]);
    queueSourceCreative();
    queueSelect([{ id: "creative_1" }], [{ id: "creative_1" }]);
    triggerMock
      .mockResolvedValueOnce({ id: "run_1" })
      .mockRejectedValueOnce(new Error("Trigger unavailable"));

    const result = await createMockCaller({ role: "owner" }).studio.generateApproved();

    expect(result).toEqual({ queued: 1, failed: 1 });
    expect(triggerMock).toHaveBeenCalledTimes(2);
    const generatedUpdates = dbState.updates.filter(
      (update) => update.values.status === "generated",
    );
    expect(generatedUpdates).toHaveLength(1);
    expect(generatedUpdates[0].values.generationId).toBe("generation_1");
    expect(dbState.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({ status: "failed" }),
        }),
      ]),
    );
  });
});
