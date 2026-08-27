import { describe, expect, it } from "vitest";
import { formatMoneyCompact } from "./format";

describe("formatMoneyCompact", () => {
  it("shortens thousands and millions so an axis tick fits", () => {
    expect(formatMoneyCompact(18_000, "USD")).toBe("$18K");
    expect(formatMoneyCompact(13_500, "USD")).toBe("$13.5K");
    expect(formatMoneyCompact(1_200_000, "USD")).toBe("$1.2M");
  });

  it("prints whole dollars under a thousand, where 'K' would read worse", () => {
    expect(formatMoneyCompact(900, "USD")).toBe("$900");
    expect(formatMoneyCompact(0, "USD")).toBe("$0");
  });

  it("accepts the decimal strings money arrives as", () => {
    expect(formatMoneyCompact("15624.69", "USD")).toBe("$15.6K");
  });

  it("returns null when there is no number, so callers can say 'no data yet'", () => {
    expect(formatMoneyCompact(null, "USD")).toBeNull();
    expect(formatMoneyCompact(undefined, "USD")).toBeNull();
    expect(formatMoneyCompact("", "USD")).toBeNull();
    expect(formatMoneyCompact("not a number", "USD")).toBeNull();
  });

  it("handles negatives the same way", () => {
    expect(formatMoneyCompact(-2_500, "USD")).toBe("-$2.5K");
  });
});
