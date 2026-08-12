import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCaller } from "../test-helpers";

const mocks = vi.hoisted(() => ({
  selectRows: [] as Array<{ id: string }>,
  selectLimit: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(function (this: unknown) {
        return this;
      }),
      where: vi.fn(function (this: unknown) {
        return this;
      }),
      limit: mocks.selectLimit,
    })),
    update: vi.fn(() => ({ set: mocks.updateSet })),
  },
}));

const adminCaller = createMockCaller({ role: "admin" });
const memberCaller = createMockCaller({ role: "member" });

describe("landingPage.confirmStage (§5.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [{ id: "lp-1" }];
    mocks.selectLimit.mockImplementation(() =>
      Promise.resolve(mocks.selectRows),
    );
    mocks.updateWhere.mockImplementation(() => Promise.resolve(undefined));
    mocks.updateSet.mockImplementation(() => ({ where: mocks.updateWhere }));
  });

  it("requires org write access", async () => {
    await expect(
      memberCaller.landingPage.confirmStage({
        landingPageId: "lp-1",
        funnelStage: "mof",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  // The drawer's "No — it's colder" answer sends the corrected stage; either
  // answer makes the page human-owned so the AI stops re-suggesting it.
  it("writes the corrected stage and marks the page human-confirmed", async () => {
    const result = await adminCaller.landingPage.confirmStage({
      landingPageId: "lp-1",
      funnelStage: "tof",
    });

    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(mocks.updateSet.mock.calls[0][0]).toMatchObject({
      funnelStage: "tof",
      classificationStatus: "confirmed",
      classificationSource: "human",
    });
    expect(result.landingPageId).toBe("lp-1");
    expect(result.funnelStage).toBe("tof");
    expect(result.confirmedAt).toBeInstanceOf(Date);
  });

  it("rejects a page belonging to another organization", async () => {
    mocks.selectRows = [];

    await expect(
      adminCaller.landingPage.confirmStage({
        landingPageId: "lp-other",
        funnelStage: "bof",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("only accepts the funnel-stage vocabulary", async () => {
    await expect(
      adminCaller.landingPage.confirmStage({
        landingPageId: "lp-1",
        // @ts-expect-error — outside the enum on purpose.
        funnelStage: "middle",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
