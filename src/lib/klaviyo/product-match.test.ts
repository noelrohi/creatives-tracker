import { describe, expect, it } from "vitest";
import { compareProducts } from "@/lib/klaviyo/product-match";

const variant = (id: string, quantity: number) => ({
  productId: null,
  variantId: `gid://shopify/ProductVariant/${id}`,
  sku: null,
  quantity,
});
const line = (variantId: string, quantity: number) => ({
  shopifyProductId: null,
  shopifyVariantId: variantId,
  sku: null,
  quantity,
});

describe("compareProducts", () => {
  it("treats duplicate variants as multisets with exact agreement", () => {
    const result = compareProducts({
      source: "placed_order_items",
      klaviyoProducts: [variant("1", 1), variant("1", 1), variant("2", 3)],
      shopifyLines: [line("1", 2), line("2", 3)],
    });
    expect(result.status).toBe("exact");
    expect(result.source).toBe("placed_order_items");
  });

  it("flags quantity contradiction", () => {
    const result = compareProducts({
      source: "placed_order_items",
      klaviyoProducts: [variant("1", 2)],
      shopifyLines: [line("1", 5)],
    });
    expect(result.status).toBe("contradictory");
    expect(result.reasonCodes).toContain("variant_quantity_conflict");
  });

  it("flags identifier contradiction when variant sets disagree entirely", () => {
    const result = compareProducts({
      source: "placed_order_items",
      klaviyoProducts: [
        { productId: "7", variantId: null, sku: null, quantity: 1 },
      ],
      shopifyLines: [
        { shopifyProductId: "8", shopifyVariantId: null, sku: null, quantity: 1 },
      ],
    });
    expect(result.status).toBe("contradictory");
    expect(result.reasonCodes).toContain("product_identifier_conflict");
  });

  it("returns product-family-only partial evidence", () => {
    const result = compareProducts({
      source: "placed_order_items",
      klaviyoProducts: [
        { productId: "7", variantId: null, sku: null, quantity: 1 },
        { productId: "9", variantId: null, sku: null, quantity: 1 },
      ],
      shopifyLines: [
        { shopifyProductId: "7", shopifyVariantId: null, sku: null, quantity: 1 },
      ],
    });
    expect(result.status).toBe("partial");
    expect(result.reasonCodes).toContain("product_family_partial");
  });

  it("returns partial when one side lacks canonical identifiers", () => {
    const result = compareProducts({
      source: "placed_order_items",
      klaviyoProducts: [
        { productId: null, variantId: null, sku: null, quantity: 1 },
      ],
      shopifyLines: [line("1", 1)],
    });
    expect(result.status).toBe("partial");
    expect(result.reasonCodes).toContain("identifier_coverage_missing");
  });

  it("compares SKUs only when unambiguous on both sides", () => {
    const exact = compareProducts({
      source: "placed_order_items",
      klaviyoProducts: [
        { productId: null, variantId: null, sku: "SKU-1", quantity: 2 },
      ],
      shopifyLines: [
        {
          shopifyProductId: null,
          shopifyVariantId: null,
          sku: "SKU-1",
          quantity: 2,
        },
      ],
    });
    expect(exact.status).toBe("exact");
    expect(exact.reasonCodes).toContain("sku_multiset_exact");

    const ambiguous = compareProducts({
      source: "placed_order_items",
      klaviyoProducts: [
        { productId: null, variantId: null, sku: "SKU-1", quantity: 1 },
        { productId: null, variantId: null, sku: "SKU-1", quantity: 1 },
      ],
      shopifyLines: [
        {
          shopifyProductId: null,
          shopifyVariantId: null,
          sku: "SKU-1",
          quantity: 2,
        },
      ],
    });
    // Duplicate Klaviyo SKUs are not unambiguous line-level evidence.
    expect(ambiguous.reasonCodes).not.toContain("sku_multiset_exact");
  });

  it("reports unavailable evidence and never sums both sources", () => {
    expect(
      compareProducts({
        source: "none",
        klaviyoProducts: [],
        shopifyLines: [line("1", 1)],
      }).status,
    ).toBe("unavailable");
    const orderedProducts = compareProducts({
      source: "ordered_product_events",
      klaviyoProducts: [variant("1", 1)],
      shopifyLines: [line("1", 1)],
    });
    expect(orderedProducts.source).toBe("ordered_product_events");
    expect(orderedProducts.status).toBe("exact");
  });
});
