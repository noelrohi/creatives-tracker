/**
 * The findings feed: eight frozen rules, evaluated once a day per store.
 *
 * The evaluators at the top are pure — they take per-day numbers and return a
 * draft finding or null, so the thresholds are unit-testable without a DB. The
 * assembly function below is the only part that touches Postgres; focused read
 * helpers assemble each evaluator's input.
 *
 * Payloads are frozen at fire time: whatever a rule cites is stored, never
 * re-derived when the feed is read.
 */

import {
  and,
  between,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  PAID_LOOKING_MEDIUM_HINTS,
  PAID_LOOKING_MEDIUM_REGEX_SOURCE,
} from "@/lib/attribution-bucket";
import { isUntagged } from "@/lib/creative-insights-shared";
import { type FunnelStage } from "@/lib/creative-taxonomy";
import { addDays } from "@/lib/day";
import {
  computeRoas,
  EMPTY_META_VERIFIED,
  getDailyBucketSeries,
  getMetaClaimsByDay,
  getMetaVerifiedByDay,
  getRoasTarget,
  getSyncHealth,
  metaClaimsFromRow,
  type SyncHealth,
} from "@/lib/attribution-queries";
import { basePerformanceRowsOnly } from "@/lib/performance-rows";
import { deriveDayInTimezone } from "@/lib/shopify-ingest";
import { ads } from "@/schema/ad";
import { adCreatives } from "@/schema/ad-creative";
import { findingMutes, findings, findingTypeEnum } from "@/schema/finding";
import { landingPages } from "@/schema/landing-page";
import { performanceLogs } from "@/schema/performance-log";
import {
  shopifyOrders,
  shopifyRefunds,
  shopifyStores,
  shopifySyncRuns,
} from "@/schema/shopify";

/* ------------------------------------------------------------------ */
/* Thresholds (frozen — spec §8; not configurable, by decision)        */
/* ------------------------------------------------------------------ */

/**
 * Meta claiming more than 2× what Shopify verified, three days running — and
 * the gap at least 1.4× wider than the store's own baseline, so the steady
 * view-through/cross-device gap every account carries never fires on its own.
 */
export const OVERCLAIM_MULTIPLE = 2;
export const OVERCLAIM_CONSECUTIVE_DAYS = 3;
export const OVERCLAIM_BASELINE_DAYS = 28;
const OVERCLAIM_MIN_BASELINE_DAYS = 14;
const OVERCLAIM_MOVEMENT_MULTIPLE = 1.4;

/** Unattributed above 10% of the day and above 2× its own 28-day median. */
export const SPIKE_MIN_SHARE = 0.1;
export const SPIKE_MEDIAN_MULTIPLE = 2;
export const SPIKE_CONSECUTIVE_DAYS = 2;
export const SPIKE_BASELINE_DAYS = 28;
/**
 * Two weeks before a store is credited with having a normal — the same bar the
 * overclaim rule sets, for the same reason: a median over a handful of days is
 * not a habit, and calling a store unusual against one is guesswork.
 */
export const SPIKE_MIN_BASELINE_DAYS = 14;

/** Five unattributed orders in one day that carry a paid medium. */
export const BROKEN_UTM_MIN_ORDERS = 5;
export const BROKEN_UTM_SAMPLE_LIMIT = 5;

/** Verified ROAS under target for a full week of computable days. */
export const ROAS_CONSECUTIVE_DAYS = 7;

/** A classified ad needs this much trailing-seven-day spend for LP mismatch. */
export const AD_LP_MISMATCH_MIN_SPEND_7D = 100;
export const AD_LP_MISMATCH_LIST_LIMIT = 10;

/** Aggregate slice alerts unlock at the exact complement: 80% tagged spend. */
export const UNTAGGED_SPEND_MAX_SHARE = 0.2;

/**
 * The spec-assembly lock date from Intelligence v1 §4.4. Ads created after
 * this instant must use the canonical ID-form UTM template.
 */
export const UTM_TEMPLATE_LOCK_DATE = new Date("2026-08-03T00:00:00Z");
export const UTM_DRIFT_MIN_ORDERS_PER_DAY = 3;
export const UTM_DRIFT_SAMPLE_LIMIT = 5;

/** Mute is a fixed week — custom durations were explicitly rejected. */
export const MUTE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export type FindingType = (typeof findingTypeEnum.enumValues)[number];

export const FINDING_TYPES = [
  "meta_overclaim",
  "unattributed_spike",
  "broken_utm_template",
  "sync_failure",
  "roas_below_target",
  "ad_lp_funnel_mismatch",
  "untagged_spend",
  "utm_template_drift",
] as const satisfies readonly FindingType[];

export type FindingDraft = {
  type: FindingType;
  periodStart: string;
  periodEnd: string;
  payload: Record<string, unknown>;
};

/* ------------------------------------------------------------------ */
/* Pure day + statistics helpers                                       */
/* ------------------------------------------------------------------ */

/** The last complete day in the store's timezone. */
export function evaluationDayFor(now: Date, ianaTimezone: string): string {
  return addDays(deriveDayInTimezone(now, ianaTimezone), -1);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Mute windows are compared, never computed, at read time. */
export function isMuted(mutedUntil: Date | null | undefined, now: Date) {
  if (!mutedUntil) return false;
  return mutedUntil.getTime() > now.getTime();
}

export function mutedUntilFrom(now: Date): Date {
  return new Date(now.getTime() + MUTE_DURATION_MS);
}

/**
 * The trailing `length` entries, or null when history is short. Streak rules
 * only ever look at the window ending on the evaluation day, so a partial
 * window never fires.
 */
function trailingWindow<T>(series: T[], length: number): T[] | null {
  if (series.length < length) return null;
  return series.slice(-length);
}

/* ------------------------------------------------------------------ */
/* Rule 1 — meta_overclaim                                             */
/* ------------------------------------------------------------------ */

export type ClaimVerifiedDay = {
  day: string;
  /** Null when Meta sent no labeled claim for the day — nothing to compare. */
  claimedCents: number | null;
  verifiedCents: number;
  /**
   * Null once Meta has reported no rows at all for the day. This is the only
   * field that separates "Meta says you claimed nothing" from "Meta has not
   * told us yet" — `claimedCents` reads null for both, and treating the second
   * as the first is how a rule ends up judging a day it never saw.
   */
  spendCents: number | null;
};

/** Claimed with nothing verified is the worst case, so it counts as over. */
export function isOverclaimDay(day: ClaimVerifiedDay): boolean {
  if (day.claimedCents === null || day.claimedCents <= 0) return false;
  return day.claimedCents > OVERCLAIM_MULTIPLE * day.verifiedCents;
}

/**
 * Days in an already-sliced overclaim window that Meta has not reported.
 *
 * The signal is `spendCents`, not `claimedCents`. Meta reporting real spend and
 * zero claimed revenue is an answer — no claim cannot overclaim — while Meta
 * not having reported the day at all is the absence of one, and `claimedCents`
 * reads null for both. Deliberately narrower than the ROAS rule's hole: a day
 * of genuine zero spend is uncomputable for a ratio but perfectly judgeable
 * here, and widening it would leave open findings standing on quiet days.
 */
export function overclaimUncomputableDays(
  window: readonly ClaimVerifiedDay[],
): string[] {
  return window
    .filter((day) => day.spendCents === null)
    .map((day) => day.day);
}

/**
 * Three outcomes, for the same reason `roas_below_target` has three: a day Meta
 * has not reported is not an overclaim-free day. `isOverclaimDay` reads false
 * for it either way, so folding it into "clear" retires a live finding on the
 * strength of data that never arrived.
 */
export type MetaOverclaimEvaluation =
  | { outcome: "fires"; draft: FindingDraft }
  | { outcome: "clear" }
  | { outcome: "indeterminate"; uncomputableDays: string[] };

export function evaluateMetaOverclaim(
  series: ClaimVerifiedDay[],
): MetaOverclaimEvaluation {
  const window = trailingWindow(series, OVERCLAIM_CONSECUTIVE_DAYS);
  // No window at all. The empty list says "could not judge, but not because any
  // particular day is absent".
  if (!window) return { outcome: "indeterminate", uncomputableDays: [] };

  const uncomputableDays = overclaimUncomputableDays(window);
  if (uncomputableDays.length > 0) {
    return { outcome: "indeterminate", uncomputableDays };
  }

  if (!window.every(isOverclaimDay)) return { outcome: "clear" };

  const multipleFor = (days: ClaimVerifiedDay[]): number | null => {
    const verifiedCents = days.reduce(
      (total, day) => total + day.verifiedCents,
      0,
    );
    if (verifiedCents === 0) return null;
    const claimedCents = days.reduce(
      (total, day) => total + (day.claimedCents ?? 0),
      0,
    );
    return claimedCents / verifiedCents;
  };
  const roundMultiple = (value: number | null) =>
    value === null ? null : Math.round(value * 10) / 10;

  const windowMultipleRaw = multipleFor(window);
  const baselineDays = series
    .slice(0, -OVERCLAIM_CONSECUTIVE_DAYS)
    .filter(
      (day) =>
        day.claimedCents !== null &&
        day.claimedCents > 0 &&
        day.verifiedCents > 0,
    );
  const baselineMultipleRaw =
    baselineDays.length < OVERCLAIM_MIN_BASELINE_DAYS
      ? null
      : multipleFor(baselineDays);

  // The rule reports movement, so it stays quiet until it can see movement. A
  // store with too little history has no normal to be wide of, and firing on
  // size alone would greet every new store with a critical alert for a gap that
  // may be entirely ordinary for it. This is "clear", not "indeterminate": the
  // window's days are all present and judged, and the missing baseline is a
  // reason to say nothing rather than a reason to distrust the silence.
  if (baselineMultipleRaw === null) return { outcome: "clear" };

  const movedWider =
    windowMultipleRaw === null ||
    windowMultipleRaw >= OVERCLAIM_MOVEMENT_MULTIPLE * baselineMultipleRaw;
  if (!movedWider) return { outcome: "clear" };

  const draft: FindingDraft = {
    type: "meta_overclaim",
    periodStart: window[0].day,
    periodEnd: window[window.length - 1].day,
    payload: {
      multiple: OVERCLAIM_MULTIPLE,
      consecutiveDays: OVERCLAIM_CONSECUTIVE_DAYS,
      windowMultiple: roundMultiple(windowMultipleRaw),
      baselineMultiple: roundMultiple(baselineMultipleRaw),
      // Every day in a firing window is an overclaim day, so it has a claim.
      days: window.map((day) => ({
        day: day.day,
        claimedCents: day.claimedCents,
        verifiedCents: day.verifiedCents,
        gapCents: (day.claimedCents ?? 0) - day.verifiedCents,
      })),
    },
  };

  return { outcome: "fires", draft };
}

/* ------------------------------------------------------------------ */
/* Rule 2 — unattributed_spike                                         */
/* ------------------------------------------------------------------ */

export type UnattributedDay = {
  day: string;
  unattributedCents: number;
  totalCents: number;
};

/** A day with no revenue has no share — not a zero. */
export function unattributedShare(day: UnattributedDay): number | null {
  if (day.totalCents <= 0) return null;
  return day.unattributedCents / day.totalCents;
}

export function evaluateUnattributedSpike(
  series: UnattributedDay[],
): FindingDraft | null {
  const window = trailingWindow(series, SPIKE_CONSECUTIVE_DAYS);
  if (!window) return null;

  const baseline = series
    .slice(0, series.length - SPIKE_CONSECUTIVE_DAYS)
    .slice(-SPIKE_BASELINE_DAYS);
  const baselineShares = baseline
    .map(unattributedShare)
    .filter((share): share is number => share !== null);
  // Qualifying days, not calendar days: a day with no revenue has no share, so
  // fourteen here means fourteen days that could actually be measured.
  if (baselineShares.length < SPIKE_MIN_BASELINE_DAYS) return null;
  const baselineMedian = median(baselineShares);
  if (baselineMedian === null) return null;

  const shares = window.map(unattributedShare);
  if (shares.some((share) => share === null)) return null;

  const overBoth = shares.every(
    (share) =>
      share !== null &&
      share > SPIKE_MIN_SHARE &&
      share > SPIKE_MEDIAN_MULTIPLE * baselineMedian,
  );
  if (!overBoth) return null;

  return {
    type: "unattributed_spike",
    periodStart: window[0].day,
    periodEnd: window[window.length - 1].day,
    payload: {
      minShare: SPIKE_MIN_SHARE,
      medianMultiple: SPIKE_MEDIAN_MULTIPLE,
      baselineDays: baselineShares.length,
      baselineMedianShare: baselineMedian,
      days: window.map((day, index) => ({
        day: day.day,
        share: shares[index],
        unattributedCents: day.unattributedCents,
        totalCents: day.totalCents,
      })),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rule 3 — broken_utm_template                                        */
/* ------------------------------------------------------------------ */

export type UtmTriple = {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
};

export function evaluateBrokenUtmTemplate(params: {
  day: string;
  orderCount: number;
  samples: UtmTriple[];
}): FindingDraft | null {
  if (params.orderCount < BROKEN_UTM_MIN_ORDERS) return null;

  return {
    type: "broken_utm_template",
    periodStart: params.day,
    periodEnd: params.day,
    payload: {
      threshold: BROKEN_UTM_MIN_ORDERS,
      day: params.day,
      orderCount: params.orderCount,
      paidMediums: [...PAID_LOOKING_MEDIUM_HINTS],
      samples: params.samples.slice(0, BROKEN_UTM_SAMPLE_LIMIT),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rule 4 — sync_failure                                               */
/* ------------------------------------------------------------------ */

export type SyncConnector = "shopify" | "meta";

function hoursSince(lastSuccessAt: Date | null, now: Date): number | null {
  if (!lastSuccessAt) return null;
  return (now.getTime() - lastSuccessAt.getTime()) / (60 * 60 * 1000);
}

export function evaluateSyncFailure(params: {
  health: SyncHealth;
  day: string;
  now: Date;
}): FindingDraft | null {
  const stale = (["shopify", "meta"] as const)
    .filter((connector) => params.health[connector].stale)
    .map((connector) => ({
      connector,
      lastSuccessAt:
        params.health[connector].lastSuccessAt?.toISOString() ?? null,
      hoursSinceLastSuccess: hoursSince(
        params.health[connector].lastSuccessAt,
        params.now,
      ),
    }));

  if (stale.length === 0) return null;

  return {
    type: "sync_failure",
    periodStart: params.day,
    periodEnd: params.day,
    payload: {
      // `connector` is the one a re-run acts on; `connectors` is the full list.
      connector: stale[0].connector,
      connectors: stale,
      lastSuccessAt: stale[0].lastSuccessAt,
      hoursSinceLastSuccess: stale[0].hoursSinceLastSuccess,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rule 5 — roas_below_target                                          */
/* ------------------------------------------------------------------ */

export type RoasDay = {
  day: string;
  verifiedRevenueCents: number;
  /**
   * Null when Meta has reported nothing for the day. Distinct from 0, which is
   * a real day on which nothing was spent — the rule may conclude from the
   * second and must not conclude from the first.
   */
  spendCents: number | null;
};

/**
 * Three outcomes, not two. "Fires" and "clear" are both judgements the rule
 * reached; "indeterminate" is the absence of one, and the sweep must not let it
 * retire an open finding. Meta reports a day two days late as a matter of
 * course, so a window that reaches into that lag is the normal case, not an
 * edge case.
 */
export type RoasEvaluation =
  | { outcome: "fires"; draft: FindingDraft }
  | { outcome: "clear" }
  | { outcome: "indeterminate"; uncomputableDays: string[] };

/**
 * Days in an already-sliced ROAS window with no computable ratio.
 *
 * Wider than the overclaim rule's hole by design, and for a different reason at
 * each end: a day Meta has not reported has no spend to divide by, and a day of
 * genuine zero spend has no ratio either. Both leave the streak unjudgeable,
 * which is the only question this answers.
 */
export function roasUncomputableDays(window: readonly RoasDay[]): string[] {
  return window
    .filter(
      (day) =>
        day.spendCents === null ||
        computeRoas(day.verifiedRevenueCents, day.spendCents) === null,
    )
    .map((day) => day.day);
}

export function evaluateRoasBelowTarget(params: {
  series: RoasDay[];
  target: number;
}): RoasEvaluation {
  const window = trailingWindow(params.series, ROAS_CONSECUTIVE_DAYS);
  // Too little history to have an opinion either way.
  if (!window) return { outcome: "indeterminate", uncomputableDays: [] };

  // A day Meta has not reported is not a day the rule can judge. Calling it a
  // broken streak would read "ROAS recovered" off missing data — the mistake
  // that retired a live finding while verified ROAS sat at 0.67 of a 1.5 goal.
  const uncomputableDays = roasUncomputableDays(window);
  if (uncomputableDays.length > 0) {
    return { outcome: "indeterminate", uncomputableDays };
  }

  const points = window.map((day) => ({
    day: day.day,
    roas:
      day.spendCents === null
        ? null
        : computeRoas(day.verifiedRevenueCents, day.spendCents),
    verifiedRevenueCents: day.verifiedRevenueCents,
    spendCents: day.spendCents,
  }));

  const belowAllWeek = points.every(
    (point) => point.roas !== null && point.roas < params.target,
  );
  if (!belowAllWeek) return { outcome: "clear" };

  return {
    outcome: "fires",
    draft: {
      type: "roas_below_target",
      periodStart: window[0].day,
      periodEnd: window[window.length - 1].day,
      payload: {
        target: params.target,
        consecutiveDays: ROAS_CONSECUTIVE_DAYS,
        days: points,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rule 6 — ad_lp_funnel_mismatch                                      */
/* ------------------------------------------------------------------ */

export type AdLpMismatchCandidate = {
  adId: string;
  adName: string;
  adFunnelStage: FunnelStage;
  adFunnelStageSource: string | null;
  landingPageId: string;
  normalizedUrl: string;
  pageFunnelStage: FunnelStage;
  pageClassificationStatus: "suggested" | "confirmed" | "stale" | null;
  pageClassificationSource: string | null;
  trailing7dSpend: number;
  /** Net Meta-bucket revenue attributed to the ad over the same window, in dollars. */
  trailing7dRevenue: number;
  /** Meta-reported landing page views over the same window. */
  trailing7dLandingPageViews: number;
};

const FUNNEL_STAGE_RANK: Record<FunnelStage, number> = {
  tof: 0,
  mof: 1,
  bof: 2,
};

const FUNNEL_STAGE_LABEL: Record<FunnelStage, string> = {
  tof: "top-of-funnel",
  mof: "middle-of-funnel",
  bof: "bottom-of-funnel",
};

export function evaluateAdLpFunnelMismatch(params: {
  day: string;
  candidates: AdLpMismatchCandidate[];
}): FindingDraft | null {
  const offendingAds = params.candidates
    .filter(
      (candidate) =>
        candidate.trailing7dSpend >= AD_LP_MISMATCH_MIN_SPEND_7D &&
        FUNNEL_STAGE_RANK[candidate.adFunnelStage] <
          FUNNEL_STAGE_RANK[candidate.pageFunnelStage],
    )
    .sort((a, b) => b.trailing7dSpend - a.trailing7dSpend);

  if (offendingAds.length === 0) return null;

  const topAd = offendingAds[0];
  return {
    type: "ad_lp_funnel_mismatch",
    periodStart: addDays(params.day, -6),
    periodEnd: params.day,
    payload: {
      minSpend7d: AD_LP_MISMATCH_MIN_SPEND_7D,
      totalCount: offendingAds.length,
      headline: `You spent $${topAd.trailing7dSpend.toFixed(2)} this week sending ${FUNNEL_STAGE_LABEL[topAd.adFunnelStage]} traffic to a ${FUNNEL_STAGE_LABEL[topAd.pageFunnelStage]} page.`,
      topAd,
      offendingAds: offendingAds.slice(0, AD_LP_MISMATCH_LIST_LIMIT),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rule 7 — untagged_spend                                             */
/* ------------------------------------------------------------------ */

export type UntaggedSpendRollup = {
  untaggedAdCount: number;
  untaggedSpend: number;
  totalActiveSpend: number;
};

export function evaluateUntaggedSpend(params: {
  day: string;
  rollup: UntaggedSpendRollup;
}): FindingDraft | null {
  if (params.rollup.totalActiveSpend <= 0) return null;

  const share = params.rollup.untaggedSpend / params.rollup.totalActiveSpend;
  if (share <= UNTAGGED_SPEND_MAX_SHARE) return null;

  return {
    type: "untagged_spend",
    periodStart: addDays(params.day, -6),
    periodEnd: params.day,
    payload: {
      untaggedAdCount: params.rollup.untaggedAdCount,
      untaggedSpend: params.rollup.untaggedSpend,
      totalActiveSpend: params.rollup.totalActiveSpend,
      share,
      taggedSpendMinShare: 1 - UNTAGGED_SPEND_MAX_SHARE,
      aggregateSliceAlertsPaused: true,
      headline: `${params.rollup.untaggedAdCount} active ads are untagged — $${params.rollup.untaggedSpend.toFixed(2)}/wk of spend is invisible.`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rule 8 — utm_template_drift                                         */
/* ------------------------------------------------------------------ */

export type UtmDriftOrder = {
  adId: string | null;
  adName: string | null;
  adCreatedAt: Date | null;
  metaAdId: string | null;
  matchMethod: "id" | "name" | "unmatched" | null;
  utmContent: string | null;
};

type UtmDriftOffender = {
  adId: string | null;
  adName: string | null;
  rawUtmContent: string | null;
  matchMethod: "name" | "unmatched";
  orderCount: number;
};

function isNumericUtmContent(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

export function evaluateUtmTemplateDrift(params: {
  day: string;
  orders: UtmDriftOrder[];
}): FindingDraft | null {
  const eligible = params.orders.filter((order) => {
    if (order.matchMethod === "name") {
      return (
        order.adCreatedAt !== null &&
        order.adCreatedAt.getTime() > UTM_TEMPLATE_LOCK_DATE.getTime()
      );
    }
    return (
      order.matchMethod === "unmatched" &&
      order.metaAdId !== null &&
      !isNumericUtmContent(order.metaAdId)
    );
  });

  const grouped = new Map<
    string,
    { offender: Omit<UtmDriftOffender, "orderCount">; orders: UtmDriftOrder[] }
  >();
  for (const order of eligible) {
    if (order.matchMethod !== "name" && order.matchMethod !== "unmatched") {
      continue;
    }
    const matchMethod = order.matchMethod;
    const key =
      matchMethod === "name"
        ? `name:${order.adId ?? order.adName ?? order.metaAdId ?? "unknown"}`
        : `unmatched:${order.metaAdId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.orders.push(order);
      continue;
    }
    grouped.set(key, {
      offender: {
        adId: matchMethod === "name" ? order.adId : null,
        adName: matchMethod === "name" ? order.adName : null,
        rawUtmContent: matchMethod === "unmatched" ? order.metaAdId : null,
        matchMethod,
      },
      orders: [order],
    });
  }

  const firingGroups = [...grouped.values()]
    .filter((group) => group.orders.length >= UTM_DRIFT_MIN_ORDERS_PER_DAY)
    .sort((a, b) => b.orders.length - a.orders.length);
  if (firingGroups.length === 0) return null;

  const offenders: UtmDriftOffender[] = firingGroups.map((group) => ({
    ...group.offender,
    orderCount: group.orders.length,
  }));
  const orderCount = offenders.reduce(
    (total, offender) => total + offender.orderCount,
    0,
  );
  const sampleCounts = new Map<string, number>();
  for (const group of firingGroups) {
    for (const order of group.orders) {
      const sample = order.utmContent ?? order.metaAdId;
      if (!sample) continue;
      sampleCounts.set(sample, (sampleCounts.get(sample) ?? 0) + 1);
    }
  }
  const samples = [...sampleCounts.entries()]
    .map(([utmContent, count]) => ({ utmContent, count }))
    .sort(
      (a, b) => b.count - a.count || a.utmContent.localeCompare(b.utmContent),
    )
    .slice(0, UTM_DRIFT_SAMPLE_LIMIT);

  return {
    type: "utm_template_drift",
    periodStart: params.day,
    periodEnd: params.day,
    payload: {
      threshold: UTM_DRIFT_MIN_ORDERS_PER_DAY,
      day: params.day,
      orderCount,
      headline: `A new ad is sending non-standard UTMs — ${orderCount} orders yesterday.`,
      offenders,
      matchMethods: [
        ...new Set(offenders.map((offender) => offender.matchMethod)),
      ],
      samples,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Reads that back the evaluators                                      */
/* ------------------------------------------------------------------ */

type StoreRow = {
  id: string;
  organizationId: string;
  ianaTimezone: string;
};

async function getStoreById(params: {
  organizationId: string;
  storeId: string;
}): Promise<StoreRow | null> {
  const [store] = await db
    .select({
      id: shopifyStores.id,
      organizationId: shopifyStores.organizationId,
      ianaTimezone: shopifyStores.ianaTimezone,
    })
    .from(shopifyStores)
    .where(
      and(
        eq(shopifyStores.id, params.storeId),
        eq(shopifyStores.organizationId, params.organizationId),
      ),
    )
    .limit(1);

  return store ?? null;
}

export type FirstSyncState = {
  hasCompletedBackfill: boolean;
  hasAnySuccessfulSync: boolean;
};

/** Nothing fires against a store that has never finished its first sync. */
export async function getFirstSyncState(params: {
  organizationId: string;
  storeId: string;
}): Promise<FirstSyncState> {
  const rows = await db
    .selectDistinct({ phase: shopifySyncRuns.phase })
    .from(shopifySyncRuns)
    .where(
      and(
        eq(shopifySyncRuns.organizationId, params.organizationId),
        eq(shopifySyncRuns.storeId, params.storeId),
        eq(shopifySyncRuns.result, "success"),
      ),
    );

  const phases = new Set(rows.map((row) => row.phase));

  return {
    hasCompletedBackfill: phases.has("backfill"),
    hasAnySuccessfulSync: phases.has("backfill") || phases.has("incremental"),
  };
}

/**
 * The one query this module owns: unattributed orders on the evaluation day
 * whose medium *looks* paid — "5+ orders in one day with paid-looking UTMs
 * matching no rule" (§8 rule 3). Paid-looking is deliberately wider than the
 * paid-medium gate: `paid-social` and `facebook_ads` are exactly the mistags
 * this rule exists to catch, and the bucket rule files them as unattributed.
 */
async function getBrokenUtmOrders(params: {
  organizationId: string;
  storeId: string;
  day: string;
}): Promise<{ orderCount: number; samples: UtmTriple[] }> {
  const where = and(
    eq(shopifyOrders.organizationId, params.organizationId),
    eq(shopifyOrders.storeId, params.storeId),
    eq(shopifyOrders.orderDay, params.day),
    eq(shopifyOrders.bucket, "unattributed"),
    sql`lower(${shopifyOrders.lastClickUtmMedium}) ~ ${PAID_LOOKING_MEDIUM_REGEX_SOURCE}`,
  );

  const [[countRow], samples] = await Promise.all([
    db
      .select({ orderCount: sql<number>`count(*)::int` })
      .from(shopifyOrders)
      .where(where),

    db
      .select({
        utmSource: shopifyOrders.lastClickUtmSource,
        utmMedium: shopifyOrders.lastClickUtmMedium,
        utmCampaign: shopifyOrders.lastClickUtmCampaign,
      })
      .from(shopifyOrders)
      .where(where)
      .orderBy(desc(shopifyOrders.orderCreatedAt))
      .limit(BROKEN_UTM_SAMPLE_LIMIT),
  ]);

  return { orderCount: countRow?.orderCount ?? 0, samples };
}

/**
 * What the ad brought back over the same trailing week, per ad: Meta-bucket
 * orders whose ad we resolved (`id` or `name` — an `unmatched` row names no ad),
 * netted of refunds exactly the way `getMetaVerified` nets verified revenue.
 * Amounts stay in dollars, the unit `trailing7dSpend` is already in.
 */
async function getAdRevenueByAdId(params: {
  organizationId: string;
  storeId: string;
  day: string;
}): Promise<Map<string, number>> {
  const from = addDays(params.day, -6);
  const adJoin = and(
    eq(ads.organizationId, params.organizationId),
    inArray(shopifyOrders.metaAdMatchMethod, ["id", "name"]),
    sql`lower(${ads.metaId}) = ${shopifyOrders.metaAdId}`,
  );
  const metaOrders = and(
    eq(shopifyOrders.organizationId, params.organizationId),
    eq(shopifyOrders.storeId, params.storeId),
    eq(shopifyOrders.bucket, "meta"),
  );

  const [orderRows, refundRows] = await Promise.all([
    db
      .select({
        adId: ads.id,
        gross: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
      })
      .from(shopifyOrders)
      .innerJoin(ads, adJoin)
      .where(and(metaOrders, between(shopifyOrders.orderDay, from, params.day)))
      .groupBy(ads.id),

    // Refunds land on the day the money went back, so they carry their own
    // range — the same rule the attribution ledger uses.
    db
      .select({
        adId: ads.id,
        refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      })
      .from(shopifyRefunds)
      .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyRefunds.orderId))
      .innerJoin(ads, adJoin)
      .where(
        and(
          metaOrders,
          eq(shopifyRefunds.organizationId, params.organizationId),
          eq(shopifyRefunds.storeId, params.storeId),
          between(shopifyRefunds.refundDay, from, params.day),
        ),
      )
      .groupBy(ads.id),
  ]);

  const revenue = new Map<string, number>();
  for (const row of orderRows) {
    revenue.set(row.adId, Number(row.gross));
  }
  for (const row of refundRows) {
    revenue.set(row.adId, (revenue.get(row.adId) ?? 0) - Number(row.refunded));
  }
  return revenue;
}

async function getAdLpMismatchCandidates(params: {
  organizationId: string;
  storeId: string;
  day: string;
}): Promise<AdLpMismatchCandidate[]> {
  const [rows, revenueByAd] = await Promise.all([
    db
      .select({
        adId: ads.id,
        adName: ads.name,
        adFunnelStage: sql<FunnelStage>`${ads.funnelStage}`,
        adFunnelStageSource: ads.funnelStageSource,
        landingPageId: landingPages.id,
        normalizedUrl: landingPages.normalizedUrl,
        pageFunnelStage: sql<FunnelStage>`${landingPages.funnelStage}`,
        pageClassificationStatus: landingPages.classificationStatus,
        pageClassificationSource: landingPages.classificationSource,
        trailing7dSpend: sql<string>`coalesce(sum(${performanceLogs.spend}), 0)`,
        // The land side of "spend/back/land": the same base rows the spend sum
        // is taken over, so the two can never disagree about the window.
        trailing7dLandingPageViews: sql<number>`coalesce(sum(${performanceLogs.landingPageViews}), 0)::int`,
      })
      .from(ads)
      .innerJoin(landingPages, eq(ads.landingPageId, landingPages.id))
      .innerJoin(performanceLogs, eq(performanceLogs.adId, ads.id))
      .where(
        and(
          eq(ads.organizationId, params.organizationId),
          eq(landingPages.organizationId, params.organizationId),
          eq(performanceLogs.organizationId, params.organizationId),
          isNotNull(ads.funnelStage),
          isNotNull(landingPages.funnelStage),
          between(
            performanceLogs.dateStart,
            addDays(params.day, -6),
            params.day,
          ),
          basePerformanceRowsOnly(),
        ),
      )
      .groupBy(
        ads.id,
        ads.name,
        ads.funnelStage,
        ads.funnelStageSource,
        landingPages.id,
        landingPages.normalizedUrl,
        landingPages.funnelStage,
        landingPages.classificationStatus,
        landingPages.classificationSource,
      ),

    getAdRevenueByAdId(params),
  ]);

  return rows.map((row) => ({
    ...row,
    trailing7dSpend: Number(row.trailing7dSpend),
    trailing7dRevenue: revenueByAd.get(row.adId) ?? 0,
  }));
}

async function getUntaggedSpendRollup(params: {
  organizationId: string;
  day: string;
}): Promise<UntaggedSpendRollup> {
  const rows = await db
    .select({
      funnelStage: ads.funnelStage,
      creativeId: adCreatives.id,
      persona: adCreatives.persona,
      angle: adCreatives.angle,
      awarenessLevel: adCreatives.awarenessLevel,
      spend: sql<string>`coalesce(sum(${performanceLogs.spend}), 0)`,
    })
    .from(ads)
    .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
    .leftJoin(
      performanceLogs,
      and(
        eq(performanceLogs.adId, ads.id),
        eq(performanceLogs.organizationId, params.organizationId),
        between(performanceLogs.dateStart, addDays(params.day, -6), params.day),
        basePerformanceRowsOnly(),
      ),
    )
    .where(
      and(
        eq(ads.organizationId, params.organizationId),
        eq(ads.status, "active"),
        isNotNull(ads.metaId),
      ),
    )
    .groupBy(
      ads.id,
      ads.funnelStage,
      adCreatives.id,
      adCreatives.persona,
      adCreatives.angle,
      adCreatives.awarenessLevel,
    );

  return rows.reduce<UntaggedSpendRollup>(
    (rollup, row) => {
      const spend = Number(row.spend);
      rollup.totalActiveSpend += spend;
      // One definition of "tagged" for the whole app (§6.4).
      if (isUntagged(row)) {
        rollup.untaggedAdCount += 1;
        rollup.untaggedSpend += spend;
      }
      return rollup;
    },
    { untaggedAdCount: 0, untaggedSpend: 0, totalActiveSpend: 0 },
  );
}

async function getUtmDriftOrders(params: {
  organizationId: string;
  storeId: string;
  day: string;
}): Promise<UtmDriftOrder[]> {
  const utmContent = sql<
    string | null
  >`${shopifyOrders.customerJourney}->'lastVisit'->'utmParameters'->>'content'`;

  return db
    .select({
      adId: ads.id,
      adName: ads.name,
      adCreatedAt: ads.createdAt,
      metaAdId: shopifyOrders.metaAdId,
      matchMethod: shopifyOrders.metaAdMatchMethod,
      utmContent,
    })
    .from(shopifyOrders)
    .leftJoin(
      ads,
      and(
        eq(ads.organizationId, params.organizationId),
        eq(ads.metaId, shopifyOrders.metaAdId),
      ),
    )
    .where(
      and(
        eq(shopifyOrders.organizationId, params.organizationId),
        eq(shopifyOrders.storeId, params.storeId),
        eq(shopifyOrders.orderDay, params.day),
        or(
          and(
            eq(shopifyOrders.metaAdMatchMethod, "name"),
            gt(ads.createdAt, UTM_TEMPLATE_LOCK_DATE),
          ),
          and(
            eq(shopifyOrders.metaAdMatchMethod, "unmatched"),
            isNotNull(shopifyOrders.metaAdId),
            sql`${shopifyOrders.metaAdId} !~ '^[0-9]+$'`,
          ),
        ),
      ),
    );
}

/**
 * Per-day Meta claims + Shopify-verified revenue, in the order the days were
 * asked for.
 *
 * Two grouped reads over the whole span rather than a claims + verified pair
 * per day: the loop this replaced issued fourteen queries for a seven-day
 * window against a pool of ten, so it landed in two waves. A day the grouped
 * reads return nothing for is read back through the same helpers the per-day
 * functions end in, so an absent day answers exactly as an empty range did.
 */
async function getClaimVerifiedSeries(params: {
  organizationId: string;
  storeId: string;
  days: string[];
}) {
  if (params.days.length === 0) return [];

  const ordered = [...params.days].sort();
  const dateFrom = ordered[0];
  const dateTo = ordered[ordered.length - 1];

  const [claimsByDay, verifiedByDay] = await Promise.all([
    getMetaClaimsByDay({ organizationId: params.organizationId, dateFrom, dateTo }),
    getMetaVerifiedByDay({
      organizationId: params.organizationId,
      storeId: params.storeId,
      dateFrom,
      dateTo,
    }),
  ]);

  return params.days.map((day) => {
    const claims = claimsByDay.get(day) ?? metaClaimsFromRow(undefined);
    const verified = verifiedByDay.get(day) ?? EMPTY_META_VERIFIED;

    return {
      day,
      claimedCents: claims.claimedCents,
      // Null once Meta has reported nothing for the day: `spendCents` reads 0
      // either way, and only the row count tells the two apart.
      spendCents: claims.spendRowCount > 0 ? claims.spendCents : null,
      verifiedCents: verified.verifiedRevenueCents,
    };
  });
}

function daysEndingOn(lastDay: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    addDays(lastDay, index - (count - 1)),
  );
}

async function getActiveMutedTypes(params: {
  organizationId: string;
  now: Date;
}): Promise<Set<FindingType>> {
  const rows = await db
    .select({ type: findingMutes.type })
    .from(findingMutes)
    .where(
      and(
        eq(findingMutes.organizationId, params.organizationId),
        gt(findingMutes.mutedUntil, params.now),
      ),
    );

  return new Set(rows.map((row) => row.type));
}

/* ------------------------------------------------------------------ */
/* Evaluate + persist                                                  */
/* ------------------------------------------------------------------ */

export type FindingsRunSummary = {
  fired: FindingType[];
  refreshed: FindingType[];
  resolved: FindingType[];
  skippedMuted: FindingType[];
  /** Rules the run could not judge, whose open findings were left standing. */
  indeterminate: FindingType[];
};

/**
 * Which open findings this run may take back.
 *
 * A finding that no longer holds is not news the reader still has to dismiss,
 * so a rule that stopped firing retires its own alert. Two things are never
 * retired: a muted type, because a mute means "don't touch this type" rather
 * than "don't raise it"; and a rule that reached no judgement this run, because
 * "we could not tell" is not "the problem went away" — retiring on it closes a
 * live alert on missing data and files the closure as a resolution.
 */
export function typesToRetire(params: {
  evaluated: Record<FindingType, FindingDraft | null>;
  muted: ReadonlySet<FindingType>;
  indeterminate: ReadonlySet<FindingType>;
}): FindingType[] {
  return FINDING_TYPES.filter(
    (type) =>
      params.evaluated[type] === null &&
      !params.muted.has(type) &&
      !params.indeterminate.has(type),
  );
}

export async function evaluateFindingsForStore(params: {
  organizationId: string;
  storeId: string;
  now?: Date;
}): Promise<FindingsRunSummary> {
  const now = params.now ?? new Date();
  const summary: FindingsRunSummary = {
    fired: [],
    refreshed: [],
    resolved: [],
    skippedMuted: [],
    indeterminate: [],
  };

  const store = await getStoreById(params);
  if (!store) return summary;

  const day = evaluationDayFor(now, store.ianaTimezone);
  const claimDays = daysEndingOn(
    day,
    OVERCLAIM_CONSECUTIVE_DAYS + OVERCLAIM_BASELINE_DAYS,
  );
  const bucketFrom = addDays(
    day,
    -(SPIKE_BASELINE_DAYS + SPIKE_CONSECUTIVE_DAYS - 1),
  );

  const [
    claimVerified,
    bucketSeries,
    brokenUtm,
    mismatchCandidates,
    untaggedSpend,
    utmDriftOrders,
    health,
    roasTarget,
    mutedTypes,
  ] = await Promise.all([
    getClaimVerifiedSeries({ ...params, days: claimDays }),
    getDailyBucketSeries({
      organizationId: params.organizationId,
      storeId: params.storeId,
      dateFrom: bucketFrom,
      dateTo: day,
    }),
    getBrokenUtmOrders({ ...params, day }),
    getAdLpMismatchCandidates({
      organizationId: params.organizationId,
      storeId: params.storeId,
      day,
    }),
    getUntaggedSpendRollup({ organizationId: params.organizationId, day }),
    getUtmDriftOrders({ ...params, day }),
    getSyncHealth({ ...params, now }),
    getRoasTarget(params.organizationId),
    getActiveMutedTypes({ organizationId: params.organizationId, now }),
  ]);

  // Days with no orders are omitted by the series query; the spike rule needs
  // them present so its trailing window really ends on the evaluation day.
  const byDay = new Map(bucketSeries.map((point) => [point.day, point]));
  const unattributedSeries: UnattributedDay[] = daysEndingOn(
    day,
    SPIKE_BASELINE_DAYS + SPIKE_CONSECUTIVE_DAYS,
  ).map((seriesDay) => {
    const point = byDay.get(seriesDay);
    return {
      day: seriesDay,
      unattributedCents: point?.buckets.unattributed ?? 0,
      totalCents: point?.totalNetCents ?? 0,
    };
  });

  const roasEvaluation = evaluateRoasBelowTarget({
    series: claimVerified.slice(-ROAS_CONSECUTIVE_DAYS).map((entry) => ({
      day: entry.day,
      verifiedRevenueCents: entry.verifiedCents,
      spendCents: entry.spendCents,
    })),
    target: roasTarget,
  });
  const overclaimEvaluation = evaluateMetaOverclaim(claimVerified);

  // Rules that could not reach a judgement this run. They are not "no longer
  // firing" — nothing about them was decided — so the retire pass leaves their
  // open findings alone.
  const indeterminate = new Set<FindingType>([
    ...(roasEvaluation.outcome === "indeterminate"
      ? (["roas_below_target"] as const)
      : []),
    ...(overclaimEvaluation.outcome === "indeterminate"
      ? (["meta_overclaim"] as const)
      : []),
  ]);

  // Every rule the run evaluates, under the type it can raise. The keys are
  // exhaustive over FindingType, so the list of types a run covers cannot drift
  // from the rules it actually ran.
  const evaluated: Record<FindingType, FindingDraft | null> = {
    meta_overclaim:
      overclaimEvaluation.outcome === "fires" ? overclaimEvaluation.draft : null,
    unattributed_spike: evaluateUnattributedSpike(unattributedSeries),
    broken_utm_template: evaluateBrokenUtmTemplate({ day, ...brokenUtm }),
    sync_failure: evaluateSyncFailure({ health, day, now }),
    roas_below_target: roasEvaluation.outcome === "fires" ? roasEvaluation.draft : null,
    ad_lp_funnel_mismatch: evaluateAdLpFunnelMismatch({
      day,
      candidates: mismatchCandidates,
    }),
    untagged_spend: evaluateUntaggedSpend({ day, rollup: untaggedSpend }),
    utm_template_drift: evaluateUtmTemplateDrift({
      day,
      orders: utmDriftOrders,
    }),
  };

  const drafts = Object.values(evaluated).filter(
    (draft): draft is FindingDraft => draft !== null,
  );

  for (const draft of drafts) {
    if (mutedTypes.has(draft.type)) {
      summary.skippedMuted.push(draft.type);
      continue;
    }

    // Refresh the open finding of this type instead of stacking duplicates;
    // once it is resolved, the next occurrence is a new row.
    const [newest] = await db
      .select({ id: findings.id, resolvedAt: findings.resolvedAt })
      .from(findings)
      .where(
        and(
          eq(findings.organizationId, params.organizationId),
          eq(findings.storeId, params.storeId),
          eq(findings.type, draft.type),
        ),
      )
      .orderBy(desc(findings.firedAt))
      .limit(1);

    if (newest && newest.resolvedAt === null) {
      await db
        .update(findings)
        .set({
          firedAt: now,
          periodStart: draft.periodStart,
          periodEnd: draft.periodEnd,
          payload: draft.payload,
        })
        .where(eq(findings.id, newest.id));
      summary.refreshed.push(draft.type);
      continue;
    }

    await db.insert(findings).values({
      organizationId: params.organizationId,
      storeId: params.storeId,
      type: draft.type,
      firedAt: now,
      periodStart: draft.periodStart,
      periodEnd: draft.periodEnd,
      payload: draft.payload,
    });
    summary.fired.push(draft.type);
  }

  summary.indeterminate.push(
    ...FINDING_TYPES.filter(
      (type) => indeterminate.has(type) && !mutedTypes.has(type),
    ),
  );

  for (const type of typesToRetire({
    evaluated,
    muted: mutedTypes,
    indeterminate,
  })) {
    const retired = await db
      .update(findings)
      .set({ resolvedAt: now, resolution: "retired" })
      .where(
        and(
          eq(findings.organizationId, params.organizationId),
          eq(findings.storeId, params.storeId),
          eq(findings.type, type),
          isNull(findings.resolvedAt),
        ),
      )
      .returning({ id: findings.id });

    if (retired.length > 0) summary.resolved.push(type);
  }

  // Stamped last, and only on a run that got this far: the timestamp says "the
  // rules were applied to the data as it stood at this moment", which is the
  // one claim anything quoting a finding needs in order to be true.
  await db
    .update(shopifyStores)
    .set({ findingsEvaluatedAt: now })
    .where(eq(shopifyStores.id, params.storeId));

  return summary;
}

/* ------------------------------------------------------------------ */
/* Today's checklist                                                   */
/* ------------------------------------------------------------------ */

/**
 * What a check reports is which findings are open, not whether the numbers are
 * currently good. The read is live, but only the nightly sweep writes findings,
 * so an `ok` can equally mean nobody has re-checked — and nothing a reader does
 * will change it before tonight. Calling this a stale snapshot would be worse
 * than useless: it invites the reader to think a fresh read fixes it.
 */
export type CheckStatus = "ok" | "needs_look" | "waiting_for_data";

export type TodaysCheck = {
  type: FindingType;
  status: CheckStatus;
  /**
   * Days in the rule's decision window it could not compute, newest last.
   *
   * Absent, not empty, on a rule that has no per-day window to report on — the
   * two mean different things and a reader must not collapse them. Absent is
   * "this rule cannot tell you which days it was missing"; empty is "it looked
   * and no day was missing". An empty list beside `waiting_for_data` therefore
   * means the rule was blocked by something other than an absent day, which
   * today means it has no full window of history yet.
   */
  uncomputableDays?: string[];
  /**
   * The window `uncomputableDays` is drawn from, inclusive, in store-local days.
   * Present on exactly the rules that report `uncomputableDays`.
   *
   * Here so a reader can tell a routine reporting lag from a real gap without
   * knowing this repo's window lengths or the store's evaluation day. Meta fills
   * the newest day in late as a matter of course, so a hole that ends at
   * `periodEnd` and runs contiguously back is the ordinary case, while the same
   * number of days sitting in the middle of the window is not. Deriving that
   * from a hardcoded window length would leave a copy of these constants in
   * every consumer, going stale silently the first time one changes.
   */
  periodStart?: string;
  periodEnd?: string;
};

/** Only these read Meta; the rest run off Shopify alone. */
const META_DEPENDENT_TYPES: readonly FindingType[] = [
  "meta_overclaim",
  "roas_below_target",
  "ad_lp_funnel_mismatch",
  "untagged_spend",
];

/**
 * The Meta-dependent rules that walk a per-day series, and so can say which
 * days they were missing.
 *
 * `ad_lp_funnel_mismatch` and `untagged_spend` are Meta-dependent too, but both
 * judge a single aggregate over their window rather than a series, so there is
 * no day list to hand back. They keep the connector-age proxy below until their
 * queries return per-day spend.
 */
const DAY_SERIES_TYPES = ["meta_overclaim", "roas_below_target"] as const;

type DaySeriesType = (typeof DAY_SERIES_TYPES)[number];

type DaySeriesWindow = {
  uncomputableDays: string[];
  periodStart: string;
  periodEnd: string;
};

export type TodaysChecks = {
  /**
   * When the rules last ran. Null before a store has ever been swept.
   *
   * It dates the rules, not the statuses beside it, and the two are genuinely
   * different clocks. A status is re-derived per request from three inputs the
   * sweep does not own: unresolved findings (someone can resolve one), active
   * mutes (someone can add one), and live connector health. So a status can
   * change with no sweep in between, and freezing them to make the two agree
   * would be worse — `sync_failure` reading current connector health is the
   * point of it.
   *
   * The honest pairing is therefore "the rules last ran at T, and N are flagged
   * now", not "as of T, N were flagged". `findings.list` carries `firedAt` per
   * item for dating what a specific finding said.
   */
  rulesLastRanAt: Date | null;
  checks: TodaysCheck[];
};

function isDaySeriesType(type: FindingType): type is DaySeriesType {
  return (DAY_SERIES_TYPES as readonly FindingType[]).includes(type);
}

/**
 * Which days each series rule could not compute, as of right now.
 *
 * This is the whole point of the endpoint being a live read. The sweep's answer
 * is hours old by morning, and Meta fills a day in at its own pace, so asking
 * the rules again is the only way `waiting_for_data` can mean "the rule cannot
 * judge" rather than "a connector looked old at some point".
 *
 * One fetch serves both rules: the overclaim window is the tail of the ROAS
 * one, which is the shorter-window rule riding along for free. The days come
 * from `daysEndingOn`, not from a query, so the series is always full length —
 * a store with too little history shows up as days present with no Meta rows,
 * which is the same hole under a different cause and wants the same answer.
 */
async function getUncomputableDaysByType(params: {
  organizationId: string;
  storeId: string;
  now: Date;
  ianaTimezone: string;
}): Promise<Record<DaySeriesType, DaySeriesWindow>> {
  const day = evaluationDayFor(params.now, params.ianaTimezone);
  const series = await getClaimVerifiedSeries({
    organizationId: params.organizationId,
    storeId: params.storeId,
    days: daysEndingOn(day, ROAS_CONSECUTIVE_DAYS),
  });

  const overclaimWindow = series.slice(-OVERCLAIM_CONSECUTIVE_DAYS);

  return {
    roas_below_target: {
      uncomputableDays: roasUncomputableDays(
        series.map((entry) => ({
          day: entry.day,
          verifiedRevenueCents: entry.verifiedCents,
          spendCents: entry.spendCents,
        })),
      ),
      periodStart: series[0].day,
      periodEnd: day,
    },
    meta_overclaim: {
      uncomputableDays: overclaimUncomputableDays(overclaimWindow),
      periodStart: overclaimWindow[0].day,
      periodEnd: day,
    },
  };
}

export async function getTodaysChecks(params: {
  organizationId: string;
  storeId: string;
  now?: Date;
}): Promise<TodaysChecks> {
  const now = params.now ?? new Date();

  const [firstSync, health, openRows, mutedTypes, [storeRow], [lastFiredRow]] =
    await Promise.all([
    getFirstSyncState(params),
    getSyncHealth({ ...params, now }),
    db
      .select({ type: findings.type })
      .from(findings)
      .where(
        and(
          eq(findings.organizationId, params.organizationId),
          eq(findings.storeId, params.storeId),
          isNull(findings.resolvedAt),
        ),
      ),
    getActiveMutedTypes({ organizationId: params.organizationId, now }),
    db
      .select({
        findingsEvaluatedAt: shopifyStores.findingsEvaluatedAt,
        ianaTimezone: shopifyStores.ianaTimezone,
      })
      .from(shopifyStores)
      .where(eq(shopifyStores.id, params.storeId))
      .limit(1),
    // A lower bound for a store swept before the column existed. Only sweeps
    // write findings, so the newest `firedAt` is a time a sweep certainly ran.
    db
      .select({ lastFiredAt: sql<Date | null>`max(${findings.firedAt})`.mapWith(
        findings.firedAt,
      ) })
      .from(findings)
      .where(
        and(
          eq(findings.organizationId, params.organizationId),
          eq(findings.storeId, params.storeId),
        ),
      ),
  ]);

  // Null has to mean one thing — "we cannot say when the rules last ran" — or a
  // caller reading it as "never swept" draws the wrong conclusion from silence.
  // A store swept before this column shipped is knowable, so it is answered
  // rather than reported as unknown. The floor only ever errs old: a sweep that
  // fired and retired nothing leaves no trace, so the stamp lags rather than
  // leads, and a consumer told the rules ran longer ago than they did stays
  // more cautious, never less. A store that has genuinely never been swept has
  // no findings, so it still answers null, correctly.
  const rulesLastRanAt =
    storeRow?.findingsEvaluatedAt ?? lastFiredRow?.lastFiredAt ?? null;

  // Before the first sync lands there is nothing to judge any rule against. No
  // day is nameable yet either, so the series rules report an empty list rather
  // than pretending to know which days they were missing.
  if (!firstSync.hasAnySuccessfulSync) {
    return {
      rulesLastRanAt,
      checks: FINDING_TYPES.map((type) => ({
        type,
        status: "waiting_for_data" as const,
        // No sync has landed, so there is no window to draw bounds from either.
        ...(isDaySeriesType(type) ? { uncomputableDays: [] } : {}),
      })),
    };
  }

  const openTypes = new Set(openRows.map((row) => row.type));
  const uncomputable = await getUncomputableDaysByType({
    ...params,
    now,
    ianaTimezone: storeRow?.ianaTimezone ?? "UTC",
  });

  const checks = FINDING_TYPES.map((type): TodaysCheck => {
    // A muted type is deliberately quiet, so it never asks for a look.
    if (openTypes.has(type) && !mutedTypes.has(type)) {
      return { type, status: "needs_look" as const };
    }

    // The rules that walk a series answer for themselves: they either could
    // compute their window or they could not, and the connector's age is beside
    // the point. A sync three hours old still leaves yesterday unreported, and
    // a sync two days old can still have every day the window needs.
    if (isDaySeriesType(type)) {
      const window = uncomputable[type];
      return {
        type,
        status:
          window.uncomputableDays.length > 0 ? "waiting_for_data" : "ok",
        ...window,
      };
    }

    // The rest keep the connector-age proxy. It is coarse — it cannot tell a
    // reported day from an unreported one — but it is the only signal these two
    // have, and dropping it would turn a hedge into a confident `ok`.
    // sync_failure reports on the connectors itself — it is never "waiting".
    if (META_DEPENDENT_TYPES.includes(type) && health.meta.stale) {
      return { type, status: "waiting_for_data" as const };
    }
    return { type, status: "ok" as const };
  });

  return { rulesLastRanAt, checks };
}
