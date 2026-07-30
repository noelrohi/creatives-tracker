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
  selectLimit: vi.fn(),
  updateSet: vi.fn(),
  updateReturning: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(function (this: unknown) { return this; }),
      leftJoin: vi.fn(function (this: unknown) { return this; }),
      where: vi.fn(function (this: unknown) { return this; }),
      limit: mocks.selectLimit,
    })),
    update: vi.fn(() => ({
      set: mocks.updateSet,
    })),
  },
}));

const adminCaller = createMockCaller({ role: "admin" });
const memberCaller = createMockCaller({ role: "member" });

describe("ad.renameMetaAd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.updatedRows = [{ id: "ad-1" }];
    mocks.selectLimit.mockImplementation(() => Promise.resolve(mocks.selectRows));
    mocks.updateSet.mockImplementation(() => ({
      where: vi.fn(() => ({ returning: mocks.updateReturning })),
    }));
    mocks.updateReturning.mockImplementation(() => Promise.resolve(mocks.updatedRows));
    vi.stubGlobal("fetch", vi.fn());
  });

  it("requires org write access", async () => {
    await expect(
      memberCaller.ad.renameMetaAd({ adId: "ad-1", name: "New name" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("renames the ad in Meta first, then mirrors the name locally", async () => {
    mocks.selectRows = [
      { id: "ad-1", name: "Old name", metaId: "meta-1", metaAccessToken: "token" },
    ];

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const result = await adminCaller.ad.renameMetaAd({ adId: "ad-1", name: "New name" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v25.0/meta-1");
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(body.get("access_token")).toBe("token");
    expect(body.get("name")).toBe("New name");

    expect(mocks.updateSet).toHaveBeenCalledWith({ name: "New name" });
    expect(result).toEqual({ id: "ad-1", name: "New name" });
  });

  it("fails without calling Meta when the ad has no Meta ID", async () => {
    mocks.selectRows = [
      { id: "ad-1", name: "Old name", metaId: null, metaAccessToken: "token" },
    ];

    await expect(
      adminCaller.ad.renameMetaAd({ adId: "ad-1", name: "New name" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("fails without calling Meta when the account has no access token", async () => {
    mocks.selectRows = [
      { id: "ad-1", name: "Old name", metaId: "meta-1", metaAccessToken: null },
    ];

    await expect(
      adminCaller.ad.renameMetaAd({ adId: "ad-1", name: "New name" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("does not update locally when Meta rejects the rename", async () => {
    mocks.selectRows = [
      { id: "ad-1", name: "Old name", metaId: "meta-1", metaAccessToken: "token" },
    ];

    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: () => Promise.resolve({
        error: { type: "OAuthException", message: "Invalid OAuth access token" },
      }),
    } as Response);

    await expect(
      adminCaller.ad.renameMetaAd({ adId: "ad-1", name: "New name" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("reports a reconcilable error when Meta succeeds but the local update matches no row", async () => {
    mocks.selectRows = [
      { id: "ad-1", name: "Old name", metaId: "meta-1", metaAccessToken: "token" },
    ];
    mocks.updatedRows = [];
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await expect(
      adminCaller.ad.renameMetaAd({ adId: "ad-1", name: "New name" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("rejects an empty name before touching Meta", async () => {
    await expect(
      adminCaller.ad.renameMetaAd({ adId: "ad-1", name: "   " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
