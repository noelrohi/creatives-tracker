import { describe, expect, it } from "vitest";
import { inclusiveStoreDaysToHalfOpenUtc } from "@/lib/evidence-window";
import { nightlyReportWindow } from "./report-window";

describe("nightlyReportWindow", () => {
  const now = new Date("2026-09-08T20:30:00.000Z");

  it("uses the account timezone's own calendar day east of UTC", () => {
    // 20:30Z is already 09-09 in Tokyo, so the nightly slot must be the
    // 30 inclusive days ending 09-09 — exactly what the ledger reads.
    expect(nightlyReportWindow(now, "Asia/Tokyo")).toEqual(
      inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: "2026-08-11",
        dateTo: "2026-09-09",
        timeZone: "Asia/Tokyo",
      }),
    );
  });

  it("matches the pilot account's Bangkok day (UTC+7)", () => {
    // 20:30Z is 03:30 on 09-09 in Bangkok — the pilot account's timezone,
    // squarely inside the class the UTC-day bug broke.
    expect(nightlyReportWindow(now, "Asia/Bangkok")).toEqual(
      inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: "2026-08-11",
        dateTo: "2026-09-09",
        timeZone: "Asia/Bangkok",
      }),
    );
  });

  it("uses the account timezone's own calendar day west of UTC", () => {
    // 20:30Z is still 09-08 in Los Angeles.
    expect(nightlyReportWindow(now, "America/Los_Angeles")).toEqual(
      inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: "2026-08-10",
        dateTo: "2026-09-08",
        timeZone: "America/Los_Angeles",
      }),
    );
  });

  it("matches the UTC days for a UTC account", () => {
    expect(nightlyReportWindow(now, "UTC")).toEqual(
      inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: "2026-08-10",
        dateTo: "2026-09-08",
        timeZone: "UTC",
      }),
    );
  });
});
