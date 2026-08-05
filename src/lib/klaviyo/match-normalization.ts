import { MATCHER_VERSION } from "@/lib/klaviyo/match-types";

/**
 * Pure, versioned canonicalizers for advisory matching. Only exact Shopify
 * GID structures canonicalize into ID namespaces; human order names stay in
 * their own namespace and never become order-ID evidence.
 */

export type CanonicalizedValue = {
  namespace:
    | "shopify_order_gid"
    | "shopify_product_gid"
    | "shopify_variant_gid"
    | "order_name"
    | "opaque";
  value: string;
  appliedCanonicalizers: string[];
};

const ORDER_GID = /^gid:\/\/shopify\/Order\/(\d+)$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/(\d+)$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;
const NUMERIC_ID = /^\d+$/;
const ORDER_NAME = /^#\S+$/;

function versioned(name: string): string {
  return `${name}@${MATCHER_VERSION}`;
}

export function canonicalizeOrderIdCandidate(
  raw: string,
): CanonicalizedValue | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const applied: string[] = [versioned("trim")];
  const gid = ORDER_GID.exec(trimmed);
  if (gid) {
    return {
      namespace: "shopify_order_gid",
      value: gid[1],
      appliedCanonicalizers: [...applied, versioned("shopify_order_gid")],
    };
  }
  if (NUMERIC_ID.test(trimmed)) {
    return {
      namespace: "shopify_order_gid",
      value: trimmed,
      appliedCanonicalizers: [...applied, versioned("trimmed_exact")],
    };
  }
  if (ORDER_NAME.test(trimmed)) {
    // Human order names live in a separate namespace; punctuation and
    // digits are preserved, never stripped into an ID.
    return {
      namespace: "order_name",
      value: trimmed,
      appliedCanonicalizers: [...applied, versioned("order_name")],
    };
  }
  return {
    namespace: "opaque",
    value: trimmed,
    appliedCanonicalizers: [...applied, versioned("opaque")],
  };
}

export function canonicalizeProductIdCandidate(
  raw: string,
): CanonicalizedValue | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const applied: string[] = [versioned("trim")];
  const product = PRODUCT_GID.exec(trimmed);
  if (product) {
    return {
      namespace: "shopify_product_gid",
      value: product[1],
      appliedCanonicalizers: [...applied, versioned("shopify_product_gid")],
    };
  }
  if (NUMERIC_ID.test(trimmed)) {
    return {
      namespace: "shopify_product_gid",
      value: trimmed,
      appliedCanonicalizers: [...applied, versioned("trimmed_exact")],
    };
  }
  return {
    namespace: "opaque",
    value: trimmed,
    appliedCanonicalizers: [...applied, versioned("opaque")],
  };
}

export function canonicalizeVariantIdCandidate(
  raw: string,
): CanonicalizedValue | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const applied: string[] = [versioned("trim")];
  const variant = VARIANT_GID.exec(trimmed);
  if (variant) {
    return {
      namespace: "shopify_variant_gid",
      value: variant[1],
      appliedCanonicalizers: [...applied, versioned("shopify_variant_gid")],
    };
  }
  if (NUMERIC_ID.test(trimmed)) {
    return {
      namespace: "shopify_variant_gid",
      value: trimmed,
      appliedCanonicalizers: [...applied, versioned("trimmed_exact")],
    };
  }
  return {
    namespace: "opaque",
    value: trimmed,
    appliedCanonicalizers: [...applied, versioned("opaque")],
  };
}

/** SKU comparison is exact after trim; case and punctuation preserved. */
export function canonicalizeSku(raw: string): CanonicalizedValue | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return {
    namespace: "opaque",
    value: trimmed,
    appliedCanonicalizers: [versioned("trim"), versioned("sku_trimmed_exact")],
  };
}
