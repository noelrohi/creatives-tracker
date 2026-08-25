import { describe, expect, it } from "vitest";
import { formatDateOnly, formatDateOnlyInTimeZone } from "./date";

describe("formatDateOnlyInTimeZone", () => {
  // 2026-08-25 02:00 UTC: already the 25th in Bangkok (UTC+7), still the
  // 24th in Los Angeles (UTC-7) — the exact skew the Meta screens exist in.
  const moment = new Date("2026-08-25T02:00:00Z");

  it("reads the day off the given zone's clock", () => {
    expect(formatDateOnlyInTimeZone(moment, "Asia/Bangkok")).toBe("2026-08-25");
    expect(formatDateOnlyInTimeZone(moment, "America/Los_Angeles")).toBe(
      "2026-08-24",
    );
    expect(formatDateOnlyInTimeZone(moment, "UTC")).toBe("2026-08-25");
  });

  it("falls back to the local-clock date on an invalid zone name", () => {
    expect(formatDateOnlyInTimeZone(moment, "Not/AZone")).toBe(
      formatDateOnly(moment),
    );
  });
});
