/**
 * The §6.1 hard gate on the human write path: a creative cannot be created
 * untagged, an existing tag cannot be cleared, and whatever a person writes is
 * stamped `human` so AI re-enrichment leaves it alone (§6.2).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A complete row, so the procedures' output schemas have something to accept. */
const ROW = vi.hoisted(() => ({
  id: "creative-1",
  name: "Manual creative",
  assetUrl: null,
  videoUrl: null,
  format: null,
  angle: "problem_solution",
  persona: "busy parents",
  awarenessLevel: "problem_aware",
  attributes: {},
  attributesMeta: {},
  tone: null,
  ownership: null,
  teamId: null,
  notes: null,
  organizationId: "test-org-id",
  enrichmentAttemptedAt: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
}));

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  updateSet: vi.fn(),
  selectRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        mocks.insertValues(values);
        return { returning: vi.fn(async () => [ROW]) };
      }),
    })),
    select: vi.fn(() => {
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(async () => mocks.selectRows),
      };
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        mocks.updateSet(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => [ROW]),
          })),
        };
      }),
    })),
  },
}));
vi.mock("server-only", () => ({}));

const { createMockCaller } = await import("../test-helpers");
const caller = createMockCaller({ role: "admin" });

const TAGGED = {
  persona: "busy parents",
  angle: "problem_solution",
  awarenessLevel: "problem_aware",
} as const;

describe("adCreative.create (§6.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses a creative with no angle", async () => {
    await expect(
      // @ts-expect-error — the missing angle is the point of the test.
      caller.adCreative.create({ persona: TAGGED.persona, awarenessLevel: TAGGED.awarenessLevel }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("refuses an angle outside the taxonomy", async () => {
    await expect(
      // @ts-expect-error — "vibes" is not one of the seven angles.
      caller.adCreative.create({ ...TAGGED, angle: "vibes" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("refuses a blank persona", async () => {
    await expect(
      caller.adCreative.create({ ...TAGGED, persona: "   " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("stores the trio and stamps it human", async () => {
    await caller.adCreative.create({ name: "Manual creative", ...TAGGED });

    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues.mock.calls[0][0]).toMatchObject({
      name: "Manual creative",
      persona: "busy parents",
      angle: "problem_solution",
      awarenessLevel: "problem_aware",
      attributesMeta: {
        persona: { source: "human" },
        angle: { source: "human" },
        awarenessLevel: { source: "human" },
      },
    });
  });
});

describe("adCreative.update (§6.1, §3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [{ attributes: { hook: "old hook" }, attributesMeta: {} }];
  });

  it("cannot clear a tagged persona", async () => {
    await expect(
      // @ts-expect-error — null is exactly what the gate rejects.
      caller.adCreative.update({ id: "creative-1", persona: null }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("cannot clear a tagged angle or awareness level either", async () => {
    for (const patch of [{ angle: null }, { awarenessLevel: null }]) {
      await expect(
        // @ts-expect-error — same gate, other two tags.
        caller.adCreative.update({ id: "creative-1", ...patch }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  // A legacy row may still be edited without being retagged in the same breath.
  it("leaves an untouched tag alone", async () => {
    await caller.adCreative.update({ id: "creative-1", notes: "just a note" });

    expect(mocks.updateSet.mock.calls[0][0]).toMatchObject({ notes: "just a note" });
    expect(mocks.updateSet.mock.calls[0][0]).not.toHaveProperty("persona");
  });

  it("stamps every supplied field human", async () => {
    await caller.adCreative.update({
      id: "creative-1",
      angle: "social_proof",
      attributes: { hook: "new hook", visualStyle: "ugc_photo" },
    });

    const written = mocks.updateSet.mock.calls[0][0] as {
      attributes: Record<string, unknown>;
      attributesMeta: Record<string, unknown>;
    };
    expect(written.attributes).toEqual({
      hook: "new hook",
      visualStyle: "ugc_photo",
    });
    expect(written.attributesMeta).toEqual({
      angle: { source: "human" },
      hook: { source: "human" },
      visualStyle: { source: "human" },
    });
  });

  it("validates the closed attribute vocabularies on write", async () => {
    await expect(
      caller.adCreative.update({
        id: "creative-1",
        // @ts-expect-error — "watercolour" is not a visual style.
        attributes: { visualStyle: "watercolour" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.adCreative.update({
        id: "creative-1",
        // @ts-expect-error — "sepia" is not a mode.
        attributes: { mode: "sepia" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("clears an attribute — and its provenance — on an explicit null", async () => {
    mocks.selectRows = [
      {
        attributes: { hook: "old hook" },
        attributesMeta: { hook: { source: "ai" } },
      },
    ];

    await caller.adCreative.update({
      id: "creative-1",
      attributes: { hook: null },
    });

    const written = mocks.updateSet.mock.calls[0][0] as {
      attributes: Record<string, unknown>;
      attributesMeta: Record<string, unknown>;
    };
    expect(written.attributes).toEqual({});
    expect(written.attributesMeta).toEqual({});
  });
});
