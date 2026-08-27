import { describe, expect, it } from "vitest";
import { formatMoneyCompact } from "./format";

describe("formatMoneyCompact", () => {
  it("shortens thousands and millions so an axis tick fits", () => {
    expect(formatMoneyCompact(18_000, "USD")).toBe("$18K");
    expect(formatMoneyCompact(13_500, "USD")).toBe("$13.5K");
    expect(formatMoneyCompact(1_200_000, "USD")).toBe("$1.2M");
  });

  /**
   * `Intl`'s own compact notation renders this "$18.0K" on some ICU versions
   * and "$18K" on others — the difference that failed CI while passing
   * locally. The scaling is ours precisely so the reading cannot drift.
   */
  it("never leaves a trailing .0, at either magnitude", () => {
    expect(formatMoneyCompact(18_000, "USD")).not.toContain(".0");
    expect(formatMoneyCompact(2_000_000, "USD")).toBe("$2M");
    expect(formatMoneyCompact(1_000, "USD")).toBe("$1K");
    // Rounds to a whole unit rather than printing "$19.0K".
    expect(formatMoneyCompact(18_990, "USD")).toBe("$19K");
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
