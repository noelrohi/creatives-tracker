import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMetaCreativePreviewsBatch } from "./meta-creative-assets";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchMetaCreativePreviewsBatch", () => {
  it("requests and returns Meta creative URL tags", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("fields")).toContain("url_tags");

      return new Response(JSON.stringify({
        "ad-1": {
          creative: {
            link_url: "https://example.com/product",
            url_tags: "utm_source=meta&utm_campaign={{campaign.name}}",
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMetaCreativePreviewsBatch({
      adMetaIds: ["ad-1"],
      metaAccountId: "account-1",
      accessToken: "token",
      assetUrlMode: "direct",
      videoUrlMode: "none",
    });

    expect(result.successfulAdMetaIds.has("ad-1")).toBe(true);
    expect(result.previews.get("ad-1")).toMatchObject({
      destinationUrl: "https://example.com/product",
      urlTags: "utm_source=meta&utm_campaign={{campaign.name}}",
    });
  });
});
