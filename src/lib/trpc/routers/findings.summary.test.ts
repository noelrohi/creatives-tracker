/**
 * `findings.list` renders its `summary` and `details` through the same two
 * functions the attribution screen uses, so an API client quoting a finding
 * says what the dashboard says. These fixtures are real payloads, frozen by the
 * rules in production — including the mixed units (cents in some rules, dollars
 * in others) that are the reason the rendering happens server-side at all.
 */

import { describe, expect, it } from "vitest";
import {
  findingBody,
  findingHeadline,
  type FindingItem,
  type VoiceContext,
} from "@/components/blocks/attribution/copy";
import { FINDING_TYPES, type FindingType } from "@/lib/findings";

const VOICE: VoiceContext = { currency: "USD", timeZone: "Asia/Bangkok" };

const PAYLOADS: Record<FindingType, Record<string, unknown>> = {
  meta_overclaim: {
    multiple: 2,
    consecutiveDays: 3,
    windowMultiple: 3.4,
    baselineMultiple: 1.8,
    days: [
      { day: "2026-08-15", claimedCents: 912_00, verifiedCents: 268_00, gapCents: 644_00 },
      { day: "2026-08-16", claimedCents: 874_00, verifiedCents: 251_00, gapCents: 623_00 },
      { day: "2026-08-17", claimedCents: 940_00, verifiedCents: 277_00, gapCents: 663_00 },
    ],
  },
  unattributed_spike: {
    minShare: 0.25,
    medianMultiple: 1.5,
    baselineDays: 21,
    baselineMedianShare: 0.12,
    days: [
      { day: "2026-08-16", share: 0.31, unattributedCents: 421_500, totalCents: 1_359_600 },
      { day: "2026-08-17", share: 0.34, unattributedCents: 466_200, totalCents: 1_371_100 },
    ],
  },
  broken_utm_template: {
    day: "2026-08-14",
    threshold: 5,
    orderCount: 5,
    paidMediums: ["paid", "cpc", "ppc", "ads", "sem", "display"],
    samples: [{ utmSource: null, utmMedium: "paid", utmCampaign: "120251389911510151" }],
  },
  sync_failure: {
    connector: "shopify",
    connectors: [
      {
        connector: "shopify",
        lastSuccessAt: "2026-08-17T17:17:50.606Z",
        hoursSinceLastSuccess: 2.21,
      },
    ],
    lastSuccessAt: "2026-08-17T17:17:50.606Z",
    hoursSinceLastSuccess: 2.21,
  },
  roas_below_target: {
    target: 1.5,
    consecutiveDays: 7,
    days: [
      { day: "2026-08-16", roas: 0.8, spendCents: 762_658, verifiedRevenueCents: 610_259 },
      { day: "2026-08-17", roas: 0.79, spendCents: 603_377, verifiedRevenueCents: 479_342 },
    ],
  },
  ad_lp_funnel_mismatch: {
    headline:
      "You spent $996.66 this week sending top-of-funnel traffic to a bottom-of-funnel page.",
    minSpend7d: 100,
    totalCount: 21,
    topAd: {
      adId: "fd899c5f-91d9-4aeb-9091-e6ae3fe12f2b",
      adName: "R3 light - 20260727",
      adFunnelStage: "tof",
      pageFunnelStage: "bof",
      normalizedUrl: "getreviv.com/pages/r3-light",
      trailing7dSpend: 996.66,
      trailing7dRevenue: 1567.5,
      trailing7dLandingPageViews: 661,
    },
    offendingAds: [],
  },
  untagged_spend: {
    headline: "731 active ads are untagged — $21808.40/wk of spend is invisible.",
    share: 0.7031372669135294,
    untaggedSpend: 21808.399999999976,
    untaggedAdCount: 731,
    totalActiveSpend: 31015.849999999977,
    taggedSpendMinShare: 0.8,
  },
  utm_template_drift: {
    headline: "A new ad is sending non-standard UTMs — 12 orders yesterday.",
    day: "2026-08-17",
    threshold: 3,
    orderCount: 12,
    matchMethods: ["unmatched"],
    offenders: [
      { adId: null, adName: null, orderCount: 12, matchMethod: "unmatched", rawUtmContent: "sag_organic" },
    ],
    samples: [{ count: 12, utmContent: "sag_organic" }],
  },
};

function itemFor(type: FindingType, payload: Record<string, unknown> | null): FindingItem {
  return {
    id: "finding-id",
    type,
    firedAt: new Date("2026-08-17T19:30:26.695Z"),
    periodStart: "2026-08-11",
    periodEnd: "2026-08-17",
    payload,
    resolvedAt: null,
    resolution: null,
    mutedUntil: null,
  };
}

describe("findings.list summary rendering", () => {
  it.each(FINDING_TYPES)("renders a summary and details for %s", (type) => {
    const item = itemFor(type, PAYLOADS[type]);

    const summary = findingHeadline(item, VOICE);
    const details = findingBody(item, VOICE);

    expect(summary.length).toBeGreaterThan(0);
    expect(details.length).toBeGreaterThan(0);
    for (const paragraph of details) {
      expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  it.each(FINDING_TYPES)("never leaks payload key names or raw cents for %s", (type) => {
    const item = itemFor(type, PAYLOADS[type]);
    const text = [findingHeadline(item, VOICE), ...findingBody(item, VOICE)].join(" ");

    expect(text).not.toMatch(/Cents\b/);
    expect(text).not.toMatch(/[a-z]+[A-Z][a-zA-Z]*:/);
  });

  it("prints money in the store currency, not integer cents", () => {
    const details = findingBody(itemFor("meta_overclaim", PAYLOADS.meta_overclaim), VOICE).join(
      " ",
    );

    // 91200 cents is $912, and the sentence must say the dollars.
    expect(details).toContain("$2,726");
    expect(details).not.toContain("272600");
  });

  it("uses the store currency it is given", () => {
    const details = findingBody(itemFor("meta_overclaim", PAYLOADS.meta_overclaim), {
      currency: "EUR",
      timeZone: "Europe/Berlin",
    }).join(" ");

    expect(details).toContain("€");
    expect(details).not.toContain("$");
  });

  it("still renders a snoozed row whose finding never fired", () => {
    const item = itemFor("sync_failure", null);

    expect(findingHeadline(item, VOICE).length).toBeGreaterThan(0);
    expect(findingBody(item, VOICE).length).toBeGreaterThan(0);
  });
});
