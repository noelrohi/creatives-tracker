import { describe, expect, it } from "vitest";
import { GoogleAdsApiError } from "@/lib/google-ads/client";
import {
  evaluateDiscoveryRow,
  sanitizeGoogleAdsError,
} from "@/lib/google-ads/discovery";

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

  it("rejects a row with a missing manager field", () => {
    const result = evaluateDiscoveryRow(
      {
        customer: {
          id: "1234567890",
          descriptiveName: "Reviv Ads",
          currencyCode: "USD",
          timeZone: "America/New_York",
        },
      },
      "1234567890",
    );
    expect(result).toEqual({ ok: false, code: "malformed_customer" });
  });
});

describe("sanitizeGoogleAdsError", () => {
  it("maps a retryable GoogleAdsApiError to provider_unavailable", () => {
    const error = new GoogleAdsApiError("upstream is down", 503, true);
    expect(sanitizeGoogleAdsError(error)).toEqual({
      code: "provider_unavailable",
      message: "upstream is down",
    });
  });

  it("maps a non-retryable GoogleAdsApiError to provider_rejected", () => {
    const error = new GoogleAdsApiError("bad request", 400, false);
    expect(sanitizeGoogleAdsError(error)).toEqual({
      code: "provider_rejected",
      message: "bad request",
    });
  });

  it("maps a plain Error to a fixed internal_error message", () => {
    const error = new Error("something exploded");
    expect(sanitizeGoogleAdsError(error)).toEqual({
      code: "internal_error",
      message: "Google Ads sync failed unexpectedly",
    });
  });
});
