import { describe, expect, it } from "vitest";
import { matchCampaignNames } from "@/lib/google-ads/revenue-panel";

describe("matchCampaignNames", () => {
  const PAID = [
    { utmCampaign: "brand_search", revenueCents: 1000, orders: 2 },
    { utmCampaign: "PMax-Main", revenueCents: 500, orders: 1 },
    { utmCampaign: null, revenueCents: 200, orders: 1 },
  ];

  it("matches case-insensitively after trimming", () => {
    expect(matchCampaignNames("  Brand_Search ", PAID)).toBe("brand_search");
    expect(matchCampaignNames("pmax-main", PAID)).toBe("PMax-Main");
  });

  it("returns null when nothing matches exactly", () => {
    expect(matchCampaignNames("brand search", PAID)).toBeNull();
    expect(matchCampaignNames("", PAID)).toBeNull();
  });

  it("never matches the null utm bucket", () => {
    expect(matchCampaignNames("null", PAID)).toBeNull();
  });
});
