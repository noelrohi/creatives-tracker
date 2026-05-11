import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCaller } from "../test-helpers";

const mocks = vi.hoisted(() => ({
  selectRows: [] as Array<{
    id: string;
    name: string;
    metaId: string | null;
    metaAccessToken: string | null;
  }>,
  updatedRows: [] as Array<{ id: string }>,
  selectWhere: vi.fn(),
  updateReturning: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(function (this: unknown) { return this; }),
      leftJoin: vi.fn(function (this: unknown) { return this; }),
      where: mocks.selectWhere,
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mocks.updateReturning,
        })),
      })),
    })),
  },
}));

const adminCaller = createMockCaller({ role: "admin" });
const memberCaller = createMockCaller({ role: "member" });

describe("ad.pauseMetaAds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.updatedRows = [];
    mocks.selectWhere.mockImplementation(() => Promise.resolve(mocks.selectRows));
    mocks.updateReturning.mockImplementation(() => Promise.resolve(mocks.updatedRows));
    vi.stubGlobal("fetch", vi.fn());
  });

  it("requires org write access", async () => {
    await expect(memberCaller.ad.pauseMetaAds({ adIds: ["ad-1"] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("pauses valid Meta ads, bulk-updates only Meta successes, and reports per-ad failures", async () => {
    mocks.selectRows = [
      { id: "ad-ok", name: "Winner turned bleeder", metaId: "meta-ok", metaAccessToken: "token" },
      { id: "ad-meta-fail", name: "Meta failure", metaId: "meta-fail", metaAccessToken: "token" },
      { id: "ad-no-meta", name: "No Meta ID", metaId: null, metaAccessToken: "token" },
      { id: "ad-no-token", name: "No token", metaId: "meta-no-token", metaAccessToken: null },
    ];
    mocks.updatedRows = [{ id: "ad-ok" }];

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Bad Request",
        json: () => Promise.resolve({ error: { message: "Cannot pause this ad" } }),
      } as Response);

    const result = await adminCaller.ad.pauseMetaAds({
      adIds: ["ad-ok", "ad-meta-fail", "ad-no-meta", "ad-no-token", "missing-ad"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/meta-ok"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/meta-fail"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.updateReturning).toHaveBeenCalledTimes(1);

    expect(result.paused).toEqual([
      { id: "ad-ok", metaId: "meta-ok", name: "Winner turned bleeder" },
    ]);
    expect(result.failed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "missing-ad", error: "Ad not found" }),
      expect.objectContaining({ id: "ad-no-meta", error: "This ad has no Meta ID" }),
      expect.objectContaining({ id: "ad-no-token", error: "This ad's account has no Meta access token" }),
      expect.objectContaining({ id: "ad-meta-fail", error: "Meta API error: Cannot pause this ad" }),
    ]));
  });

  it("does not claim success when Meta pauses but the bulk local DB update fails", async () => {
    mocks.selectRows = [
      { id: "ad-1", name: "Bleeder 1", metaId: "meta-1", metaAccessToken: "token" },
      { id: "ad-2", name: "Bleeder 2", metaId: "meta-2", metaAccessToken: "token" },
    ];
    mocks.updateReturning.mockRejectedValue(new Error("database unavailable"));

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await adminCaller.ad.pauseMetaAds({ adIds: ["ad-1", "ad-2"] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.updateReturning).toHaveBeenCalledTimes(3);
    expect(result.paused).toEqual([]);
    expect(result.failed).toEqual([
      expect.objectContaining({ id: "ad-1", metaPaused: true, error: "database unavailable" }),
      expect.objectContaining({ id: "ad-2", metaPaused: true, error: "database unavailable" }),
    ]);
  });
});
