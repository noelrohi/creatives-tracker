import type { ProductMatchStatus } from "@/lib/klaviyo/match-types";
import {
  canonicalizeProductIdCandidate,
  canonicalizeSku,
  canonicalizeVariantIdCandidate,
} from "@/lib/klaviyo/match-normalization";

/**
 * Pure product-evidence comparison between one Klaviyo-side product set and
 * the Shopify order's line set. Multiset semantics; never sums the Placed
 * Order item array with Ordered Product events; carries no revenue.
 */

export type KlaviyoProductObservation = {
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  quantity: number | null;
};

export type ShopifyLineObservation = {
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  sku: string | null;
  quantity: number;
};

export type ProductComparisonRow = {
  key: string;
  keyKind: "variant" | "product" | "sku";
  klaviyoQuantity: number | null;
  shopifyQuantity: number | null;
  agreement: "exact" | "family" | "quantity_conflict" | "missing";
};

export type ProductComparison = {
  status: ProductMatchStatus;
  source: "placed_order_items" | "ordered_product_events" | "none";
  rows: ProductComparisonRow[];
  reasonCodes: string[];
};

type Multiset = Map<string, number>;

function addQuantity(set: Multiset, key: string, quantity: number): void {
  set.set(key, (set.get(key) ?? 0) + quantity);
}

function canonicalVariant(value: string | null): string | null {
  if (value === null) return null;
  const canonical = canonicalizeVariantIdCandidate(value);
  return canonical && canonical.namespace === "shopify_variant_gid"
    ? canonical.value
    : null;
}

function canonicalProduct(value: string | null): string | null {
  if (value === null) return null;
  const canonical = canonicalizeProductIdCandidate(value);
  return canonical && canonical.namespace === "shopify_product_gid"
    ? canonical.value
    : null;
}

export function compareProducts(input: {
  source: "placed_order_items" | "ordered_product_events" | "none";
  klaviyoProducts: KlaviyoProductObservation[];
  shopifyLines: ShopifyLineObservation[];
}): ProductComparison {
  const reasonCodes: string[] = [];
  if (input.source === "none" || input.klaviyoProducts.length === 0) {
    return {
      status: "unavailable",
      source: "none",
      rows: [],
      reasonCodes: ["product_evidence_unavailable"],
    };
  }
  if (input.shopifyLines.length === 0) {
    return {
      status: "unavailable",
      source: input.source,
      rows: [],
      reasonCodes: ["shopify_lines_unavailable"],
    };
  }

  // Preferred key: variant; fall back to product family; SKU only when the
  // SKU is unambiguous on both sides for the compared lines.
  const klaviyoVariants: Multiset = new Map();
  const shopifyVariants: Multiset = new Map();
  const klaviyoProductsSet: Multiset = new Map();
  const shopifyProductsSet: Multiset = new Map();
  const klaviyoSkus: Multiset = new Map();
  const shopifySkus: Multiset = new Map();

  let klaviyoVariantCoverage = true;
  for (const product of input.klaviyoProducts) {
    const quantity = product.quantity ?? 1;
    const variant = canonicalVariant(product.variantId);
    const family = canonicalProduct(product.productId);
    const sku = product.sku === null ? null : canonicalizeSku(product.sku);
    if (variant) addQuantity(klaviyoVariants, variant, quantity);
    else klaviyoVariantCoverage = false;
    if (family) addQuantity(klaviyoProductsSet, family, quantity);
    if (sku) addQuantity(klaviyoSkus, sku.value, quantity);
  }
  let shopifyVariantCoverage = true;
  for (const line of input.shopifyLines) {
    const variant = canonicalVariant(line.shopifyVariantId);
    const family = canonicalProduct(line.shopifyProductId);
    const sku = line.sku === null ? null : canonicalizeSku(line.sku);
    if (variant) addQuantity(shopifyVariants, variant, line.quantity);
    else shopifyVariantCoverage = false;
    if (family) addQuantity(shopifyProductsSet, family, line.quantity);
    if (sku) addQuantity(shopifySkus, sku.value, line.quantity);
  }

  function compareMultisets(
    left: Multiset,
    right: Multiset,
    keyKind: ProductComparisonRow["keyKind"],
  ): { rows: ProductComparisonRow[]; exact: boolean; conflict: boolean; missing: boolean } {
    const rows: ProductComparisonRow[] = [];
    let exact = true;
    let conflict = false;
    let missing = false;
    for (const key of new Set([...left.keys(), ...right.keys()])) {
      const klaviyoQuantity = left.get(key) ?? null;
      const shopifyQuantity = right.get(key) ?? null;
      let agreement: ProductComparisonRow["agreement"];
      if (klaviyoQuantity === null || shopifyQuantity === null) {
        agreement = "missing";
        missing = true;
        exact = false;
      } else if (klaviyoQuantity === shopifyQuantity) {
        agreement = "exact";
      } else {
        agreement = "quantity_conflict";
        conflict = true;
        exact = false;
      }
      rows.push({ key, keyKind, klaviyoQuantity, shopifyQuantity, agreement });
    }
    return { rows, exact, conflict, missing };
  }

  // Variant-level comparison when both sides cover variants.
  if (
    klaviyoVariantCoverage &&
    shopifyVariantCoverage &&
    klaviyoVariants.size > 0 &&
    shopifyVariants.size > 0
  ) {
    const variantComparison = compareMultisets(
      klaviyoVariants,
      shopifyVariants,
      "variant",
    );
    if (variantComparison.exact) {
      return {
        status: "exact",
        source: input.source,
        rows: variantComparison.rows,
        reasonCodes: ["variant_multiset_exact"],
      };
    }
    if (variantComparison.conflict) {
      // Identifier disagreement between variants of the same product family
      // or quantity conflicts are contradictions, not partial evidence.
      return {
        status: "contradictory",
        source: input.source,
        rows: variantComparison.rows,
        reasonCodes: [
          variantComparison.rows.some((row) => row.agreement === "missing")
            ? "variant_identifier_conflict"
            : "variant_quantity_conflict",
        ],
      };
    }
    // Missing rows only: check product-family agreement below.
    reasonCodes.push("variant_multiset_incomplete");
  }

  // SKU support only when unambiguous on both sides for the compared lines.
  if (
    klaviyoVariants.size === 0 &&
    shopifyVariants.size === 0 &&
    klaviyoSkus.size > 0 &&
    shopifySkus.size > 0 &&
    klaviyoSkus.size === input.klaviyoProducts.length &&
    shopifySkus.size === input.shopifyLines.length
  ) {
    const skuComparison = compareMultisets(klaviyoSkus, shopifySkus, "sku");
    if (skuComparison.exact) {
      return {
        status: "exact",
        source: input.source,
        rows: skuComparison.rows,
        reasonCodes: ["sku_multiset_exact"],
      };
    }
    if (skuComparison.conflict) {
      return {
        status: "contradictory",
        source: input.source,
        rows: skuComparison.rows,
        reasonCodes: ["sku_quantity_conflict"],
      };
    }
    reasonCodes.push("sku_multiset_incomplete");
  }

  // Product-family evidence.
  if (klaviyoProductsSet.size > 0 && shopifyProductsSet.size > 0) {
    const familyComparison = compareMultisets(
      klaviyoProductsSet,
      shopifyProductsSet,
      "product",
    );
    if (familyComparison.conflict) {
      return {
        status: "contradictory",
        source: input.source,
        rows: familyComparison.rows,
        reasonCodes: [...reasonCodes, "product_quantity_conflict"],
      };
    }
    const anyOverlap = familyComparison.rows.some(
      (row) => row.agreement === "exact",
    );
    if (!anyOverlap) {
      return {
        status: "contradictory",
        source: input.source,
        rows: familyComparison.rows,
        reasonCodes: [...reasonCodes, "product_identifier_conflict"],
      };
    }
    return {
      status: familyComparison.exact && !reasonCodes.length
        ? "exact"
        : "partial",
      source: input.source,
      rows: familyComparison.rows,
      reasonCodes: [
        ...reasonCodes,
        familyComparison.exact
          ? "product_family_exact"
          : "product_family_partial",
      ],
    };
  }

  // One side lacks canonical identifiers entirely: partial evidence at best.
  return {
    status: "partial",
    source: input.source,
    rows: [],
    reasonCodes: [...reasonCodes, "identifier_coverage_missing"],
  };
}
