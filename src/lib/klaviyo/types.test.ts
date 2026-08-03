import { describe, expect, it } from "vitest";
import {
  KLAVIYO_ORDER_CORE_KINDS,
  assertExactOrderCoreRequestParameters,
  assertOrderCoreSourceContract,
  assertHalfOpenWindow,
  initialEventCheckpoint,
  orderCoreSourceContract,
} from "@/lib/klaviyo/types";

describe("Klaviyo source types", () => {
  it("keeps the order-core metric order deterministic", () => {
    expect(KLAVIYO_ORDER_CORE_KINDS).toEqual([
      "placed_order",
      "ordered_product",
    ]);
    expect(initialEventCheckpoint()).toEqual({
      ...orderCoreSourceContract(),
      metricIndex: 0,
      cursor: null,
      page: 0,
    });
  });

  it("accepts only a non-empty half-open window", () => {
    expect(() =>
      assertHalfOpenWindow({
        from: new Date("2026-05-01T00:00:00.000Z"),
        to: new Date("2026-07-30T00:00:00.000Z"),
      }),
    ).not.toThrow();
    expect(() =>
      assertHalfOpenWindow({
        from: new Date("2026-07-30T00:00:00.000Z"),
        to: new Date("2026-07-30T00:00:00.000Z"),
      }),
    ).toThrow("from must be before to");
  });

  it("pins the immutable order-core run contract", () => {
    expect(orderCoreSourceContract()).toEqual({
      sourceMode: "order_core",
      metricKinds: ["placed_order", "ordered_product"],
    });
    expect(() =>
      assertOrderCoreSourceContract({
        sourceMode: "journey",
        metricKinds: ["placed_order"],
      }),
    ).toThrow("invalid source contract");
    expect(() =>
      assertExactOrderCoreRequestParameters({
        ...orderCoreSourceContract(),
        unsafeExtra: true,
      }),
    ).toThrow("not immutable order core");
  });
});
