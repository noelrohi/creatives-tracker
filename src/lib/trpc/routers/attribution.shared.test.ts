import { describe, expect, it } from "vitest";
import { shopifyNetSalesDefinition, shopifyNetSalesDefinitionSchema } from "./attribution.shared";

describe("Shopify net-sales definition", () => {
  it("describes local order/refund arithmetic without claiming official reconciliation", () => {
    const definition = shopifyNetSalesDefinitionSchema.parse(shopifyNetSalesDefinition({ ianaTimezone: "Asia/Kolkata", currency: "INR" }));
    expect(definition).toMatchObject({
      source: "locally_ingested_shopify_orders_and_refunds",
      population: "non_test_orders_all_financial_statuses_including_cancellations",
      arithmetic: "order_amounts_minus_refund_amounts",
      orderAmount: "subtotal_after_discounts_excluding_shipping_minus_tax_if_tax_inclusive",
      refundAmount: "refund_line_item_subtotals_minus_tax_if_tax_inclusive_plus_cancellation_remainder",
      orderDateBasis: "order_creation_day_in_store_timezone",
      refundDateBasis: "refund_or_cancellation_day_in_store_timezone",
      timezone: "Asia/Kolkata", currency: "INR", officialReportReconciled: false,
    });
  });
  it.each(["refund_amounts_only", "order_amounts_only"] as const)("distinguishes %s and preserves unknown currency", (arithmetic) => {
    expect(shopifyNetSalesDefinition({ ianaTimezone: "UTC", currency: null }, arithmetic)).toMatchObject({ arithmetic, currency: null });
  });
});
