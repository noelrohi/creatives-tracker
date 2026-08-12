import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("server-only", () => ({}));

const { retainedMetaReportRange } = await import("./meta-sync");

describe("retainedMetaReportRange", () => {
  const today = "2026-08-12";

  it("clamps a base report to the 180-day window", () => {
    expect(
      retainedMetaReportRange({
        dateFrom: "2025-01-01",
        dateTo: "2026-08-12",
        today,
      }),
    ).toEqual({
      kind: "retained",
      dateFrom: "2026-02-13",
      dateTo: "2026-08-12",
      label: "base",
      windowStart: "2026-02-13",
    });
  });

  it("clamps a breakdown report to the 14-day window", () => {
    expect(
      retainedMetaReportRange({
        dateFrom: "2026-07-01",
        dateTo: "2026-08-12",
        breakdown: "country",
        today,
      }),
    ).toEqual({
      kind: "retained",
      dateFrom: "2026-07-29",
      dateTo: "2026-08-12",
      label: "country",
      windowStart: "2026-07-29",
    });
  });

  it("rejects a report whose whole range is expired", () => {
    expect(
      retainedMetaReportRange({
        dateFrom: "2026-01-01",
        dateTo: "2026-07-28",
        breakdown: "device_platform",
        today,
      }),
    ).toEqual({
      kind: "expired",
      label: "device",
      windowStart: "2026-07-29",
    });
  });
});
