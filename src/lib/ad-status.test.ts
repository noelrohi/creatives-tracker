import { describe, expect, it } from "vitest";
import {
  canonicalizeImportedDeliveryStatus,
  normalizeImportedAdStatus,
  resolveMetaDeliveryStatus,
} from "./ad-status";
import { mapMetaInsightsToRows } from "./meta-api-mapper";

describe("ad status normalization", () => {
  it("normalizes paused-like imported statuses", () => {
    expect(normalizeImportedAdStatus("PAUSED")).toBe("paused");
    expect(normalizeImportedAdStatus("not delivering")).toBe("paused");
    expect(normalizeImportedAdStatus("CAMPAIGN_PAUSED")).toBe("paused");
  });

  it("normalizes archived-like imported statuses", () => {
    expect(normalizeImportedAdStatus("ARCHIVED")).toBe("archived");
    expect(normalizeImportedAdStatus("deleted")).toBe("archived");
  });

  it("canonicalizes Meta status values", () => {
    expect(canonicalizeImportedDeliveryStatus("NOT DELIVERING")).toBe("not_delivering");
    expect(resolveMetaDeliveryStatus({ effectiveStatus: "ADSET_PAUSED" })).toBe("adset_paused");
  });
});

describe("mapMetaInsightsToRows", () => {
  it("uses fetched ad delivery statuses instead of hard-coding active", () => {
    const [row] = mapMetaInsightsToRows(
      [{
        ad_id: "123",
        ad_name: "Visible Progress - 2 - Copy 3",
        spend: "161.87",
        date_start: "2026-04-07",
        date_stop: "2026-04-07",
      }],
      "ad",
      {
        deliveryByAdId: new Map([["123", "paused"]]),
      },
    );

    expect(row.delivery).toBe("paused");
  });
});
