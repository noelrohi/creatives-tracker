/**
 * Shared by the `attribution` and `findings` routers: the store lookup every
 * read is scoped through, and the day-range input shape.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { DAY_PATTERN } from "@/lib/day";
import { getStoreForOrg } from "@/lib/attribution-queries";

/** `organizationId` always comes from ctx, never from the client. */
export async function requireStore(organizationId: string) {
  const store = await getStoreForOrg(organizationId);
  if (!store) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No Shopify store is connected for this organization",
    });
  }
  return store;
}

// Describes the local ledger, not reconciliation with an official Shopify report.
export const shopifyNetSalesDefinitionSchema = z.object({
  version: z.literal("shopify_order_refund_ledger_v1"),
  source: z.literal("locally_ingested_shopify_orders_and_refunds"),
  population: z.literal("non_test_orders_all_financial_statuses_including_cancellations"),
  orderAmount: z.literal("subtotal_after_discounts_excluding_shipping_minus_tax_if_tax_inclusive"),
  orderAmountFallback: z.literal("current_subtotal_and_current_tax_when_original_fields_missing"),
  refundAmount: z.literal("refund_line_item_subtotals_minus_tax_if_tax_inclusive_plus_cancellation_remainder"),
  arithmetic: z.enum(["order_amounts_minus_refund_amounts", "refund_amounts_only", "order_amounts_only"]),
  orderDateBasis: z.literal("order_creation_day_in_store_timezone"),
  refundDateBasis: z.literal("refund_or_cancellation_day_in_store_timezone"),
  timezone: z.string(),
  currency: z.string().nullable(),
  currencyBasis: z.literal("shop_money_store_currency_no_conversion"),
  officialReportReconciled: z.literal(false),
}).describe("Shopify-derived local ledger definition, not an official Shopify report: discounted item subtotals excluding shipping and inclusive tax, less item refunds and cancellation remainders booked on their own store-calendar days. Attribution endpoints restrict this ledger by the displayed bucket/campaign; Meta claims are separate Meta-attributed purchase values, not this definition. Hourly/order views omit refund subtraction; refundsTotal reports refunds only. Currency is store shop money without conversion; null means unknown.");

export function shopifyNetSalesDefinition(
  store: { ianaTimezone: string; currency: string | null },
  arithmetic: z.infer<typeof shopifyNetSalesDefinitionSchema>["arithmetic"] = "order_amounts_minus_refund_amounts",
): z.infer<typeof shopifyNetSalesDefinitionSchema> {
  return {
    version: "shopify_order_refund_ledger_v1",
    source: "locally_ingested_shopify_orders_and_refunds",
    population: "non_test_orders_all_financial_statuses_including_cancellations",
    orderAmount: "subtotal_after_discounts_excluding_shipping_minus_tax_if_tax_inclusive",
    orderAmountFallback: "current_subtotal_and_current_tax_when_original_fields_missing",
    refundAmount: "refund_line_item_subtotals_minus_tax_if_tax_inclusive_plus_cancellation_remainder",
    arithmetic,
    orderDateBasis: "order_creation_day_in_store_timezone",
    refundDateBasis: "refund_or_cancellation_day_in_store_timezone",
    timezone: store.ianaTimezone,
    currency: store.currency,
    currencyBasis: "shop_money_store_currency_no_conversion",
    officialReportReconciled: false,
  };
}

export const dateRangeShape = {
  dateFrom: z.string().regex(DAY_PATTERN, "Expected YYYY-MM-DD"),
  dateTo: z.string().regex(DAY_PATTERN, "Expected YYYY-MM-DD"),
};

export const orderedRange = {
  check: (value: { dateFrom: string; dateTo: string }) =>
    value.dateFrom <= value.dateTo,
  message: {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  },
};

export const dateRangeSchema = z
  .object(dateRangeShape)
  .refine(orderedRange.check, orderedRange.message);
