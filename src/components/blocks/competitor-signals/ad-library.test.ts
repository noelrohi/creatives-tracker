import { describe, expect, it } from "vitest";
import {
  adLibrarySearchUrl,
  parseMetaAdLibraryPageUrl,
} from "./ad-library";

describe("adLibrarySearchUrl", () => {
  it("builds an all-country active-ad search for the competitor name", () => {
    const url = new URL(adLibrarySearchUrl("  Grüns  "));

    expect(url.origin + url.pathname).toBe(
      "https://www.facebook.com/ads/library/",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      active_status: "active",
      ad_type: "all",
      country: "ALL",
      is_targeted_country: "false",
      media_type: "all",
      q: "Grüns",
      search_type: "keyword_unordered",
      "sort_data[direction]": "desc",
      "sort_data[mode]": "total_impressions",
    });
  });

  it("does not set search parameters without a competitor name", () => {
    const url = new URL(adLibrarySearchUrl("  "));

    expect(url.searchParams.get("ad_type")).toBe("all");
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("search_type")).toBe(false);
  });
});

describe("parseMetaAdLibraryPageUrl", () => {
  it.each([
    [
      "https://www.facebook.com/ads/library/?view_all_page_id=109178280892310",
      "109178280892310",
    ],
    [
      "https://facebook.com/ads/library?active_status=active&view_all_page_id=92823337978&country=US",
      "92823337978",
    ],
    [
      "https://m.facebook.com/ads/library/?view_all_page_id=612479481940253",
      "612479481940253",
    ],
  ])("extracts the advertiser page ID from %s", (url, pageId) => {
    expect(parseMetaAdLibraryPageUrl(url)).toEqual({ pageId, error: null });
  });

  it.each([
    "not a url",
    "http://www.facebook.com/ads/library/?view_all_page_id=123",
    "https://example.com/ads/library/?view_all_page_id=123",
    "https://notfacebook.com/ads/library/?view_all_page_id=123",
    "https://www.facebook.com/somewhere/?view_all_page_id=123",
    "https://www.facebook.com/ads/library/?view_all_page_id=abc",
    "https://www.facebook.com/ads/library/",
  ])("rejects invalid advertiser page input: %s", (url) => {
    expect(parseMetaAdLibraryPageUrl(url)).toEqual({
      pageId: null,
      error: "invalid",
    });
  });

  it("distinguishes an individual ad URL from an advertiser page URL", () => {
    expect(
      parseMetaAdLibraryPageUrl(
        "https://www.facebook.com/ads/library/?id=1234567890123456",
      ),
    ).toEqual({ pageId: null, error: "individual_ad" });
  });

  it("treats an invalid advertiser page ID as invalid when an ad ID is also present", () => {
    expect(
      parseMetaAdLibraryPageUrl(
        "https://www.facebook.com/ads/library/?view_all_page_id=abc&id=1234567890123456",
      ),
    ).toEqual({ pageId: null, error: "invalid" });
  });
});
