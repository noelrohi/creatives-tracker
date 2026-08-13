import { describe, expect, it } from "vitest";
import { evaluateDiscoveryRow } from "@/lib/google-ads/discovery";

describe("evaluateDiscoveryRow", () => {
  const GOOD = {
    customer: {
      id: "1234567890",
      descriptiveName: "Reviv Ads",
      currencyCode: "USD",
      timeZone: "America/New_York",
      manager: false,
    },
  };

  it("accepts a matching non-manager customer", () => {
    const result = evaluateDiscoveryRow(GOOD, "1234567890");
    expect(result).toEqual({
      ok: true,
      customer: {
        googleCustomerId: "1234567890",
        descriptiveName: "Reviv Ads",
        currencyCode: "USD",
        timezone: "America/New_York",
      },
    });
  });

  it("rejects a manager account", () => {
    const result = evaluateDiscoveryRow(
      { customer: { ...GOOD.customer, manager: true } },
      "1234567890",
    );
    expect(result).toEqual({ ok: false, code: "manager_account" });
  });

  it("rejects a customer ID mismatch", () => {
    const result = evaluateDiscoveryRow(GOOD, "1111111111");
    expect(result).toEqual({ ok: false, code: "customer_mismatch" });
  });

  it("rejects a malformed row", () => {
    expect(evaluateDiscoveryRow({}, "1234567890")).toEqual({
      ok: false,
      code: "malformed_customer",
    });
  });
});
