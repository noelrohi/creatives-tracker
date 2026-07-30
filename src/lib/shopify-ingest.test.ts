import { describe, expect, it } from "vitest";
import type { ShopifyOrderNode, ShopifyRefund } from "@/lib/shopify-admin";
import {
  centsToAmount,
  deriveDayInTimezone,
  groupBulkOrderLines,
  isTestOrder,
  mapOrderToRow,
  mapRefundRows,
  netSalesCents,
  refundAmountCents,
  toCents,
} from "@/lib/shopify-ingest";

const CONTEXT = {
  organizationId: "org_1",
  storeId: "store_1",
  storeTimezone: "Asia/Bangkok",
};

function money(amount: string) {
  return { shopMoney: { amount } };
}

function refund(
  id: string,
  lineItems: Array<{ subtotal: string; tax: string }>,
  createdAt = "2026-07-05T04:00:00Z",
): ShopifyRefund {
  return {
    id,
    createdAt,
    refundLineItems: {
      nodes: lineItems.map((lineItem) => ({
        subtotalSet: money(lineItem.subtotal),
        totalTaxSet: money(lineItem.tax),
      })),
    },
  };
}

function order(overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return {
    id: "gid://shopify/Order/1",
    name: "#1001",
    createdAt: "2026-07-01T23:30:00Z",
    updatedAt: "2026-07-02T01:00:00Z",
    cancelledAt: null,
    test: false,
    taxesIncluded: false,
    displayFinancialStatus: "PAID",
    sourceName: "web",
    subtotalPriceSet: money("100.00"),
    currentSubtotalPriceSet: money("100.00"),
    totalTaxSet: money("7.00"),
    currentTotalTaxSet: money("7.00"),
    refunds: [],
    customerJourneySummary: { ready: true, lastVisit: null },
    ...overrides,
  };
}

describe("deriveDayInTimezone", () => {
  it("rolls an instant forward across the Bangkok day boundary", () => {
    expect(deriveDayInTimezone("2026-07-01T23:30:00Z", "Asia/Bangkok")).toBe(
      "2026-07-02",
    );
  });

  it("keeps the same day for a mid-afternoon Bangkok instant", () => {
    expect(deriveDayInTimezone("2026-07-02T07:15:00Z", "Asia/Bangkok")).toBe(
      "2026-07-02",
    );
  });

  it("rolls an instant backward for a behind-UTC timezone", () => {
    expect(deriveDayInTimezone("2026-07-02T03:00:00Z", "America/New_York")).toBe(
      "2026-07-01",
    );
  });

  it("agrees with the ISO date for UTC (DST-free sanity case)", () => {
    expect(deriveDayInTimezone("2026-07-02T12:00:00Z", "UTC")).toBe("2026-07-02");
  });

  it("accepts a Date instance", () => {
    expect(
      deriveDayInTimezone(new Date("2026-07-01T23:30:00Z"), "Asia/Bangkok"),
    ).toBe("2026-07-02");
  });

  it("throws on an unparseable timestamp", () => {
    expect(() => deriveDayInTimezone("not-a-date", "UTC")).toThrow();
  });
});

describe("money parsing", () => {
  it("parses decimal strings into exact cents", () => {
    expect(toCents("100.00")).toBe(10000);
    expect(toCents("0.07")).toBe(7);
    expect(toCents("1234.56")).toBe(123456);
    expect(toCents("19.9")).toBe(1990);
    expect(toCents("-5.25")).toBe(-525);
    expect(toCents(null)).toBe(0);
    expect(toCents("")).toBe(0);
  });

  it("avoids float drift across a long sum", () => {
    let cents = 0;
    for (let index = 0; index < 10; index += 1) cents += toCents("0.10");
    expect(centsToAmount(cents)).toBe("1.00");
  });

  it("round-trips cents back to a numeric-safe string", () => {
    expect(centsToAmount(10000)).toBe("100.00");
    expect(centsToAmount(7)).toBe("0.07");
    expect(centsToAmount(-525)).toBe("-5.25");
    expect(centsToAmount(0)).toBe("0.00");
  });
});

describe("refundAmountCents", () => {
  it("sums refund line item subtotals when taxes are excluded", () => {
    const amount = refundAmountCents(
      refund("gid://shopify/Refund/1", [
        { subtotal: "30.00", tax: "2.10" },
        { subtotal: "20.00", tax: "1.40" },
      ]),
      false,
    );
    expect(centsToAmount(amount)).toBe("50.00");
  });

  it("strips tax out of the refund when taxes are included in prices", () => {
    const amount = refundAmountCents(
      refund("gid://shopify/Refund/1", [
        { subtotal: "30.00", tax: "2.10" },
        { subtotal: "20.00", tax: "1.40" },
      ]),
      true,
    );
    expect(centsToAmount(amount)).toBe("46.50");
  });

  it("treats a refund with no line items as zero", () => {
    expect(refundAmountCents({ id: "gid://shopify/Refund/9" }, true)).toBe(0);
  });
});

describe("netSalesCents", () => {
  it("uses the current subtotal as-is when taxes are excluded", () => {
    expect(centsToAmount(netSalesCents(order()))).toBe("100.00");
  });

  it("removes included tax from the current subtotal", () => {
    const value = netSalesCents(
      order({
        taxesIncluded: true,
        currentSubtotalPriceSet: money("107.00"),
        currentTotalTaxSet: money("7.00"),
      }),
    );
    expect(centsToAmount(value)).toBe("100.00");
  });

  it("adds every refund back so the order day keeps its original sale", () => {
    const value = netSalesCents(
      order({
        currentSubtotalPriceSet: money("40.00"),
        currentTotalTaxSet: money("2.80"),
        refunds: [
          refund("gid://shopify/Refund/1", [{ subtotal: "30.00", tax: "2.10" }]),
          refund("gid://shopify/Refund/2", [{ subtotal: "30.00", tax: "2.10" }]),
        ],
      }),
    );
    expect(centsToAmount(value)).toBe("100.00");
  });

  it("adds refunds back net of included tax", () => {
    const value = netSalesCents(
      order({
        taxesIncluded: true,
        currentSubtotalPriceSet: money("53.50"),
        currentTotalTaxSet: money("3.50"),
        refunds: [
          refund("gid://shopify/Refund/1", [{ subtotal: "53.50", tax: "3.50" }]),
        ],
      }),
    );
    expect(centsToAmount(value)).toBe("100.00");
  });

  it("restates an order edit on the order day (current + refunds back)", () => {
    // Order was edited down from 100.00 to 80.00 with no refund recorded.
    const value = netSalesCents(
      order({
        currentSubtotalPriceSet: money("80.00"),
        currentTotalTaxSet: money("5.60"),
      }),
    );
    expect(centsToAmount(value)).toBe("80.00");
  });

  it("nets a VOIDED never-paid cancellation to zero with no special case", () => {
    const value = netSalesCents(
      order({
        displayFinancialStatus: "VOIDED",
        cancelledAt: "2026-07-02T02:00:00Z",
        currentSubtotalPriceSet: money("0.00"),
        currentTotalTaxSet: money("0.00"),
        refunds: [],
      }),
    );
    expect(centsToAmount(value)).toBe("0.00");
  });
});

describe("mapOrderToRow", () => {
  it("maps a paid meta order onto the shopify_order shape", () => {
    const now = new Date("2026-07-02T02:00:00Z");
    const row = mapOrderToRow(
      order({
        customerJourneySummary: {
          ready: true,
          lastVisit: {
            source: "Facebook",
            sourceType: "ad",
            referrerUrl: "https://l.facebook.com/",
            landingPage: "https://shop.example/?utm_source=Facebook",
            utmParameters: {
              source: "FaceBook",
              medium: "PAID",
              campaign: "120210000000123",
              content: "ad-1",
              term: null,
            },
            occurredAt: "2026-07-01T22:00:00Z",
          },
        },
      }),
      { ...CONTEXT, now },
    );

    expect(row.orderDay).toBe("2026-07-02");
    expect(row.netSales).toBe("100.00");
    expect(row.journeyReady).toBe(true);
    expect(row.pendingSince).toBeNull();
    expect(row.lastClickUtmSource).toBe("facebook");
    expect(row.lastClickUtmMedium).toBe("paid");
    expect(row.lastClickUtmCampaign).toBe("120210000000123");
    expect(row.orderSourceName).toBe("web");
    expect(row.organizationId).toBe("org_1");
    expect(row.storeId).toBe("store_1");
    expect(row.customerJourney).not.toBeNull();
  });

  it("stamps pendingSince when the journey is not ready", () => {
    const now = new Date("2026-07-02T02:00:00Z");
    const row = mapOrderToRow(
      order({ customerJourneySummary: { ready: false, lastVisit: null } }),
      { ...CONTEXT, now },
    );

    expect(row.journeyReady).toBe(false);
    expect(row.pendingSince).toEqual(now);
  });

  it("treats a missing journey summary as not ready", () => {
    const row = mapOrderToRow(order({ customerJourneySummary: null }), CONTEXT);
    expect(row.journeyReady).toBe(false);
    expect(row.customerJourney).toBeNull();
    expect(row.lastClickUtmSource).toBeNull();
  });

  it("carries the cancellation timestamp through", () => {
    const row = mapOrderToRow(
      order({ cancelledAt: "2026-07-02T02:00:00Z" }),
      CONTEXT,
    );
    expect(row.cancelledAt).toEqual(new Date("2026-07-02T02:00:00Z"));
  });

  it("flags test orders so ingest can drop them", () => {
    expect(isTestOrder(order({ test: true }))).toBe(true);
    expect(isTestOrder(order())).toBe(false);
  });
});

describe("mapRefundRows", () => {
  it("derives refund_day in the store timezone and tax-adjusts the amount", () => {
    const rows = mapRefundRows(
      order({
        taxesIncluded: true,
        refunds: [
          refund(
            "gid://shopify/Refund/7",
            [{ subtotal: "53.50", tax: "3.50" }],
            "2026-07-05T18:00:00Z",
          ),
        ],
      }),
      CONTEXT,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].shopifyRefundId).toBe("gid://shopify/Refund/7");
    // 18:00Z is 01:00 the next day in Bangkok.
    expect(rows[0].refundDay).toBe("2026-07-06");
    expect(rows[0].amount).toBe("50.00");
    expect(rows[0].shopifyOrderId).toBe("gid://shopify/Order/1");
  });

  it("falls back to the order day when a refund has no timestamp", () => {
    const rows = mapRefundRows(
      order({ refunds: [{ id: "gid://shopify/Refund/8" }] }),
      CONTEXT,
    );
    expect(rows[0].refundDay).toBe("2026-07-02");
    expect(rows[0].amount).toBe("0.00");
  });
});

describe("groupBulkOrderLines", () => {
  it("keeps inline refunds and attaches refund line items by __parentId", () => {
    const orders = groupBulkOrderLines([
      {
        id: "gid://shopify/Order/1",
        createdAt: "2026-07-01T23:30:00Z",
        taxesIncluded: false,
        refunds: [{ id: "gid://shopify/Refund/1" }],
      },
      {
        id: "gid://shopify/RefundLineItem/1",
        __parentId: "gid://shopify/Refund/1",
        subtotalSet: money("30.00"),
        totalTaxSet: money("2.10"),
      },
    ]);

    expect(orders).toHaveLength(1);
    expect(orders[0].refunds?.[0].refundLineItems?.nodes).toHaveLength(1);
    expect(centsToAmount(refundAmountCents(orders[0].refunds![0], false))).toBe(
      "30.00",
    );
  });

  it("picks up refunds emitted as their own JSONL lines", () => {
    const orders = groupBulkOrderLines([
      { id: "gid://shopify/Order/2", createdAt: "2026-07-01T23:30:00Z" },
      {
        id: "gid://shopify/Refund/2",
        __parentId: "gid://shopify/Order/2",
        createdAt: "2026-07-05T04:00:00Z",
      },
      {
        id: "gid://shopify/RefundLineItem/2",
        __parentId: "gid://shopify/Refund/2",
        subtotalSet: money("10.00"),
        totalTaxSet: money("0.70"),
      },
    ]);

    expect(orders[0].refunds).toHaveLength(1);
    expect(centsToAmount(refundAmountCents(orders[0].refunds![0], true))).toBe(
      "9.30",
    );
  });

  it("ignores child lines with no matching order", () => {
    const orders = groupBulkOrderLines([
      {
        id: "gid://shopify/RefundLineItem/99",
        __parentId: "gid://shopify/Refund/99",
      },
    ]);
    expect(orders).toEqual([]);
  });
});
