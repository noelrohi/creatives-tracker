import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/day";
import {
  evaluateBrokenUtmTemplate,
  evaluateMetaOverclaim,
  evaluateRoasBelowTarget,
  evaluateSyncFailure,
  evaluateUnattributedSpike,
  evaluationDayFor,
  isMuted,
  median,
  mutedUntilFrom,
  type ClaimVerifiedDay,
  type RoasDay,
  type UnattributedDay,
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

function spikeDays(shares: Array<[unattributed: number, total: number]>) {
  return shares.map(([unattributedCents, totalCents], index) => ({
    day: addDays(DAY, index - (shares.length - 1)),
    unattributedCents,
    totalCents,
  })) satisfies UnattributedDay[];
}

function roasDays(entries: Array<[revenue: number, spend: number]>): RoasDay[] {
  return entries.map(([verifiedRevenueCents, spendCents], index) => ({
    day: addDays(DAY, index - (entries.length - 1)),
    verifiedRevenueCents,
    spendCents,
  }));
}

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
    const baseline: Array<[number, number]> = Array.from({ length: 13 }, () => [
      1000, 1000,
    ]);

    expect(
      evaluateMetaOverclaim(
        claimDays([...baseline, [3000, 1000], [5000, 1000], [4000, 1000]]),
      ),
    ).toBeNull();
  });

  it("carries the firing window's own days in the payload", () => {
    const baseline: Array<[number, number]> = Array.from({ length: 14 }, () => [
      1000, 1000,
    ]);
    const finding = evaluateMetaOverclaim(
      claimDays([...baseline, [3000, 1000], [5000, 1000], [4000, 1000]]),
    );

    expect(finding?.type).toBe("meta_overclaim");
    expect(finding?.periodEnd).toBe(DAY);
    expect(finding?.payload.windowMultiple).toBe(4);
    expect(finding?.payload.baselineMultiple).toBe(1);
    expect(finding?.payload.days).toHaveLength(3);
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
    const baseline: Array<[number, number]> = Array.from({ length: 14 }, () => [
      1000, 1000,
    ]);

    expect(
      evaluateMetaOverclaim(
        claimDays([...baseline, [1, 0], [1, 0], [1, 0]]),
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
    const baseline: Array<[number, number]> = Array.from({ length: 14 }, () => [
      1000, 1000,
    ]);
    const finding = evaluateMetaOverclaim(
      claimDays([
        ...baseline,
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
  const baseline: Array<[number, number]> = Array.from({ length: 28 }, () => [
    500, 10_000,
  ]);

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
    const quiet: Array<[number, number]> = Array.from({ length: 28 }, () => [
      200, 10_000,
    ]);
    expect(
      evaluateUnattributedSpike(
        spikeDays([...quiet, [900, 10_000], [900, 10_000]]),
      ),
    ).toBeNull();
  });

  it("does not fire above 10% when the median is already that high", () => {
    const noisy: Array<[number, number]> = Array.from({ length: 28 }, () => [
      2000, 10_000,
    ]);
    expect(
      evaluateUnattributedSpike(
        spikeDays([...noisy, [3000, 10_000], [3000, 10_000]]),
      ),
    ).toBeNull();
  });

  it("uses a sparse history as the baseline", () => {
    // Only three days ever had revenue: median share is 5%.
    const sparse: Array<[number, number]> = [
      [0, 0],
      [500, 10_000],
      [400, 10_000],
      [600, 10_000],
      [0, 0],
    ];
    const finding = evaluateUnattributedSpike(
      spikeDays([...sparse, [3000, 10_000], [3000, 10_000]]),
    );

    expect(finding?.payload.baselineDays).toBe(3);
    expect(finding?.payload.baselineMedianShare).toBeCloseTo(0.05);
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
  const below: Array<[number, number]> = Array.from({ length: 7 }, () => [
    1000, 1000,
  ]);

  it("fires on seven computable days under target", () => {
    const finding = evaluateRoasBelowTarget({
      series: roasDays(below),
      target,
    });

    expect(finding?.type).toBe("roas_below_target");
    expect(finding?.periodStart).toBe("2026-07-23");
    expect(finding?.periodEnd).toBe(DAY);
    expect(finding?.payload.target).toBe(target);
  });

  it("does not fire on six days of history", () => {
    expect(
      evaluateRoasBelowTarget({ series: roasDays(below.slice(1)), target }),
    ).toBeNull();
  });

  it("breaks the streak on a zero-spend day", () => {
    const withGap: Array<[number, number]> = [...below];
    withGap[3] = [0, 0];

    expect(
      evaluateRoasBelowTarget({ series: roasDays(withGap), target }),
    ).toBeNull();
  });

  it("does not fire when one day meets target", () => {
    const withGoodDay: Array<[number, number]> = [...below];
    withGoodDay[5] = [3000, 1000];

    expect(
      evaluateRoasBelowTarget({ series: roasDays(withGoodDay), target }),
    ).toBeNull();
  });

  it("treats ROAS exactly at target as not below", () => {
    expect(
      evaluateRoasBelowTarget({
        series: roasDays(Array.from({ length: 7 }, () => [1500, 1000])),
        target,
      }),
    ).toBeNull();
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
