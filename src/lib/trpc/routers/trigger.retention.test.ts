import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk", () => ({
  auth: { createPublicToken: vi.fn() },
  tasks: { trigger: vi.fn() },
}));

const { clampMetaSyncDateFrom } = await import("./trigger");

describe("clampMetaSyncDateFrom", () => {
  it("clamps requested history to the base retention window", () => {
    expect(clampMetaSyncDateFrom("2025-01-01", "2026-08-12")).toEqual({
      dateFrom: "2026-02-13",
      clampedFrom: "2026-02-13",
    });
  });

  it("leaves retained and omitted ranges unchanged", () => {
    expect(clampMetaSyncDateFrom("2026-08-01", "2026-08-12")).toEqual({
      dateFrom: "2026-08-01",
      clampedFrom: undefined,
    });
    expect(clampMetaSyncDateFrom(undefined, "2026-08-12")).toEqual({
      dateFrom: undefined,
      clampedFrom: undefined,
    });
  });
});
