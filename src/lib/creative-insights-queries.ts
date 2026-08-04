/**
 * Creative-insights reads (spec §9): what your ads said, sliced against what
 * came back.
 *
 * Same shape as `attribution-queries.ts` — plain async functions, money summed
 * in SQL and converted once through the cents helpers, pure shaping functions
 * kept separate so they can be unit-tested without a database.
 *
 * Two rows are never dropped from a slice, because dropping them would quietly
 * change the total: `no_tags_yet` (an ad we matched but cannot place on this
 * dimension) and `unmatched_ad` (an order whose ad we could not resolve at all).
 * Every Meta-bucket order in the range lands in exactly one row.
 */

import { and, between, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { addDays } from "@/lib/day";
import {
  COVERAGE_WINDOW_DAYS,
  EXPLICIT_SLICE_KEYS,
  INSIGHT_MIN_SPEND,
  NO_TAGS_KEY,
  TAGGED_SPEND_MIN_SHARE,
  UNMATCHED_KEY,
  type CoverageAdRow,
  type CoverageSummary,
  type DrillInAdRow,
  type EnforcedTag,
  type InsightCard,
  type InsightsScope,
  type SliceDimension,
  type SliceRow,
  type TaggingQueueRow,
} from "@/lib/creative-insights-shared";
import { toCents } from "@/lib/money";
import { adCreatives } from "@/schema/ad-creative";
import { adSets } from "@/schema/ad-set";
import { ads } from "@/schema/ad";
import { campaigns } from "@/schema/campaign";
import { performanceLogs } from "@/schema/performance-log";
import { shopifyOrders, shopifyRefunds } from "@/schema/shopify";

/**
 * The vocabulary lives in the shared module so client components can read it
 * without pulling `pg` into the bundle; the server surface is unchanged, so
 * callers may keep importing any of it from here.
 */
export * from "@/lib/creative-insights-shared";

/* ------------------------------------------------------------------ */
/* Pure shaping (unit-tested — no DB)                                  */
/* ------------------------------------------------------------------ */

export function isExplicitSliceKey(key: string): boolean {
  return key === NO_TAGS_KEY || key === UNMATCHED_KEY;
}

/** Back per $1. Undefined without spend — never a fake 0. */
export function backPerDollar(
  revenueCents: number,
  spendCents: number | null,
): number | null {
  if (spendCents === null || spendCents <= 0) return null;
  return revenueCents / spendCents;
}

/**
 * One slice list out of three grouped scans. Tagged values sort by revenue,
 * then the two explicit rows are appended in a fixed order so the eye always
 * finds them in the same place — they are the caveat, not a result.
 */
export function mergeSliceRows(params: {
  orderRows: Array<{ key: string; grossCents: number; orderCount: number }>;
  refundRows: Array<{ key: string; refundedCents: number }>;
  spendRows: Array<{ key: string; spendCents: number }>;
}): SliceRow[] {
  const revenue = new Map<string, number>();
  const orderCount = new Map<string, number>();
  const spend = new Map<string, number>();

  for (const row of params.orderRows) {
    revenue.set(row.key, (revenue.get(row.key) ?? 0) + row.grossCents);
    orderCount.set(row.key, (orderCount.get(row.key) ?? 0) + row.orderCount);
  }
  for (const row of params.refundRows) {
    revenue.set(row.key, (revenue.get(row.key) ?? 0) - row.refundedCents);
  }
  for (const row of params.spendRows) {
    spend.set(row.key, (spend.get(row.key) ?? 0) + row.spendCents);
  }

  const keys = new Set<string>([
    ...revenue.keys(),
    ...orderCount.keys(),
    ...spend.keys(),
    ...EXPLICIT_SLICE_KEYS,
  ]);

  const build = (key: string): SliceRow => {
    const revenueCents = revenue.get(key) ?? 0;
    // Spend never lands on `unmatched_ad`: that row is an order-side state.
    const spendCents = key === UNMATCHED_KEY ? null : (spend.get(key) ?? 0);
    return {
      key,
      revenueCents,
      orderCount: orderCount.get(key) ?? 0,
      spendCents,
      backPer1: backPerDollar(revenueCents, spendCents),
    };
  };

  const tagged = [...keys]
    .filter((key) => !isExplicitSliceKey(key))
    .map(build)
    .sort(
      (a, b) =>
        b.revenueCents - a.revenueCents ||
        (b.spendCents ?? 0) - (a.spendCents ?? 0) ||
        a.key.localeCompare(b.key),
    );

  return [...tagged, build(NO_TAGS_KEY), build(UNMATCHED_KEY)];
}

/** Which of the four enforced tags this ad is still missing. */
export function missingTags(row: {
  creativeId: string | null;
  funnelStage: string | null;
  persona: string | null;
  angle: string | null;
  awarenessLevel: string | null;
}): EnforcedTag[] {
  const missing: EnforcedTag[] = [];
  if (row.funnelStage === null) missing.push("funnelStage");
  // No creative behind the ad means none of its three tags can exist.
  if (row.creativeId === null || row.persona === null) missing.push("persona");
  if (row.creativeId === null || row.angle === null) missing.push("angle");
  if (row.creativeId === null || row.awarenessLevel === null) {
    missing.push("awareness");
  }
  return missing;
}

/**
 * Trailing-window coverage: how much active Meta spend is fully tagged, and
 * which ads would move the number most. The top list is what the veil note and
 * the queue header name — "the exact ads that unlock them".
 */
export function summarizeCoverage(
  rows: readonly CoverageAdRow[],
  topLimit = 5,
): CoverageSummary {
  let totalActiveSpendCents = 0;
  let taggedSpendCents = 0;
  let untaggedAdCount = 0;
  const untagged: CoverageSummary["topUntaggedAds"] = [];

  for (const row of rows) {
    totalActiveSpendCents += row.spendCents;
    const missing = missingTags(row);
    if (missing.length === 0) {
      taggedSpendCents += row.spendCents;
      continue;
    }
    untaggedAdCount += 1;
    untagged.push({
      adId: row.adId,
      adName: row.adName,
      creativeId: row.creativeId,
      spendCents: row.spendCents,
      missing,
    });
  }

  const share =
    totalActiveSpendCents > 0 ? taggedSpendCents / totalActiveSpendCents : null;

  return {
    totalActiveSpendCents,
    taggedSpendCents,
    untaggedSpendCents: totalActiveSpendCents - taggedSpendCents,
    share,
    // No spend at all is not a failing grade: there is nothing to veil.
    gated: share !== null && share < TAGGED_SPEND_MIN_SHARE,
    activeAdCount: rows.length,
    untaggedAdCount,
    topUntaggedAds: untagged
      .sort((a, b) => b.spendCents - a.spendCents || a.adId.localeCompare(b.adId))
      .slice(0, topLimit),
  };
}

/**
 * The two claims on top of the screen: the best-paying value in each of angle
 * and awareness, among slices carrying enough spend to be worth a sentence.
 * Copywriting happens in the UI — this returns only the inputs.
 */
export function pickInsightCards(params: {
  slices: Partial<Record<SliceDimension, readonly SliceRow[]>>;
  minSpendCents?: number;
  barLimit?: number;
}): InsightCard[] {
  const minSpendCents = params.minSpendCents ?? INSIGHT_MIN_SPEND * 100;
  const barLimit = params.barLimit ?? 4;
  const cards: InsightCard[] = [];

  for (const dimension of ["angle", "awareness"] as const) {
    const rows = params.slices[dimension] ?? [];
    const ranked = rows
      .filter(
        (row): row is SliceRow & { spendCents: number; backPer1: number } =>
          !isExplicitSliceKey(row.key) &&
          row.spendCents !== null &&
          row.spendCents >= minSpendCents &&
          row.backPer1 !== null,
      )
      .sort((a, b) => b.backPer1 - a.backPer1 || a.key.localeCompare(b.key));

    const best = ranked[0];
    if (!best) continue;
    const runnerUp = ranked[1];

    cards.push({
      dimension,
      value: best.key,
      backPer1: best.backPer1,
      spendCents: best.spendCents,
      revenueCents: best.revenueCents,
      runnerUp: runnerUp
        ? { value: runnerUp.key, backPer1: runnerUp.backPer1 }
        : null,
      bars: ranked
        .slice(0, barLimit)
        .map((row) => ({ value: row.key, backPer1: row.backPer1 })),
    });
  }

  return cards.sort((a, b) => b.backPer1 - a.backPer1);
}

/* ------------------------------------------------------------------ */
/* SQL fragments                                                       */
/* ------------------------------------------------------------------ */

/** Base Meta rows only; breakdown rows repeat the same spend. */
function basePerformanceRowsOnly() {
  return and(
    isNull(performanceLogs.country),
    isNull(performanceLogs.platform),
    isNull(performanceLogs.placement),
    isNull(performanceLogs.device),
    isNull(performanceLogs.age),
    isNull(performanceLogs.gender),
  );
}

/**
 * The ad behind an order. `meta_ad_id` holds a real Meta ad id for both the
 * `id` and the `name` match methods; an `unmatched` row holds whatever the link
 * carried, so it is never joined — it is its own slice row.
 */
function orderAdJoin(organizationId: string) {
  return and(
    eq(ads.organizationId, organizationId),
    sql`${shopifyOrders.metaAdMatchMethod} is distinct from 'unmatched'`,
    sql`lower(${ads.metaId}) = ${shopifyOrders.metaAdId}`,
  );
}

/** The dimension's own column, on the ad or on its creative. */
function dimensionColumn(dimension: SliceDimension) {
  switch (dimension) {
    case "angle":
      return adCreatives.angle;
    case "persona":
      return adCreatives.persona;
    case "awareness":
      return adCreatives.awarenessLevel;
    case "funnelStage":
      return ads.funnelStage;
  }
}

/**
 * Every order lands somewhere: no resolvable ad is `unmatched_ad`, a resolved
 * ad with nothing on this dimension is `no_tags_yet`.
 */
function sliceKeyExpression(dimension: SliceDimension) {
  const column = dimensionColumn(dimension);
  return sql<string>`case
    when ${ads.id} is null then ${UNMATCHED_KEY}
    when ${column} is null then ${NO_TAGS_KEY}
    else ${column}::text
  end`;
}

function spendKeyExpression(dimension: SliceDimension) {
  const column = dimensionColumn(dimension);
  return sql<string>`case
    when ${column} is null then ${NO_TAGS_KEY}
    else ${column}::text
  end`;
}

/* ------------------------------------------------------------------ */
/* Slices                                                              */
/* ------------------------------------------------------------------ */

export async function getSlices(
  scope: InsightsScope,
  dimension: SliceDimension,
): Promise<SliceRow[]> {
  const key = sliceKeyExpression(dimension);
  const spendKey = spendKeyExpression(dimension);

  const metaOrders = and(
    eq(shopifyOrders.organizationId, scope.organizationId),
    eq(shopifyOrders.storeId, scope.storeId),
    eq(shopifyOrders.bucket, "meta"),
  );

  const [orderRows, refundRows, spendRows] = await Promise.all([
    db
      .select({
        key,
        gross: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
        orderCount: sql<number>`count(*)::int`,
      })
      .from(shopifyOrders)
      .leftJoin(ads, orderAdJoin(scope.organizationId))
      .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
      .where(
        and(
          metaOrders,
          between(shopifyOrders.orderDay, scope.dateFrom, scope.dateTo),
        ),
      )
      // Grouping by ordinal, not by the expression again: the key carries bound
      // parameters, and a repeated expression binds *new* placeholders that
      // Postgres will not recognise as the same thing.
      .groupBy(sql`1`),

    // Refunds land on the day the money went back, so they carry their own
    // range — the same rule the attribution ledger uses.
    db
      .select({
        key,
        refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      })
      .from(shopifyRefunds)
      .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyRefunds.orderId))
      .leftJoin(ads, orderAdJoin(scope.organizationId))
      .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
      .where(
        and(
          metaOrders,
          eq(shopifyRefunds.organizationId, scope.organizationId),
          eq(shopifyRefunds.storeId, scope.storeId),
          between(shopifyRefunds.refundDay, scope.dateFrom, scope.dateTo),
        ),
      )
      .groupBy(sql`1`),

    db
      .select({
        key: spendKey,
        spend: sql<string>`coalesce(sum(${performanceLogs.spend}), 0)`,
      })
      .from(performanceLogs)
      .innerJoin(ads, eq(performanceLogs.adId, ads.id))
      .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
      .where(
        and(
          eq(performanceLogs.organizationId, scope.organizationId),
          between(performanceLogs.dateStart, scope.dateFrom, scope.dateTo),
          basePerformanceRowsOnly(),
        ),
      )
      .groupBy(sql`1`),
  ]);

  return mergeSliceRows({
    orderRows: orderRows.map((row) => ({
      key: row.key,
      grossCents: toCents(row.gross),
      orderCount: row.orderCount,
    })),
    refundRows: refundRows.map((row) => ({
      key: row.key,
      refundedCents: toCents(row.refunded),
    })),
    spendRows: spendRows.map((row) => ({
      key: row.key,
      spendCents: toCents(row.spend),
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Coverage + tagging queue                                            */
/* ------------------------------------------------------------------ */

async function getActiveAdTagRows(params: {
  organizationId: string;
  day: string;
  windowDays?: number;
}): Promise<CoverageAdRow[]> {
  const days = params.windowDays ?? COVERAGE_WINDOW_DAYS;
  const rows = await db
    .select({
      adId: ads.id,
      adName: ads.name,
      creativeId: adCreatives.id,
      funnelStage: sql<string | null>`${ads.funnelStage}`,
      persona: adCreatives.persona,
      angle: adCreatives.angle,
      awarenessLevel: sql<string | null>`${adCreatives.awarenessLevel}`,
      spend: sql<string>`coalesce(sum(${performanceLogs.spend}), 0)`,
    })
    .from(ads)
    .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
    .leftJoin(
      performanceLogs,
      and(
        eq(performanceLogs.adId, ads.id),
        eq(performanceLogs.organizationId, params.organizationId),
        between(
          performanceLogs.dateStart,
          addDays(params.day, -(days - 1)),
          params.day,
        ),
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
      ads.name,
      ads.funnelStage,
      adCreatives.id,
      adCreatives.persona,
      adCreatives.angle,
      adCreatives.awarenessLevel,
    );

  return rows.map((row) => ({
    adId: row.adId,
    adName: row.adName,
    creativeId: row.creativeId,
    funnelStage: row.funnelStage,
    persona: row.persona,
    angle: row.angle,
    awarenessLevel: row.awarenessLevel,
    spendCents: toCents(row.spend),
  }));
}

export async function getCoverage(params: {
  organizationId: string;
  day: string;
  topLimit?: number;
}): Promise<CoverageSummary> {
  const rows = await getActiveAdTagRows(params);
  return summarizeCoverage(rows, params.topLimit);
}

/**
 * The queue: untagged active ads, biggest spender first. The ordering is the
 * prioritization — nothing else on the screen ranks the work.
 */
export async function getTaggingQueue(params: {
  organizationId: string;
  day: string;
  limit?: number;
}): Promise<TaggingQueueRow[]> {
  const days = COVERAGE_WINDOW_DAYS;
  const rows = await db
    .select({
      adId: ads.id,
      adName: ads.name,
      creativeId: adCreatives.id,
      adSetName: adSets.name,
      campaignName: campaigns.name,
      funnelStage: sql<string | null>`${ads.funnelStage}`,
      persona: adCreatives.persona,
      angle: adCreatives.angle,
      awarenessLevel: sql<string | null>`${adCreatives.awarenessLevel}`,
      spend: sql<string>`coalesce(sum(${performanceLogs.spend}), 0)`,
    })
    .from(ads)
    .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
    .leftJoin(adSets, eq(ads.adSetId, adSets.id))
    .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
    .leftJoin(
      performanceLogs,
      and(
        eq(performanceLogs.adId, ads.id),
        eq(performanceLogs.organizationId, params.organizationId),
        between(
          performanceLogs.dateStart,
          addDays(params.day, -(days - 1)),
          params.day,
        ),
        basePerformanceRowsOnly(),
      ),
    )
    .where(
      and(
        eq(ads.organizationId, params.organizationId),
        eq(ads.status, "active"),
        isNotNull(ads.metaId),
        sql`(
          ${ads.funnelStage} is null
          or ${adCreatives.id} is null
          or ${adCreatives.persona} is null
          or ${adCreatives.angle} is null
          or ${adCreatives.awarenessLevel} is null
        )`,
      ),
    )
    .groupBy(
      ads.id,
      ads.name,
      ads.funnelStage,
      adCreatives.id,
      adCreatives.persona,
      adCreatives.angle,
      adCreatives.awarenessLevel,
      adSets.name,
      campaigns.name,
    )
    .orderBy(desc(sql`coalesce(sum(${performanceLogs.spend}), 0)`))
    .limit(params.limit ?? 200);

  return rows.map((row) => ({
    adId: row.adId,
    adName: row.adName,
    creativeId: row.creativeId,
    adSetName: row.adSetName,
    campaignName: row.campaignName,
    spendCents: toCents(row.spend),
    missing: missingTags(row),
  }));
}

/* ------------------------------------------------------------------ */
/* Drill-in                                                            */
/* ------------------------------------------------------------------ */

/**
 * The ads inside one slice row: spend and the Meta-modelled funnel counts from
 * `performance_log`, against the revenue their orders carry. Ratios are formed
 * in the UI — the counts cross the wire exactly as Meta reported them.
 */
export async function getDrillIn(
  scope: InsightsScope,
  params: { dimension: SliceDimension; value: string; limit?: number },
): Promise<DrillInAdRow[]> {
  if (params.value === UNMATCHED_KEY) return [];

  const column = dimensionColumn(params.dimension);
  const matches =
    params.value === NO_TAGS_KEY
      ? isNull(column)
      : sql`${column}::text = ${params.value}`;

  const [spendRows, revenueRows, refundRows] = await Promise.all([
    db
      .select({
        adId: ads.id,
        adName: ads.name,
        spend: sql<string>`coalesce(sum(${performanceLogs.spend}), 0)`,
        clicks: sql<number>`coalesce(sum(${performanceLogs.linkClicks}), 0)::int`,
        landingPageViews: sql<number>`coalesce(sum(${performanceLogs.landingPageViews}), 0)::int`,
        addToCart: sql<number>`coalesce(sum(${performanceLogs.addToCart}), 0)::int`,
      })
      .from(performanceLogs)
      .innerJoin(ads, eq(performanceLogs.adId, ads.id))
      .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
      .where(
        and(
          eq(performanceLogs.organizationId, scope.organizationId),
          between(performanceLogs.dateStart, scope.dateFrom, scope.dateTo),
          basePerformanceRowsOnly(),
          matches,
        ),
      )
      .groupBy(ads.id, ads.name),

    db
      .select({
        adId: ads.id,
        gross: sql<string>`coalesce(sum(${shopifyOrders.netSales}), 0)`,
      })
      .from(shopifyOrders)
      .innerJoin(ads, orderAdJoin(scope.organizationId))
      .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
      .where(
        and(
          eq(shopifyOrders.organizationId, scope.organizationId),
          eq(shopifyOrders.storeId, scope.storeId),
          eq(shopifyOrders.bucket, "meta"),
          between(shopifyOrders.orderDay, scope.dateFrom, scope.dateTo),
          matches,
        ),
      )
      .groupBy(ads.id),

    // Netted off the same way the slice above nets them, so an ad's row and the
    // row it sits inside never disagree about what came back.
    db
      .select({
        adId: ads.id,
        refunded: sql<string>`coalesce(sum(${shopifyRefunds.amount}), 0)`,
      })
      .from(shopifyRefunds)
      .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyRefunds.orderId))
      .innerJoin(ads, orderAdJoin(scope.organizationId))
      .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
      .where(
        and(
          eq(shopifyRefunds.organizationId, scope.organizationId),
          eq(shopifyRefunds.storeId, scope.storeId),
          eq(shopifyOrders.bucket, "meta"),
          between(shopifyRefunds.refundDay, scope.dateFrom, scope.dateTo),
          matches,
        ),
      )
      .groupBy(ads.id),
  ]);

  const revenueByAd = new Map(
    revenueRows.map((row) => [row.adId, toCents(row.gross)]),
  );
  const refundByAd = new Map(
    refundRows.map((row) => [row.adId, toCents(row.refunded)]),
  );

  return spendRows
    .map((row) => {
      const spendCents = toCents(row.spend);
      const revenueCents =
        (revenueByAd.get(row.adId) ?? 0) - (refundByAd.get(row.adId) ?? 0);
      return {
        adId: row.adId,
        adName: row.adName,
        spendCents,
        revenueCents,
        backPer1: backPerDollar(revenueCents, spendCents),
        clicks: row.clicks,
        landingPageViews: row.landingPageViews,
        addToCart: row.addToCart,
      };
    })
    .sort(
      (a, b) =>
        b.revenueCents - a.revenueCents ||
        b.spendCents - a.spendCents ||
        a.adId.localeCompare(b.adId),
    )
    .slice(0, params.limit ?? 25);
}
