import { describe, expect, it } from "vitest";
import { addDays, isDay } from "./day";

describe("isDay", () => {
  it("accepts real calendar days only", () => {
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2026-02-31")).toBe(false);
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay("2026-00-10")).toBe(false);
    expect(isDay("07/01/2026")).toBe(false);
    expect(isDay("2026-7-1")).toBe(false);
  });
});

describe("addDays", () => {
  it("moves across month and year boundaries in UTC", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
