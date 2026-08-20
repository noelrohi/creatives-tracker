import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updates: [] as unknown[],
  adRows: [] as unknown[],
  mirror: vi.fn(),
  previewBatch: vi.fn(),
  account: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(() => {
          mocks.updates.push(values);
          return Promise.resolve();
        }),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(function (this: unknown) {
        return this;
      }),
      where: vi.fn(function (this: unknown) {
        return this;
      }),
      limit: vi.fn(() => Promise.resolve(mocks.adRows)),
    })),
  },
}));

vi.mock("@/lib/meta-creative-assets", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/meta-creative-assets")
  >("@/lib/meta-creative-assets");
  return {
    isDurableAssetUrl: actual.isDurableAssetUrl,
    mirrorMetaImageToBlob: mocks.mirror,
    fetchMetaCreativePreviewsBatch: mocks.previewBatch,
  };
});

vi.mock("@/lib/meta-insights-sync", () => ({
  getMetaAccountWithToken: mocks.account,
}));

const { resolveCreativeImageUrl } = await import("@/lib/creative-asset-repair");

const BLOB_URL = "https://abc123.public.blob.vercel-storage.com/prod/x.jpg";
const META_URL = "https://scontent-sin6-3.xx.fbcdn.net/v/t15.5256-10/x.jpg";

function respondWith(status: number) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  mocks.updates = [];
  mocks.adRows = [];
  mocks.mirror.mockReset();
  mocks.previewBatch.mockReset();
  mocks.account.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveCreativeImageUrl", () => {
  const base = { organizationId: "org_1", creativeId: "cr_1" };

  it("returns a blob URL without probing it", async () => {
    const fetchSpy = respondWith(500);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await resolveCreativeImageUrl({ ...base, assetUrl: BLOB_URL });

    expect(result).toEqual({ url: BLOB_URL, outcome: "durable", repaired: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
  });

  it("reports no image for a missing or video asset", async () => {
    await expect(
      resolveCreativeImageUrl({ ...base, assetUrl: null }),
    ).resolves.toMatchObject({ url: null, outcome: "no_image" });
    await expect(
      resolveCreativeImageUrl({ ...base, assetUrl: "https://cdn/x.mp4" }),
    ).resolves.toMatchObject({ url: null, outcome: "no_image" });
  });

  it("mirrors a still-live Meta URL and persists the durable one", async () => {
    vi.stubGlobal("fetch", respondWith(206));
    mocks.mirror.mockResolvedValue(BLOB_URL);

    const result = await resolveCreativeImageUrl({ ...base, assetUrl: META_URL });

    expect(result).toEqual({ url: BLOB_URL, outcome: "mirrored", repaired: true });
    expect(mocks.mirror).toHaveBeenCalledWith({
      key: "creative-cr_1",
      sourceUrl: META_URL,
    });
    expect(mocks.updates).toEqual([{ assetUrl: BLOB_URL }]);
  });

  it("keeps a live URL unwritten when mirroring is unavailable", async () => {
    vi.stubGlobal("fetch", respondWith(200));
    mocks.mirror.mockResolvedValue(null);

    const result = await resolveCreativeImageUrl({ ...base, assetUrl: META_URL });

    expect(result).toEqual({ url: META_URL, outcome: "unmirrored", repaired: false });
    expect(mocks.updates).toEqual([]);
  });

  it("re-resolves an expired URL from Meta and repairs the row", async () => {
    vi.stubGlobal("fetch", respondWith(403));
    mocks.adRows = [{ metaId: "123", accountId: "acc_1" }];
    mocks.account.mockResolvedValue({
      metaAccountId: "act_9",
      metaAccessToken: "tok",
    });
    mocks.previewBatch.mockResolvedValue({
      previews: new Map([["123", { assetUrl: BLOB_URL }]]),
    });

    const result = await resolveCreativeImageUrl({ ...base, assetUrl: META_URL });

    expect(result).toEqual({ url: BLOB_URL, outcome: "reresolved", repaired: true });
    expect(mocks.updates).toEqual([{ assetUrl: BLOB_URL }]);
  });

  it("reports unreachable rather than throwing when Meta cannot help", async () => {
    vi.stubGlobal("fetch", respondWith(403));
    mocks.adRows = [{ metaId: "123", accountId: "acc_1" }];
    mocks.account.mockRejectedValue(new Error("no access token"));

    const result = await resolveCreativeImageUrl({ ...base, assetUrl: META_URL });

    expect(result).toEqual({ url: null, outcome: "unreachable", repaired: false });
    expect(mocks.updates).toEqual([]);
  });

  it("reports unreachable when the creative has no synced Meta ad", async () => {
    vi.stubGlobal("fetch", respondWith(403));
    mocks.adRows = [];

    const result = await resolveCreativeImageUrl({ ...base, assetUrl: META_URL });

    expect(result).toMatchObject({ url: null, outcome: "unreachable" });
    expect(mocks.previewBatch).not.toHaveBeenCalled();
  });

  it("treats a network error on the probe as expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    mocks.adRows = [];

    await expect(
      resolveCreativeImageUrl({ ...base, assetUrl: META_URL }),
    ).resolves.toMatchObject({ url: null, outcome: "unreachable" });
  });
});
