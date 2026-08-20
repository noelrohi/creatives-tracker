import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/day";
import {
  evaluateAdLpFunnelMismatch,
  evaluateBrokenUtmTemplate,
  evaluateMetaOverclaim,
  evaluateRoasBelowTarget,
  evaluateSyncFailure,
  evaluateUntaggedSpend,
  evaluateUnattributedSpike,
  evaluateUtmTemplateDrift,
  evaluationDayFor,
  FINDING_TYPES,
  isMuted,
  median,
  mutedUntilFrom,
  typesToRetire,
  UTM_TEMPLATE_LOCK_DATE,
  type AdLpMismatchCandidate,
  type FindingDraft,
  type FindingType,
  type ClaimVerifiedDay,
  type RoasDay,
  type UnattributedDay,
  type UtmDriftOrder,
} from "@/lib/findings";

const DAY = "2026-07-29";

function claimDays(
  entries: Array<[claimed: number | null, verified: number]>,
): ClaimVerifiedDay[] {
  return entries.map(([claimedCents, verifiedCents], index) => ({
    day: addDays(DAY, index - (entries.length - 1)),
    claimedCents,
    verifiedCents,
  }));
}

/** Days at a flat 1x, to give the overclaim rule a normal to compare against. */
function flatBaseline(
  days: number,
): Array<[claimed: number | null, verified: number]> {
  return Array.from({ length: days }, () => [1000, 1000]);
}

/** Days at one flat share, to give the spike rule a normal to compare against. */
function flatShareDays(
  days: number,
  [unattributedCents, totalCents]: [unattributed: number, total: number],
): Array<[unattributed: number, total: number]> {
  return Array.from({ length: days }, () => [unattributedCents, totalCents]);
}

function spikeDays(shares: Array<[unattributed: number, total: number]>) {
  return shares.map(([unattributedCents, totalCents], index) => ({
    day: addDays(DAY, index - (shares.length - 1)),
    unattributedCents,
    totalCents,
  })) satisfies UnattributedDay[];
}

function roasDays(
  entries: Array<[revenue: number, spend: number | null]>,
): RoasDay[] {
  return entries.map(([verifiedRevenueCents, spendCents], index) => ({
    day: addDays(DAY, index - (entries.length - 1)),
    verifiedRevenueCents,
    spendCents,
  }));
}

describe("finding types", () => {
  it("covers all eight finding enum values", () => {
    expect(FINDING_TYPES).toEqual([
      "meta_overclaim",
      "unattributed_spike",
      "broken_utm_template",
      "sync_failure",
      "roas_below_target",
      "ad_lp_funnel_mismatch",
      "untagged_spend",
      "utm_template_drift",
    ]);
  });
});

describe("day helpers", () => {
  it("walks days across a month boundary", () => {
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("evaluates yesterday in the store timezone", () => {
    // 2026-07-30T02:00Z is already the 30th in Bangkok, so yesterday is the 29th.
    expect(
      evaluationDayFor(new Date("2026-07-30T02:00:00Z"), "Asia/Bangkok"),
    ).toBe("2026-07-29");
    // Same instant is still the 29th in New York, so yesterday is the 28th.
    expect(
      evaluationDayFor(new Date("2026-07-30T02:00:00Z"), "America/New_York"),
    ).toBe("2026-07-28");
  });
});

describe("median", () => {
  it("returns null with no samples", () => {
    expect(median([])).toBeNull();
  });

  it("averages the middle pair for even counts", () => {
    expect(median([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.25);
  });

  it("takes the middle value for odd counts", () => {
    expect(median([0.5, 0.1, 0.3])).toBe(0.3);
  });
});

describe("evaluateMetaOverclaim", () => {
  it("does not fire on two over days", () => {
    expect(
      evaluateMetaOverclaim(
        claimDays([
          [1000, 900],
          [3000, 1000],
          [3000, 1000],
        ]).slice(1),
      ),
    ).toBeNull();
  });

  // A store with no history has no normal to be wide of. The rule reports a
  // widening gap, so with nothing to compare against it says nothing at all.
  it("stays quiet with no baseline history, however wide the gap", () => {
    expect(
      evaluateMetaOverclaim(
        claimDays([
          [3000, 1000],
          [5000, 1000],
          [4000, 1000],
        ]),
      ),
    ).toBeNull();
  });

  it("stays quiet until the baseline is long enough to trust", () => {
    expect(
      evaluateMetaOverclaim(
        claimDays([
          ...flatBaseline(13),
          [3000, 1000],
          [5000, 1000],
          [4000, 1000],
        ]),
      ),
    ).toBeNull();
  });

  it("carries the firing window's own days in the payload", () => {
    const finding = evaluateMetaOverclaim(
      claimDays([
        ...flatBaseline(14),
        [3000, 1000],
        [5000, 1000],
        [4000, 1000],
      ]),
    );

    expect(finding?.type).toBe("meta_overclaim");
    expect(finding?.periodStart).toBe("2026-07-27");
    expect(finding?.periodEnd).toBe(DAY);
    expect(finding?.payload.windowMultiple).toBe(4);
    expect(finding?.payload.baselineMultiple).toBe(1);
    expect(finding?.payload.days).toEqual([
      {
        day: "2026-07-27",
        claimedCents: 3000,
        verifiedCents: 1000,
        gapCents: 2000,
      },
      {
        day: "2026-07-28",
        claimedCents: 5000,
        verifiedCents: 1000,
        gapCents: 4000,
      },
      {
        day: "2026-07-29",
        claimedCents: 4000,
        verifiedCents: 1000,
        gapCents: 3000,
      },
    ]);
  });

  it("does not fire when the baseline is about the window multiple", () => {
    const baseline: Array<[number, number]> = Array.from({ length: 14 }, () => [
      3000, 1000,
    ]);

    expect(
      evaluateMetaOverclaim(
        claimDays([...baseline, [3000, 1000], [3000, 1000], [3000, 1000]]),
      ),
    ).toBeNull();
  });

  it("fires when the window is at least 1.4× the baseline", () => {
    const baseline: Array<[number, number]> = Array.from({ length: 14 }, () => [
      2100, 1000,
    ]);
    const finding = evaluateMetaOverclaim(
      claimDays([...baseline, [3000, 1000], [3000, 1000], [3000, 1000]]),
    );

    expect(finding?.payload.windowMultiple).toBe(3);
    expect(finding?.payload.baselineMultiple).toBe(2.1);
  });

  // §7.2: a Meta outage shows "no data", never $0 — an unlabeled day cannot
  // over-claim, so it breaks the streak instead of firing on a phantom zero.
  it("does not fire when a day has no claim data at all", () => {
    expect(
      evaluateMetaOverclaim(
        claimDays([
          [3000, 1000],
          [null, 1000],
          [4000, 1000],
        ]),
      ),
    ).toBeNull();
  });

  it("breaks the streak when a day sits exactly at 2×", () => {
    expect(
      evaluateMetaOverclaim(
        claimDays([
          [3000, 1000],
          [2000, 1000],
          [3000, 1000],
        ]),
      ),
    ).toBeNull();
  });

  it("counts claims against zero verified as over", () => {
    // Baseline days first, else the rule stays quiet for want of a normal.
    expect(
      evaluateMetaOverclaim(
        claimDays([...flatBaseline(14), [1, 0], [1, 0], [1, 0]]),
      ),
    ).not.toBeNull();
  });

  it("does not fire when Meta claimed nothing either", () => {
    expect(
      evaluateMetaOverclaim(
        claimDays([
          [0, 0],
          [0, 0],
          [0, 0],
        ]),
      ),
    ).toBeNull();
  });

  it("ignores days before the trailing window", () => {
    const finding = evaluateMetaOverclaim(
      claimDays([
        ...flatBaseline(14),
        [0, 5000],
        [3000, 1000],
        [3000, 1000],
        [3000, 1000],
      ]),
    );

    // The window is the last three days; the quiet day before it sets no bound.
    expect(finding?.periodStart).toBe("2026-07-27");
  });
});

describe("evaluateUnattributedSpike", () => {
  /** 28 quiet baseline days at a 5% unattributed share. */
  const baseline = flatShareDays(28, [500, 10_000]);

  it("fires when both days clear 10% and 2× the median", () => {
    const finding = evaluateUnattributedSpike(
      spikeDays([...baseline, [3000, 10_000], [4000, 10_000]]),
    );

    expect(finding?.type).toBe("unattributed_spike");
    expect(finding?.payload.baselineMedianShare).toBeCloseTo(0.05);
    expect(finding?.periodEnd).toBe(DAY);
  });

  it("does not fire when only one of the two days spikes", () => {
    expect(
      evaluateUnattributedSpike(
        spikeDays([...baseline, [500, 10_000], [4000, 10_000]]),
      ),
    ).toBeNull();
  });

  it("does not fire above the median but under 10%", () => {
    // 9% is 4.5× a 2% median, but still under the absolute floor.
    const quiet = flatShareDays(28, [200, 10_000]);
    expect(
      evaluateUnattributedSpike(
        spikeDays([...quiet, [900, 10_000], [900, 10_000]]),
      ),
    ).toBeNull();
  });

  it("does not fire above 10% when the median is already that high", () => {
    const noisy = flatShareDays(28, [2000, 10_000]);
    expect(
      evaluateUnattributedSpike(
        spikeDays([...noisy, [3000, 10_000], [3000, 10_000]]),
      ),
    ).toBeNull();
  });

  it("uses a sparse history as the baseline", () => {
    // Days with no revenue are no part of the baseline; the fourteen that could
    // be measured are, at a 5% median.
    const sparse: Array<[number, number]> = [
      [0, 0],
      ...flatShareDays(13, [500, 10_000]),
      [400, 10_000],
      [0, 0],
    ];
    const finding = evaluateUnattributedSpike(
      spikeDays([...sparse, [3000, 10_000], [3000, 10_000]]),
    );

    expect(finding?.payload.baselineDays).toBe(14);
    expect(finding?.payload.baselineMedianShare).toBeCloseTo(0.05);
  });

  // A median over a handful of days is not a habit, so the rule waits for two
  // weeks of measurable days before it calls anything unusual.
  it("stays quiet with thirteen measurable baseline days", () => {
    expect(
      evaluateUnattributedSpike(
        spikeDays([
          ...flatShareDays(13, [500, 10_000]),
          [3000, 10_000],
          [3000, 10_000],
        ]),
      ),
    ).toBeNull();
  });

  it("fires once the fourteenth measurable day lands", () => {
    const finding = evaluateUnattributedSpike(
      spikeDays([
        ...flatShareDays(14, [500, 10_000]),
        [3000, 10_000],
        [3000, 10_000],
      ]),
    );

    expect(finding?.type).toBe("unattributed_spike");
    expect(finding?.payload.baselineDays).toBe(14);
  });

  it("does not fire without any baseline at all", () => {
    expect(
      evaluateUnattributedSpike(
        spikeDays([
          [0, 0],
          [3000, 10_000],
          [3000, 10_000],
        ]),
      ),
    ).toBeNull();
  });

  it("does not fire when a day in the window has no revenue", () => {
    expect(
      evaluateUnattributedSpike(
        spikeDays([...baseline, [3000, 10_000], [0, 0]]),
      ),
    ).toBeNull();
  });
});

describe("evaluateBrokenUtmTemplate", () => {
  const sample = (index: number) => ({
    utmSource: "newsletter",
    utmMedium: "cpc",
    utmCampaign: `summer-${index}`,
  });

  it("does not fire at four orders", () => {
    expect(
      evaluateBrokenUtmTemplate({
        day: DAY,
        orderCount: 4,
        samples: [sample(1)],
      }),
    ).toBeNull();
  });

  it("fires at exactly five orders", () => {
    const finding = evaluateBrokenUtmTemplate({
      day: DAY,
      orderCount: 5,
      samples: [sample(1), sample(2)],
    });

    expect(finding?.type).toBe("broken_utm_template");
    expect(finding?.payload.orderCount).toBe(5);
    expect(finding?.periodStart).toBe(DAY);
    expect(finding?.periodEnd).toBe(DAY);
  });

  it("cites at most five samples", () => {
    const finding = evaluateBrokenUtmTemplate({
      day: DAY,
      orderCount: 40,
      samples: Array.from({ length: 9 }, (_, index) => sample(index)),
    });

    expect(finding?.payload.samples).toHaveLength(5);
  });
});

describe("evaluateSyncFailure", () => {
  const lastSuccessAt = new Date("2026-07-29T00:00:00Z");
  const now = new Date("2026-07-30T06:00:00Z");

  it("returns null when both connectors are fresh", () => {
    expect(
      evaluateSyncFailure({
        day: DAY,
        now,
        health: {
          shopify: { lastSuccessAt: now, stale: false },
          meta: { lastSuccessAt: now, stale: false },
        },
      }),
    ).toBeNull();
  });

  it("cites the stale connector and how long it has been down", () => {
    const finding = evaluateSyncFailure({
      day: DAY,
      now,
      health: {
        shopify: { lastSuccessAt, stale: true },
        meta: { lastSuccessAt: now, stale: false },
      },
    });

    expect(finding?.payload.connector).toBe("shopify");
    expect(finding?.payload.lastSuccessAt).toBe(lastSuccessAt.toISOString());
    expect(finding?.payload.hoursSinceLastSuccess).toBe(30);
  });

  it("reports a connector that has never succeeded", () => {
    const finding = evaluateSyncFailure({
      day: DAY,
      now,
      health: {
        shopify: { lastSuccessAt: now, stale: false },
        meta: { lastSuccessAt: null, stale: true },
      },
    });

    expect(finding?.payload.connector).toBe("meta");
    expect(finding?.payload.lastSuccessAt).toBeNull();
    expect(finding?.payload.hoursSinceLastSuccess).toBeNull();
  });
});

describe("evaluateRoasBelowTarget", () => {
  const target = 1.5;
  const below: Array<[number, number | null]> = Array.from({ length: 7 }, () => [
    1000, 1000,
  ]);

  it("fires on seven computable days under target", () => {
    const result = evaluateRoasBelowTarget({ series: roasDays(below), target });

    expect(result.outcome).toBe("fires");
    if (result.outcome !== "fires") throw new Error("expected a draft");
    expect(result.draft.type).toBe("roas_below_target");
    expect(result.draft.periodStart).toBe("2026-07-23");
    expect(result.draft.periodEnd).toBe(DAY);
    expect(result.draft.payload.target).toBe(target);
  });

  it("clears when one day meets target — the rule looked and it does not hold", () => {
    const withGoodDay: Array<[number, number | null]> = [...below];
    withGoodDay[5] = [3000, 1000];

    expect(
      evaluateRoasBelowTarget({ series: roasDays(withGoodDay), target }).outcome,
    ).toBe("clear");
  });

  it("treats ROAS exactly at target as not below", () => {
    expect(
      evaluateRoasBelowTarget({
        series: roasDays(Array.from({ length: 7 }, () => [1500, 1000])),
        target,
      }).outcome,
    ).toBe("clear");
  });

  /**
   * The defect this rule shipped with: a day Meta had not reported yet made
   * ROAS uncomputable, the streak read as broken, and the sweep retired a live
   * finding — reporting "resolved" off absent data while verified ROAS sat at
   * 0.67 against a 1.5 goal.
   */
  it("is indeterminate, not clear, when Meta has not reported a day", () => {
    const withMissingDay: Array<[number, number | null]> = [...below];
    withMissingDay[3] = [3652, null];

    const result = evaluateRoasBelowTarget({
      series: roasDays(withMissingDay),
      target,
    });

    expect(result.outcome).toBe("indeterminate");
    if (result.outcome !== "indeterminate") throw new Error("expected no verdict");
    expect(result.uncomputableDays).toEqual(["2026-07-26"]);
  });

  it("names every day it could not judge", () => {
    const withGap: Array<[number, number | null]> = [...below];
    withGap[4] = [100, null];
    withGap[5] = [200, null];
    withGap[6] = [300, null];

    const result = evaluateRoasBelowTarget({ series: roasDays(withGap), target });

    expect(result.outcome).toBe("indeterminate");
    if (result.outcome !== "indeterminate") throw new Error("expected no verdict");
    expect(result.uncomputableDays).toEqual(["2026-07-27", "2026-07-28", DAY]);
  });

  it("is indeterminate on a reported day with no spend — ROAS has no value there", () => {
    const withZeroSpend: Array<[number, number | null]> = [...below];
    withZeroSpend[3] = [0, 0];

    expect(
      evaluateRoasBelowTarget({ series: roasDays(withZeroSpend), target })
        .outcome,
    ).toBe("indeterminate");
  });

  it("is indeterminate on six days of history rather than clear", () => {
    expect(
      evaluateRoasBelowTarget({ series: roasDays(below.slice(1)), target })
        .outcome,
    ).toBe("indeterminate");
  });
});

describe("evaluateAdLpFunnelMismatch", () => {
  function candidate(
    overrides: Partial<AdLpMismatchCandidate> = {},
  ): AdLpMismatchCandidate {
    return {
      adId: "ad-1",
      adName: "Cold problem ad",
      adFunnelStage: "tof",
      adFunnelStageSource: "ai",
      landingPageId: "page-1",
      normalizedUrl: "reviv.com/pages/bundle-offer",
      pageFunnelStage: "bof",
      pageClassificationStatus: "suggested",
      pageClassificationSource: "ai",
      trailing7dSpend: 100,
      trailing7dRevenue: 250,
      trailing7dLandingPageViews: 400,
      ...overrides,
    };
  }

  it("fires at exactly $100 and freezes suggested AI provenance", () => {
    const finding = evaluateAdLpFunnelMismatch({
      day: DAY,
      candidates: [candidate()],
    });

    expect(finding?.type).toBe("ad_lp_funnel_mismatch");
    expect(finding?.periodStart).toBe("2026-07-23");
    expect(finding?.payload.totalCount).toBe(1);
    expect(finding?.payload.offendingAds).toEqual([candidate()]);
    expect(finding?.payload.headline).toContain("$100.00");
  });

  // The drawer prints "spend/back/land" off the frozen payload, so both extra
  // figures have to survive the trip untouched.
  it("carries back and land through to the payload untouched", () => {
    const finding = evaluateAdLpFunnelMismatch({
      day: DAY,
      candidates: [
        candidate({ trailing7dRevenue: 1234.56, trailing7dLandingPageViews: 89 }),
      ],
    });
    const offenders = finding?.payload.offendingAds as AdLpMismatchCandidate[];
    const topAd = finding?.payload.topAd as AdLpMismatchCandidate;

    expect(offenders[0].trailing7dRevenue).toBe(1234.56);
    expect(offenders[0].trailing7dLandingPageViews).toBe(89);
    expect(topAd.trailing7dRevenue).toBe(1234.56);
    expect(topAd.trailing7dLandingPageViews).toBe(89);
  });

  it("does not fire below $100", () => {
    expect(
      evaluateAdLpFunnelMismatch({
        day: DAY,
        candidates: [candidate({ trailing7dSpend: 99.99 })],
      }),
    ).toBeNull();
  });

  it("fires only for the three colder-to-hotter directions", () => {
    const stages = ["tof", "mof", "bof"] as const;
    const firingPairs: string[] = [];

    for (const adFunnelStage of stages) {
      for (const pageFunnelStage of stages) {
        const finding = evaluateAdLpFunnelMismatch({
          day: DAY,
          candidates: [candidate({ adFunnelStage, pageFunnelStage })],
        });
        if (finding) firingPairs.push(`${adFunnelStage}->${pageFunnelStage}`);
      }
    }

    expect(firingPairs).toEqual(["tof->mof", "tof->bof", "mof->bof"]);
  });

  it("orders by spend, caps at ten, and carries human provenance", () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate({
        adId: `ad-${index}`,
        adName: `Ad ${index}`,
        adFunnelStageSource: "human",
        pageClassificationStatus: "confirmed",
        pageClassificationSource: "human",
        trailing7dSpend: 100 + index,
      }),
    );
    const finding = evaluateAdLpFunnelMismatch({ day: DAY, candidates });
    const offenders = finding?.payload.offendingAds as AdLpMismatchCandidate[];

    expect(finding?.payload.totalCount).toBe(12);
    expect(offenders).toHaveLength(10);
    expect(offenders[0]).toMatchObject({
      adId: "ad-11",
      adFunnelStageSource: "human",
      pageClassificationStatus: "confirmed",
      pageClassificationSource: "human",
    });
  });
});

describe("evaluateUntaggedSpend", () => {
  it("fires above 20% and carries the coverage pause flag", () => {
    const finding = evaluateUntaggedSpend({
      day: DAY,
      rollup: {
        untaggedAdCount: 7,
        untaggedSpend: 201,
        totalActiveSpend: 1000,
      },
    });

    expect(finding?.type).toBe("untagged_spend");
    expect(finding?.payload.share).toBeCloseTo(0.201);
    expect(finding?.payload.taggedSpendMinShare).toBe(0.8);
    expect(finding?.payload.aggregateSliceAlertsPaused).toBe(true);
  });

  it("stays silent at exactly 20%", () => {
    expect(
      evaluateUntaggedSpend({
        day: DAY,
        rollup: {
          untaggedAdCount: 2,
          untaggedSpend: 200,
          totalActiveSpend: 1000,
        },
      }),
    ).toBeNull();
  });

  it("stays silent when active ads have no spend", () => {
    expect(
      evaluateUntaggedSpend({
        day: DAY,
        rollup: {
          untaggedAdCount: 3,
          untaggedSpend: 0,
          totalActiveSpend: 0,
        },
      }),
    ).toBeNull();
  });
});

describe("evaluateUtmTemplateDrift", () => {
  function order(overrides: Partial<UtmDriftOrder> = {}): UtmDriftOrder {
    return {
      adId: "ad-1",
      adName: "New ad",
      adCreatedAt: new Date(UTM_TEMPLATE_LOCK_DATE.getTime() + 1),
      metaAdId: "123456789012",
      matchMethod: "name",
      utmContent: "New ad",
      ...overrides,
    };
  }

  it("fires for exactly three name-matched orders from a post-lock ad", () => {
    const finding = evaluateUtmTemplateDrift({
      day: DAY,
      orders: [order(), order(), order()],
    });

    expect(finding?.type).toBe("utm_template_drift");
    expect(finding?.payload.orderCount).toBe(3);
    expect(finding?.payload.matchMethods).toEqual(["name"]);
    expect(finding?.payload.samples).toEqual([
      { utmContent: "New ad", count: 3 },
    ]);
  });

  it("does not fire for two orders or an ad created on the lock instant", () => {
    expect(
      evaluateUtmTemplateDrift({ day: DAY, orders: [order(), order()] }),
    ).toBeNull();
    expect(
      evaluateUtmTemplateDrift({
        day: DAY,
        orders: Array.from({ length: 3 }, () =>
          order({ adCreatedAt: UTM_TEMPLATE_LOCK_DATE }),
        ),
      }),
    ).toBeNull();
  });

  it("fires for three unmatched orders sharing one non-numeric raw value", () => {
    const finding = evaluateUtmTemplateDrift({
      day: DAY,
      orders: Array.from({ length: 3 }, () =>
        order({
          adId: null,
          adName: null,
          adCreatedAt: null,
          metaAdId: "launch-ad-v2",
          matchMethod: "unmatched",
          utmContent: "launch-ad-v2",
        }),
      ),
    });

    expect(finding?.payload.offenders).toEqual([
      {
        adId: null,
        adName: null,
        rawUtmContent: "launch-ad-v2",
        matchMethod: "unmatched",
        orderCount: 3,
      },
    ]);
  });

  it("keeps numeric unmatched values silent", () => {
    expect(
      evaluateUtmTemplateDrift({
        day: DAY,
        orders: Array.from({ length: 3 }, () =>
          order({
            adId: null,
            adName: null,
            adCreatedAt: null,
            metaAdId: "123456789012",
            matchMethod: "unmatched",
            utmContent: "123456789012",
          }),
        ),
      }),
    ).toBeNull();
  });

  it("requires three orders per offender instead of pooling unrelated UTMs", () => {
    expect(
      evaluateUtmTemplateDrift({
        day: DAY,
        orders: [
          order({ metaAdId: "bad-a", matchMethod: "unmatched" }),
          order({ metaAdId: "bad-a", matchMethod: "unmatched" }),
          order({ metaAdId: "bad-b", matchMethod: "unmatched" }),
        ],
      }),
    ).toBeNull();
  });

  it("caps utm_content samples at five", () => {
    const finding = evaluateUtmTemplateDrift({
      day: DAY,
      orders: Array.from({ length: 6 }, (_, index) =>
        order({ utmContent: `New ad variant ${index}` }),
      ),
    });

    expect(finding?.payload.samples).toHaveLength(5);
  });
});

describe("mute window", () => {
  const now = new Date("2026-07-30T00:00:00Z");

  it("mutes for exactly seven days", () => {
    expect(mutedUntilFrom(now).toISOString()).toBe("2026-08-06T00:00:00.000Z");
  });

  it("is muted inside the window and free after it", () => {
    const mutedUntil = mutedUntilFrom(now);
    expect(isMuted(mutedUntil, new Date("2026-08-05T23:59:00Z"))).toBe(true);
    expect(isMuted(mutedUntil, new Date("2026-08-06T00:00:01Z"))).toBe(false);
    expect(isMuted(null, now)).toBe(false);
  });
});

describe("typesToRetire", () => {
  const noDrafts = Object.fromEntries(
    FINDING_TYPES.map((type) => [type, null]),
  ) as Record<FindingType, FindingDraft | null>;

  const empty = new Set<FindingType>();

  it("retires a rule that was evaluated and did not fire", () => {
    expect(
      typesToRetire({ evaluated: noDrafts, muted: empty, indeterminate: empty }),
    ).toEqual(FINDING_TYPES);
  });

  it("leaves a firing rule alone", () => {
    const evaluated = {
      ...noDrafts,
      roas_below_target: {
        type: "roas_below_target",
        periodStart: "2026-07-23",
        periodEnd: DAY,
        payload: {},
      },
    } as Record<FindingType, FindingDraft | null>;

    expect(
      typesToRetire({ evaluated, muted: empty, indeterminate: empty }),
    ).not.toContain("roas_below_target");
  });

  /**
   * The second half of the retire defect: even with the rule reporting
   * "indeterminate" rather than a false negative, the sweep would still have
   * closed the finding if it treated "no draft" as "no longer holds".
   */
  it("does not retire a rule that reached no judgement", () => {
    const retired = typesToRetire({
      evaluated: noDrafts,
      muted: empty,
      indeterminate: new Set<FindingType>(["roas_below_target"]),
    });

    expect(retired).not.toContain("roas_below_target");
    expect(retired).toContain("sync_failure");
  });

  it("still leaves a muted type untouched in both directions", () => {
    expect(
      typesToRetire({
        evaluated: noDrafts,
        muted: new Set<FindingType>(["untagged_spend"]),
        indeterminate: empty,
      }),
    ).not.toContain("untagged_spend");
  });
});
