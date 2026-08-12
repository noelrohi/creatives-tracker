import { describe, expect, it } from "vitest";
import {
  assertProbeCanBeApproved,
  assertRuleCanBeApproved,
} from "@/lib/klaviyo/join-rules";

describe("assertRuleCanBeApproved", () => {
  it("requires a passed probe and zero collisions", () => {
    expect(() =>
      assertRuleCanBeApproved({
        probeStatus: "passed",
        state: "candidate",
        canonicalizer: "shopify_order_gid",
        observedPopulated: 20,
        observedCollisions: 0,
      }),
    ).not.toThrow();
    expect(() =>
      assertRuleCanBeApproved({
        probeStatus: "passed",
        state: "candidate",
        canonicalizer: "shopify_order_gid",
        observedPopulated: 20,
        observedCollisions: 1,
      }),
    ).toThrow("Join rules with observed collisions cannot be approved");
  });

  it("rejects non-passed probes, non-candidates, and unknown canonicalizers", () => {
    expect(() =>
      assertRuleCanBeApproved({
        probeStatus: "pending",
        state: "candidate",
        canonicalizer: "shopify_order_gid",
        observedPopulated: 20,
        observedCollisions: 0,
      }),
    ).toThrow("Join rules require a passed probe report");
    expect(() =>
      assertRuleCanBeApproved({
        probeStatus: "passed",
        state: "approved",
        canonicalizer: "shopify_order_gid",
        observedPopulated: 20,
        observedCollisions: 0,
      }),
    ).toThrow("Only candidate join rules can be approved");
    expect(() =>
      assertRuleCanBeApproved({
        probeStatus: "passed",
        state: "candidate",
        canonicalizer: "lowercase_fuzzy",
        observedPopulated: 20,
        observedCollisions: 0,
      }),
    ).toThrow("Join rule canonicalizer is not allowlisted");
    expect(() =>
      assertRuleCanBeApproved({
        probeStatus: "passed",
        state: "candidate",
        canonicalizer: "trimmed_exact",
        observedPopulated: 0,
        observedCollisions: 0,
      }),
    ).toThrow("Join rules require populated probe observations");
  });
});

describe("assertProbeCanBeApproved", () => {
  const eligible = {
    status: "pending",
    sampledShopifyOrders: 25,
    bindingOverlapCount: 4,
    redactionVerified: true,
    enabledOrderMetricKinds: ["placed_order", "ordered_product"],
  };

  it("accepts an eligible pending report", () => {
    expect(() => assertProbeCanBeApproved(eligible)).not.toThrow();
  });

  it("rejects every ineligible dimension", () => {
    expect(() =>
      assertProbeCanBeApproved({ ...eligible, status: "passed" }),
    ).toThrow("Only pending probe reports can be approved");
    expect(() =>
      assertProbeCanBeApproved({ ...eligible, sampledShopifyOrders: 19 }),
    ).toThrow("Probe sample size is outside the approved range");
    expect(() =>
      assertProbeCanBeApproved({ ...eligible, sampledShopifyOrders: 51 }),
    ).toThrow("Probe sample size is outside the approved range");
    expect(() =>
      assertProbeCanBeApproved({ ...eligible, bindingOverlapCount: 0 }),
    ).toThrow("Probe found no binding overlap with sampled orders");
    expect(() =>
      assertProbeCanBeApproved({ ...eligible, redactionVerified: false }),
    ).toThrow("Probe redaction verification is required");
    expect(() =>
      assertProbeCanBeApproved({
        ...eligible,
        enabledOrderMetricKinds: ["placed_order"],
      }),
    ).toThrow("Probe requires exactly the enabled native order metrics");
    expect(() =>
      assertProbeCanBeApproved({
        ...eligible,
        enabledOrderMetricKinds: [
          "placed_order",
          "ordered_product",
          "clicked_email",
        ],
      }),
    ).toThrow("Probe requires exactly the enabled native order metrics");
  });
});
