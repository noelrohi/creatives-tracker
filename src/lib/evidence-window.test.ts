import { describe, expect, it } from "vitest";
import {
  assertValidIanaTimezone,
  assertValidStoreDay,
  deriveShopifyEvidenceWindow,
  inclusiveStoreDaysToHalfOpenUtc,
} from "@/lib/evidence-window";

describe("Shopify evidence windows", () => {
  it("converts the 2026 New York spring-forward day to 23 hours", () => {
    const window = inclusiveStoreDaysToHalfOpenUtc({
      dateFrom: "2026-03-08",
      dateTo: "2026-03-08",
      timeZone: "America/New_York",
    });
    expect(window.from.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("converts the 2026 New York fall-back day to 25 hours", () => {
    const window = inclusiveStoreDaysToHalfOpenUtc({
      dateFrom: "2026-11-01",
      dateTo: "2026-11-01",
      timeZone: "America/New_York",
    });
    expect(window.from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("uses the earliest repeated midnight for the 2026 Havana fall-back day", () => {
    const window = inclusiveStoreDaysToHalfOpenUtc({
      dateFrom: "2026-11-01",
      dateTo: "2026-11-01",
      timeZone: "America/Havana",
    });
    expect(window.from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(window.to.getTime() - window.from.getTime()).toBe(
      25 * 60 * 60 * 1_000,
    );
  });

  it.each([
    {
      timeZone: "America/Havana",
      day: "2026-03-08",
      from: "2026-03-08T05:00:00.000Z",
      to: "2026-03-09T04:00:00.000Z",
    },
    {
      timeZone: "Asia/Beirut",
      day: "2026-03-29",
      from: "2026-03-28T22:00:00.000Z",
      to: "2026-03-29T21:00:00.000Z",
    },
    {
      timeZone: "America/Santiago",
      day: "2026-09-06",
      from: "2026-09-06T04:00:00.000Z",
      to: "2026-09-07T03:00:00.000Z",
    },
  ])(
    "uses the earliest representable instant when $timeZone skips local midnight",
    ({ timeZone, day, from, to }) => {
      const window = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: day,
        dateTo: day,
        timeZone,
      });
      expect(window.from.toISOString()).toBe(from);
      expect(window.to.toISOString()).toBe(to);
      expect(window.to.getTime() - window.from.getTime()).toBe(
        23 * 60 * 60 * 1_000,
      );
    },
  );

  it("rejects a civil date skipped for its entire duration", () => {
    expect(() =>
      inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: "2011-12-30",
        dateTo: "2011-12-30",
        timeZone: "Pacific/Apia",
      }),
    ).toThrow("Store-local civil day cannot be represented");
  });

  it("converts an ordinary Manila inclusive range to next-day exclusive UTC", () => {
    const window = inclusiveStoreDaysToHalfOpenUtc({
      dateFrom: "2026-07-30",
      dateTo: "2026-07-31",
      timeZone: "Asia/Manila",
    });
    expect(window.from.toISOString()).toBe("2026-07-29T16:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-07-31T16:00:00.000Z");
  });

  it("derives exact inclusive 90-day and 7-day anchor ranges", () => {
    const initial = deriveShopifyEvidenceWindow({
      mode: "initial_90d",
      anchorStoreDay: "2026-07-31",
      timeZone: "Asia/Manila",
    });
    const incremental = deriveShopifyEvidenceWindow({
      mode: "incremental_7d",
      anchorStoreDay: "2026-07-31",
      timeZone: "Asia/Manila",
    });
    expect(initial.from.toISOString()).toBe("2026-05-02T16:00:00.000Z");
    expect(initial.to.toISOString()).toBe("2026-07-31T16:00:00.000Z");
    expect(incremental.from.toISOString()).toBe("2026-07-24T16:00:00.000Z");
    expect(incremental.to.toISOString()).toBe("2026-07-31T16:00:00.000Z");
  });

  it("does not depend on the process timezone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu";
      const honoluluProcess = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: "2026-03-08",
        dateTo: "2026-03-08",
        timeZone: "America/New_York",
      });
      process.env.TZ = "Asia/Tokyo";
      const tokyoProcess = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: "2026-03-08",
        dateTo: "2026-03-08",
        timeZone: "America/New_York",
      });
      expect(tokyoProcess).toEqual(honoluluProcess);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("rejects malformed, impossible, reversed, and invalid-timezone input", () => {
    for (const value of ["2026-7-01", "2026-02-29", "2026-13-01", "x"]) {
      expect(() => assertValidStoreDay(value)).toThrow();
    }
    expect(() => assertValidIanaTimezone("Not/A_Zone")).toThrow();
    expect(() => assertValidIanaTimezone("US/Eastern")).toThrow();
    expect(() =>
      inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: "2026-08-01",
        dateTo: "2026-07-31",
        timeZone: "UTC",
      }),
    ).toThrow();
  });
});
