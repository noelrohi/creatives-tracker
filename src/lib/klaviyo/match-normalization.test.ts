import { describe, expect, it } from "vitest";
import {
  canonicalizeOrderIdCandidate,
  canonicalizeProductIdCandidate,
  canonicalizeSku,
  canonicalizeVariantIdCandidate,
} from "@/lib/klaviyo/match-normalization";

describe("match normalization", () => {
  it("canonicalizes only exact Shopify GID structures", () => {
    expect(canonicalizeOrderIdCandidate("gid://shopify/Order/1001")).toMatchObject({
      namespace: "shopify_order_gid",
      value: "1001",
    });
    expect(
      canonicalizeProductIdCandidate("gid://shopify/Product/42"),
    ).toMatchObject({ namespace: "shopify_product_gid", value: "42" });
    expect(
      canonicalizeVariantIdCandidate("gid://shopify/ProductVariant/9"),
    ).toMatchObject({ namespace: "shopify_variant_gid", value: "9" });
    // Wrong resource type never canonicalizes into the order namespace.
    expect(
      canonicalizeOrderIdCandidate("gid://shopify/Customer/1001"),
    ).toMatchObject({ namespace: "opaque" });
  });

  it("keeps human order names in a separate namespace", () => {
    expect(canonicalizeOrderIdCandidate("#1001")).toMatchObject({
      namespace: "order_name",
      value: "#1001",
    });
    expect(canonicalizeOrderIdCandidate("#1001")!.namespace).not.toBe(
      "shopify_order_gid",
    );
  });

  it("trims surrounding whitespace without stripping punctuation or digits", () => {
    expect(canonicalizeOrderIdCandidate("  gid://shopify/Order/77  ")).toMatchObject(
      { namespace: "shopify_order_gid", value: "77" },
    );
    expect(canonicalizeOrderIdCandidate(" #10-01 ")).toMatchObject({
      namespace: "order_name",
      value: "#10-01",
    });
  });

  it("compares SKUs exactly after trim", () => {
    expect(canonicalizeSku("  SKU-One.2 ")).toMatchObject({
      value: "SKU-One.2",
    });
    expect(canonicalizeSku("SKU-one.2")!.value).not.toBe(
      canonicalizeSku("SKU-One.2")!.value,
    );
  });

  it("returns every applied canonicalizer in versioned explanation data", () => {
    const canonical = canonicalizeOrderIdCandidate(" gid://shopify/Order/5 ");
    expect(canonical!.appliedCanonicalizers).toEqual([
      "trim@klaviyo-v1",
      "shopify_order_gid@klaviyo-v1",
    ]);
    expect(canonicalizeSku(" A ")!.appliedCanonicalizers).toEqual([
      "trim@klaviyo-v1",
      "sku_trimmed_exact@klaviyo-v1",
    ]);
  });
});
