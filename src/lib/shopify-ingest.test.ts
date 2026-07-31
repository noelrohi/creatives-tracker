import { describe, expect, it } from "vitest";
import type { ShopifyOrderNode, ShopifyRefund } from "@/lib/shopify-admin";
import { centsToAmount, toCents } from "@/lib/money";
import {
  cancellationGiveBackCents,
  cancellationRefundId,
  deriveDayInTimezone,
  groupBulkOrderLines,
  isTestOrder,
  mapOrderToRow,
  mapRefundRows,
  netSalesCents,
  refundAmountCents,
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

// §5.1: "sale = subtotalPriceSet.shopMoney booked on the order's day, minus
// currentTotalTaxSet-style adjustment only when taxesIncluded: true".
describe("netSalesCents", () => {
  it("books the order-day subtotal as-is when taxes are excluded", () => {
    expect(centsToAmount(netSalesCents(order()))).toBe("100.00");
  });

  it("removes included tax from the subtotal", () => {
    const value = netSalesCents(
      order({
        taxesIncluded: true,
        subtotalPriceSet: money("107.00"),
        totalTaxSet: money("7.00"),
      }),
    );
    expect(centsToAmount(value)).toBe("100.00");
  });

  it("ignores refunds — they book on their own day, never on the order day", () => {
    const value = netSalesCents(
      order({
        subtotalPriceSet: money("100.00"),
        currentSubtotalPriceSet: money("40.00"),
        refunds: [
          refund("gid://shopify/Refund/1", [{ subtotal: "30.00", tax: "2.10" }]),
          refund("gid://shopify/Refund/2", [{ subtotal: "30.00", tax: "2.10" }]),
        ],
      }),
    );
    expect(centsToAmount(value)).toBe("100.00");
  });

  it("does not let an order edit shrink the order day", () => {
    // Edited down from 100.00 to 80.00 with no refund recorded: the sale that
    // happened that day was still 100.00 — past days are immutable (§5.4).
    const value = netSalesCents(
      order({
        subtotalPriceSet: money("100.00"),
        currentSubtotalPriceSet: money("80.00"),
        currentTotalTaxSet: money("5.60"),
      }),
    );
    expect(centsToAmount(value)).toBe("100.00");
  });

  it("falls back to the current subtotal when the original is absent", () => {
    const value = netSalesCents(
      order({ subtotalPriceSet: null, currentSubtotalPriceSet: money("64.00") }),
    );
    expect(centsToAmount(value)).toBe("64.00");
  });
});

// §5.3: "cancelled = sale on order day + refund on cancel day".
describe("cancellationGiveBackCents", () => {
  it("is zero for an order that was never cancelled", () => {
    expect(cancellationGiveBackCents(order())).toBe(0);
  });

  it("gives back the whole sale when Shopify recorded no refund", () => {
    const value = cancellationGiveBackCents(
      order({ cancelledAt: "2026-07-02T02:00:00Z", refunds: [] }),
    );
    expect(centsToAmount(value)).toBe("100.00");
  });

  it("gives back only what the real refunds did not cover", () => {
    const value = cancellationGiveBackCents(
      order({
        cancelledAt: "2026-07-02T02:00:00Z",
        refunds: [
          refund("gid://shopify/Refund/1", [{ subtotal: "30.00", tax: "2.10" }]),
        ],
      }),
    );
    expect(centsToAmount(value)).toBe("70.00");
  });

  it("never goes negative when refunds already covered the sale", () => {
    const value = cancellationGiveBackCents(
      order({
        cancelledAt: "2026-07-02T02:00:00Z",
        refunds: [
          refund("gid://shopify/Refund/1", [{ subtotal: "100.00", tax: "7.00" }]),
        ],
      }),
    );
    expect(value).toBe(0);
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
    expect(row.orderName).toBe("#1001");
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

  it("carries the cancellation timestamp and reason through (§5.3)", () => {
    const row = mapOrderToRow(
      order({ cancelledAt: "2026-07-02T02:00:00Z", cancelReason: "CUSTOMER" }),
      CONTEXT,
    );
    expect(row.cancelledAt).toEqual(new Date("2026-07-02T02:00:00Z"));
    expect(row.cancelReason).toBe("CUSTOMER");
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

  it("books a cancelled order's give-back on the cancel day (§5.3)", () => {
    const rows = mapRefundRows(
      // Ordered Jul 2 Bangkok, cancelled Jul 20 Bangkok, no Shopify refund.
      order({ cancelledAt: "2026-07-19T18:00:00Z", refunds: [] }),
      CONTEXT,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("cancellation");
    expect(rows[0].shopifyRefundId).toBe(
      cancellationRefundId("gid://shopify/Order/1"),
    );
    expect(rows[0].refundDay).toBe("2026-07-20");
    expect(rows[0].amount).toBe("100.00");
  });

  it("adds only the uncovered remainder alongside a partial refund", () => {
    const rows = mapRefundRows(
      order({
        cancelledAt: "2026-07-19T18:00:00Z",
        refunds: [
          refund(
            "gid://shopify/Refund/7",
            [{ subtotal: "40.00", tax: "2.80" }],
            "2026-07-19T18:00:00Z",
          ),
        ],
      }),
      CONTEXT,
    );

    expect(rows.map((row) => [row.kind, row.amount])).toEqual([
      ["refund", "40.00"],
      ["cancellation", "60.00"],
    ]);
  });

  it("marks ordinary refunds as refunds, not cancellations", () => {
    const rows = mapRefundRows(
      order({
        refunds: [
          refund("gid://shopify/Refund/7", [{ subtotal: "40.00", tax: "2.80" }]),
        ],
      }),
      CONTEXT,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("refund");
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
