/**
 * The findings feed: five frozen rules, evaluated once a day per store.
 *
 * The evaluators at the top are pure — they take per-day numbers and return a
 * draft finding or null, so the thresholds are unit-testable without a DB. The
 * assembly function below is the only part that touches Postgres, and it reuses
 * `attribution-queries` for every read except the broken-UTM sample.
 *
 * Payloads are frozen at fire time: whatever a rule cites is stored, never
 * re-derived when the feed is read.
 */

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  PAID_LOOKING_MEDIUM_HINTS,
  PAID_LOOKING_MEDIUM_REGEX_SOURCE,
} from "@/lib/attribution-bucket";
import { addDays } from "@/lib/day";
import {
  computeRoas,
  getDailyBucketSeries,
  getMetaClaims,
  getMetaVerified,
  getRoasTarget,
  getSyncHealth,
  type SyncHealth,
} from "@/lib/attribution-queries";
import { deriveDayInTimezone } from "@/lib/shopify-ingest";
import { findingMutes, findings, type findingTypeEnum } from "@/schema/finding";
import { shopifyOrders, shopifyStores, shopifySyncRuns } from "@/schema/shopify";

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

/** Five unattributed orders in one day that carry a paid medium. */
export const BROKEN_UTM_MIN_ORDERS = 5;
export const BROKEN_UTM_SAMPLE_LIMIT = 5;

/** Verified ROAS under target for a full week of computable days. */
export const ROAS_CONSECUTIVE_DAYS = 7;

/** Mute is a fixed week — custom durations were explicitly rejected. */
export const MUTE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export type FindingType = (typeof findingTypeEnum.enumValues)[number];

export const FINDING_TYPES = [
  "meta_overclaim",
  "unattributed_spike",
  "broken_utm_template",
  "sync_failure",
  "roas_below_target",
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
};

/** Claimed with nothing verified is the worst case, so it counts as over. */
export function isOverclaimDay(day: ClaimVerifiedDay): boolean {
  if (day.claimedCents === null || day.claimedCents <= 0) return false;
  return day.claimedCents > OVERCLAIM_MULTIPLE * day.verifiedCents;
}

export function evaluateMetaOverclaim(
  series: ClaimVerifiedDay[],
): FindingDraft | null {
  const window = trailingWindow(series, OVERCLAIM_CONSECUTIVE_DAYS);
  if (!window) return null;
  if (!window.every(isOverclaimDay)) return null;

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

  const movedWider =
    baselineMultipleRaw === null ||
    windowMultipleRaw === null ||
    windowMultipleRaw >= OVERCLAIM_MOVEMENT_MULTIPLE * baselineMultipleRaw;
  if (!movedWider) return null;

  return {
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
      lastSuccessAt: params.health[connector].lastSuccessAt?.toISOString() ?? null,
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
  spendCents: number;
};

export function evaluateRoasBelowTarget(params: {
  series: RoasDay[];
  target: number;
}): FindingDraft | null {
  const window = trailingWindow(params.series, ROAS_CONSECUTIVE_DAYS);
  if (!window) return null;

  const points = window.map((day) => ({
    day: day.day,
    roas: computeRoas(day.verifiedRevenueCents, day.spendCents),
    verifiedRevenueCents: day.verifiedRevenueCents,
    spendCents: day.spendCents,
  }));

  // A non-computable day (no spend, no claims data) breaks the streak — it is
  // not a zero-ROAS day.
  const belowAllWeek = points.every(
    (point) => point.roas !== null && point.roas < params.target,
  );
  if (!belowAllWeek) return null;

  return {
    type: "roas_below_target",
    periodStart: window[0].day,
    periodEnd: window[window.length - 1].day,
    payload: {
      target: params.target,
      consecutiveDays: ROAS_CONSECUTIVE_DAYS,
      days: points,
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

/** Per-day Meta claims + Shopify-verified revenue, oldest day first. */
async function getClaimVerifiedSeries(params: {
  organizationId: string;
  storeId: string;
  days: string[];
}) {
  return Promise.all(
    params.days.map(async (day) => {
      const [claims, verified] = await Promise.all([
        getMetaClaims({
          organizationId: params.organizationId,
          dateFrom: day,
          dateTo: day,
        }),
        getMetaVerified({
          organizationId: params.organizationId,
          storeId: params.storeId,
          dateFrom: day,
          dateTo: day,
        }),
      ]);

      return {
        day,
        claimedCents: claims.claimedCents,
        spendCents: claims.spendCents,
        verifiedCents: verified.verifiedRevenueCents,
      };
    }),
  );
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
  skippedMuted: FindingType[];
};

export async function evaluateFindingsForStore(params: {
  organizationId: string;
  storeId: string;
  now?: Date;
}): Promise<FindingsRunSummary> {
  const now = params.now ?? new Date();
  const summary: FindingsRunSummary = {
    fired: [],
    refreshed: [],
    skippedMuted: [],
  };

  const store = await getStoreById(params);
  if (!store) return summary;

  const day = evaluationDayFor(now, store.ianaTimezone);
  const claimDays = daysEndingOn(
    day,
    OVERCLAIM_CONSECUTIVE_DAYS + OVERCLAIM_BASELINE_DAYS,
  );
  const bucketFrom = addDays(day, -(SPIKE_BASELINE_DAYS + SPIKE_CONSECUTIVE_DAYS - 1));

  const [claimVerified, bucketSeries, brokenUtm, health, roasTarget, mutedTypes] =
    await Promise.all([
      getClaimVerifiedSeries({ ...params, days: claimDays }),
      getDailyBucketSeries({
        organizationId: params.organizationId,
        storeId: params.storeId,
        dateFrom: bucketFrom,
        dateTo: day,
      }),
      getBrokenUtmOrders({ ...params, day }),
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

  const drafts = [
    evaluateMetaOverclaim(
      claimVerified.map((entry) => ({
        day: entry.day,
        claimedCents: entry.claimedCents,
        verifiedCents: entry.verifiedCents,
      })),
    ),
    evaluateUnattributedSpike(unattributedSeries),
    evaluateBrokenUtmTemplate({ day, ...brokenUtm }),
    evaluateSyncFailure({ health, day, now }),
    evaluateRoasBelowTarget({
      series: claimVerified.slice(-ROAS_CONSECUTIVE_DAYS).map((entry) => ({
        day: entry.day,
        verifiedRevenueCents: entry.verifiedCents,
        spendCents: entry.spendCents,
      })),
      target: roasTarget,
    }),
  ].filter((draft): draft is FindingDraft => draft !== null);

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

  return summary;
}

/* ------------------------------------------------------------------ */
/* Today's checklist                                                   */
/* ------------------------------------------------------------------ */

export type CheckStatus = "ok" | "needs_look" | "waiting_for_data";

export type TodaysCheck = { type: FindingType; status: CheckStatus };

/** Only these read Meta; the rest run off Shopify alone. */
const META_DEPENDENT_TYPES: readonly FindingType[] = [
  "meta_overclaim",
  "roas_below_target",
];

export async function getTodaysChecks(params: {
  organizationId: string;
  storeId: string;
  now?: Date;
}): Promise<TodaysCheck[]> {
  const now = params.now ?? new Date();

  const [firstSync, health, openRows, mutedTypes] = await Promise.all([
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
  ]);

  // Before the first sync lands there is nothing to judge any rule against.
  if (!firstSync.hasAnySuccessfulSync) {
    return FINDING_TYPES.map((type) => ({
      type,
      status: "waiting_for_data" as const,
    }));
  }

  const openTypes = new Set(openRows.map((row) => row.type));

  return FINDING_TYPES.map((type) => {
    // A muted type is deliberately quiet, so it never asks for a look.
    if (openTypes.has(type) && !mutedTypes.has(type)) {
      return { type, status: "needs_look" as const };
    }
    // sync_failure reports on the connectors itself — it is never "waiting".
    if (META_DEPENDENT_TYPES.includes(type) && health.meta.stale) {
      return { type, status: "waiting_for_data" as const };
    }
    return { type, status: "ok" as const };
  });
}
