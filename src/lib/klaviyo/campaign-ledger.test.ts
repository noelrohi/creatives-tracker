import { describe, expect, it } from "vitest";
import { ledgerRates } from "@/lib/klaviyo/campaign-ledger";

const stats = {
  recipients: 1000,
  delivered: 990,
  uniqueOpens: 400,
  uniqueClicks: 40,
  bounced: 10,
  unsubscribes: 2,
  spamComplaints: 0,
  conversions: 20,
  conversionValue: "1200.00",
};

describe("ledgerRates", () => {
  it("uses Klaviyo's denominators", () => {
    expect(ledgerRates(stats)).toEqual({
      delivered: 0.99,
      open: 400 / 990,
      click: 40 / 990,
      unsubscribe: 2 / 990,
    });
  });

  it("is null on a null or zero denominator, never 0%", () => {
    expect(ledgerRates(null)).toEqual({
      delivered: null,
      open: null,
      click: null,
      unsubscribe: null,
    });
    expect(ledgerRates({ ...stats, delivered: 0 })).toMatchObject({
      open: null,
      click: null,
      unsubscribe: null,
    });
    expect(ledgerRates({ ...stats, recipients: null })).toMatchObject({
      delivered: null,
    });
    expect(ledgerRates({ ...stats, uniqueOpens: null })).toMatchObject({
      open: null,
      click: 40 / 990,
    });
  });
});
