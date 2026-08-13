import { describe, expect, it } from "vitest";
import {
  accountDay,
  addDays,
  buildCampaignFactsQuery,
  buildCustomerQuery,
  normalizeCampaignFactRow,
} from "@/lib/google-ads/facts";

describe("day helpers", () => {
  it("formats a date in the account timezone", () => {
    // 2026-08-13T02:00Z is still 2026-08-12 in Los Angeles.
    const instant = new Date("2026-08-13T02:00:00Z");
    expect(accountDay(instant, "America/Los_Angeles")).toBe("2026-08-12");
    expect(accountDay(instant, "UTC")).toBe("2026-08-13");
  });

  it("adds days across month boundaries", () => {
    expect(addDays("2026-08-30", 3)).toBe("2026-09-02");
    expect(addDays("2026-08-13", -90)).toBe("2026-05-15");
  });
});

describe("buildCampaignFactsQuery", () => {
  it("builds an inclusive BETWEEN query", () => {
    const query = buildCampaignFactsQuery("2026-08-01", "2026-08-14");
    expect(query).toContain("FROM campaign");
    expect(query).toContain("segments.date BETWEEN '2026-08-01' AND '2026-08-14'");
  });

  it("rejects malformed day strings", () => {
    expect(() => buildCampaignFactsQuery("2026-8-1", "2026-08-14")).toThrow(/day/);
    expect(() => buildCampaignFactsQuery("2026-08-01'; DROP", "2026-08-14")).toThrow(/day/);
  });
});

describe("buildCustomerQuery", () => {
  it("selects the discovery fields", () => {
    const query = buildCustomerQuery();
    for (const field of [
      "customer.id",
      "customer.descriptive_name",
      "customer.currency_code",
      "customer.time_zone",
      "customer.manager",
    ]) {
      expect(query).toContain(field);
    }
  });
});

describe("normalizeCampaignFactRow", () => {
  const ROW = {
    campaign: {
      id: "222",
      name: "Brand Search",
      status: "ENABLED",
      advertisingChannelType: "SEARCH",
    },
    segments: { date: "2026-08-01" },
    metrics: {
      costMicros: "1234500",
      impressions: "100",
      clicks: "7",
      conversions: 1.5,
      conversionsValue: 210.75,
    },
  };

  it("normalizes REST Int64 strings and doubles", () => {
    const fact = normalizeCampaignFactRow(ROW);
    expect(fact).toEqual({
      campaignId: "222",
      campaignName: "Brand Search",
      campaignStatus: "ENABLED",
      channelType: "SEARCH",
      factDate: "2026-08-01",
      costMicros: 1234500,
      impressions: 100,
      clicks: 7,
      conversions: "1.5",
      conversionsValue: "210.75",
    });
  });

  it("defaults absent metrics to zero", () => {
    const fact = normalizeCampaignFactRow({
      campaign: { id: "1", name: "X" },
      segments: { date: "2026-08-01" },
      metrics: {},
    });
    expect(fact?.costMicros).toBe(0);
    expect(fact?.conversions).toBe("0");
  });

  it("returns null for a row without campaign id or date", () => {
    expect(
      normalizeCampaignFactRow({ segments: { date: "2026-08-01" }, metrics: {} }),
    ).toBeNull();
    expect(
      normalizeCampaignFactRow({ campaign: { id: "1", name: "X" }, metrics: {} }),
    ).toBeNull();
  });

  it("rejects negative or non-finite metric values", () => {
    expect(
      normalizeCampaignFactRow({
        ...ROW,
        metrics: { ...ROW.metrics, costMicros: "-5" },
      }),
    ).toBeNull();
  });
});
