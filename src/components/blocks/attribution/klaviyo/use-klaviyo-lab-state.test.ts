import { describe, expect, it } from "vitest";
import {
  resolveJourneyLookback,
  resolveLabDayRange,
} from "./use-klaviyo-lab-state";

const BASE = {
  view: "orders" as const,
  from: null,
  to: null,
  storeToday: "2026-07-31",
  accountToday: "2026-07-31",
};

describe("resolveLabDayRange", () => {
  it("resolves the three fixed lookbacks from store today", () => {
    expect(resolveLabDayRange({ ...BASE, range: "last7" })).toEqual({
      dateFrom: "2026-07-25",
      dateTo: "2026-07-31",
      timezoneKind: "store",
    });
    expect(resolveLabDayRange({ ...BASE, range: "last30" })).toEqual({
      dateFrom: "2026-07-02",
      dateTo: "2026-07-31",
      timezoneKind: "store",
    });
    expect(resolveLabDayRange({ ...BASE, range: "last90" })).toEqual({
      dateFrom: "2026-05-03",
      dateTo: "2026-07-31",
      timezoneKind: "store",
    });
  });

  it("clamps custom future days and collapses reversed input", () => {
    expect(
      resolveLabDayRange({
        ...BASE,
        range: "custom",
        from: "2026-07-10",
        to: "2026-09-01",
      }),
    ).toEqual({
      dateFrom: "2026-07-10",
      dateTo: "2026-07-31",
      timezoneKind: "store",
    });
    expect(
      resolveLabDayRange({
        ...BASE,
        range: "custom",
        from: "2026-07-20",
        to: "2026-07-05",
      }),
    ).toEqual({
      dateFrom: "2026-07-20",
      dateTo: "2026-07-20",
      timezoneKind: "store",
    });
  });

  it("falls back locally on malformed days instead of issuing invalid input", () => {
    const resolved = resolveLabDayRange({
      ...BASE,
      range: "custom",
      from: "07/01/2026",
      to: "not-a-day",
    });
    expect(resolved).toEqual({
      dateFrom: "2026-07-02",
      dateTo: "2026-07-31",
      timezoneKind: "store",
    });
  });

  it("resolves reports from account today with the account timezone label", () => {
    const input = {
      ...BASE,
      view: "reports" as const,
      range: "last7" as const,
      storeToday: "2026-07-31",
      accountToday: "2026-07-30",
    };
    expect(resolveLabDayRange(input)).toEqual({
      dateFrom: "2026-07-24",
      dateTo: "2026-07-30",
      timezoneKind: "account",
    });
    expect(
      resolveLabDayRange({ ...input, view: "orders" }),
    ).toEqual({
      dateFrom: "2026-07-25",
      dateTo: "2026-07-31",
      timezoneKind: "store",
    });
  });
});

describe("resolveJourneyLookback", () => {
  it("accepts only supported lookbacks and falls back to 30", () => {
    expect(resolveJourneyLookback(7)).toBe(7);
    expect(resolveJourneyLookback(90)).toBe(90);
    expect(resolveJourneyLookback(14)).toBe(30);
    expect(resolveJourneyLookback(null)).toBe(30);
  });
});
