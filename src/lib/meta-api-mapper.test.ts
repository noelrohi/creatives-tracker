import { describe, expect, it } from "vitest";
import { mapMetaInsightsToRows } from "./meta-api-mapper";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    ad_name: "Ad 1",
    ad_id: "123",
    spend: "100",
    date_start: "2026-08-01",
    date_stop: "2026-08-01",
    ...overrides,
  };
}

describe("mapMetaInsightsToRows numeric passthrough fields", () => {
  it("maps clicks to clicksAll and leaves it undefined when absent", () => {
    const [withClicks] = mapMetaInsightsToRows(
      [baseRow({ clicks: "42" })],
      "ad",
    );
    const [withoutClicks] = mapMetaInsightsToRows([baseRow()], "ad");

    expect(withClicks.clicksAll).toBe(42);
    expect(withoutClicks.clicksAll).toBeUndefined();
  });
});

describe("mapMetaInsightsToRows cost_per_* extraction", () => {
  it("reads reported cost_per_action_type entries for LPV and add-to-cart", () => {
    const [row] = mapMetaInsightsToRows(
      [
        baseRow({
          actions: [
            { action_type: "landing_page_view", value: "50" },
            { action_type: "add_to_cart", value: "20" },
          ],
          cost_per_action_type: [
            { action_type: "landing_page_view", value: "1.23" },
            { action_type: "add_to_cart", value: "4.56" },
          ],
        }),
      ],
      "ad",
    );

    expect(row.costPerLpv).toBe("1.23");
    expect(row.costPerAddToCart).toBe("4.56");
  });

  it("prefers the omni add-to-cart cost, matching the purchase CPA convention", () => {
    const [row] = mapMetaInsightsToRows(
      [
        baseRow({
          actions: [{ action_type: "omni_add_to_cart", value: "10" }],
          cost_per_action_type: [
            { action_type: "add_to_cart", value: "9.99" },
            { action_type: "omni_add_to_cart", value: "2.50" },
          ],
        }),
      ],
      "ad",
    );

    expect(row.costPerAddToCart).toBe("2.50");
  });

  it("computes spend / count when the cost entry is missing", () => {
    const [row] = mapMetaInsightsToRows(
      [
        baseRow({
          spend: "100",
          actions: [
            { action_type: "landing_page_view", value: "40" },
            { action_type: "omni_add_to_cart", value: "8" },
          ],
        }),
      ],
      "ad",
    );

    expect(row.costPerLpv).toBe("2.50");
    expect(row.costPerAddToCart).toBe("12.50");
  });

  it("leaves both undefined when there is no count, no cost entry, or no spend", () => {
    const [noCounts] = mapMetaInsightsToRows([baseRow({ actions: [] })], "ad");
    expect(noCounts.costPerLpv).toBeUndefined();
    expect(noCounts.costPerAddToCart).toBeUndefined();

    const [zeroCount] = mapMetaInsightsToRows(
      [
        baseRow({
          actions: [
            { action_type: "landing_page_view", value: "0" },
            { action_type: "add_to_cart", value: "0" },
          ],
        }),
      ],
      "ad",
    );
    expect(zeroCount.costPerLpv).toBeUndefined();
    expect(zeroCount.costPerAddToCart).toBeUndefined();

    const [noSpend] = mapMetaInsightsToRows(
      [
        baseRow({
          spend: undefined,
          actions: [{ action_type: "landing_page_view", value: "10" }],
        }),
      ],
      "ad",
    );
    expect(noSpend.costPerLpv).toBeUndefined();
  });

  it("keeps the existing purchase CPA and count extractions intact", () => {
    const [row] = mapMetaInsightsToRows(
      [
        baseRow({
          actions: [
            { action_type: "omni_purchase", value: "5" },
            { action_type: "landing_page_view", value: "50" },
            { action_type: "initiate_checkout", value: "12" },
          ],
          cost_per_action_type: [{ action_type: "omni_purchase", value: "20" }],
        }),
      ],
      "ad",
    );

    expect(row.cpa).toBe("20");
    expect(row.landingPageViews).toBe(50);
    expect(row.initiateCheckout).toBe(12);
    expect(row.attributionWindows).toBe("7d_click,1d_view");
  });
});
