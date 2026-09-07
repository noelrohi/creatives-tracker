import { describe, expect, it } from "vitest";
import { fulfillmentSummarySchema, summarizeFulfillment } from "./shopify-fulfillment";

const group = (status: string, count: number) => ({ status, count, oldestMs: null, newestMs: null });

describe("fulfillment answer availability", () => {
  it("preserves observations without answering a partially classified population", () => {
    const result = fulfillmentSummarySchema.parse(summarizeFulfillment([group("UNFULFILLED", 2), group("UNKNOWN", 3), group("CANCELLED", 4)]));
    expect(result.answer).toEqual({ unfulfilledCount: null, availability: "partial", sourceCoverage: "unknown" });
    expect(result.observedUnfulfilledCount).toBe(2);
    expect(result.observedNonCancelledCount).toBe(5);
    expect(result.excludedCancelledCount).toBe(4);
  });
  it.each([{ groups: [] }, { groups: [group("UNKNOWN", 3)] }, { groups: [group("CANCELLED", 2)] }])("does not turn unknown or empty observations into zero", ({ groups }) => {
    const result = summarizeFulfillment(groups);
    expect(result.answer.unfulfilledCount).toBeNull();
    expect(result.answer.availability).toBe("unknown");
  });
  it("answers a classified local zero without claiming source completeness", () => {
    const result = summarizeFulfillment([group("FULFILLED", 3), group("PARTIALLY_FULFILLED", 2)]);
    expect(result.answer).toEqual({ unfulfilledCount: 0, availability: "available_for_observed_orders", sourceCoverage: "unknown" });
    expect(result.statusCoverage.state).toBe("complete_for_observed_orders");
  });
  it("counts only strict unfulfilled statuses and treats unfamiliar statuses as unknown", () => {
    const groups = [group("UNFULFILLED", 1), group("OPEN", 2), group("RESTOCKED", 3)];
    expect(summarizeFulfillment(groups).answer.unfulfilledCount).toBe(6);
    expect(summarizeFulfillment([...groups, group("NEW_STATUS", 1)]).answer.unfulfilledCount).toBeNull();
  });
});
