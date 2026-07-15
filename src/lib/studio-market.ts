import { and, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { studioGenerations, studioVariants } from "@/schema/studio";
import { performanceLogs } from "@/schema/performance-log";
import {
  fetchCreativePerformanceRows,
  toNullableNumber,
  toNumber,
} from "@/lib/studio-performance";
import {
  classifyTrend,
  WINNER_TREND_SPLIT_DAYS,
  WINNER_WINDOW_DAYS,
  type WinnerTrend,
} from "@/lib/studio-winners";

export type StudioMarketResult = {
  variantId: string;
  generationId: string;
  angle: string | null;
  mark: string | null;
  creativeId: string;
  creativeName: string;
  roas: number | null;
  spend: number | null;
  purchases: number | null;
};

export type StudioMarketTopVariant = {
  variantId: string;
  imageUrl: string;
  creativeName: string;
  roas: number | null;
  purchases: number | null;
  spend: number | null;
  trend: WinnerTrend;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function fetchStudioMarketResults(
  organizationId: string,
): Promise<StudioMarketResult[]> {
  const linkedVariants = await db
    .select({
      variantId: studioVariants.id,
      generationId: studioVariants.generationId,
      angle: studioGenerations.angle,
      mark: studioVariants.mark,
      creativeId: adCreatives.id,
      creativeName: adCreatives.name,
    })
    .from(studioVariants)
    .innerJoin(
      studioGenerations,
      eq(studioGenerations.id, studioVariants.generationId),
    )
    .innerJoin(adCreatives, eq(adCreatives.id, studioVariants.linkedCreativeId))
    .where(
      and(
        eq(studioVariants.organizationId, organizationId),
        eq(studioGenerations.organizationId, organizationId),
        eq(adCreatives.organizationId, organizationId),
        isNotNull(studioVariants.linkedCreativeId),
      ),
    );

  if (linkedVariants.length === 0) return [];

  const creativeIds = Array.from(
    new Set(linkedVariants.map((variant) => variant.creativeId)),
  );
  const performance = await fetchCreativePerformanceRows(organizationId, [
    inArray(adCreatives.id, creativeIds),
  ]);
  const performanceById = new Map(
    performance.map((row) => [
      row.creativeId,
      {
        roas: toNullableNumber(row.roas),
        spend: toNullableNumber(row.spend),
        purchases: toNullableNumber(row.purchases),
      },
    ]),
  );

  return linkedVariants.map((variant) => {
    const metrics = performanceById.get(variant.creativeId);
    return {
      ...variant,
      roas: metrics?.roas ?? null,
      spend: metrics?.spend ?? null,
      purchases: metrics?.purchases ?? null,
    };
  });
}

export async function fetchStudioMarketTopVariants(
  organizationId: string,
  limit = 5,
): Promise<StudioMarketTopVariant[]> {
  const linkedVariants = await db
    .select({
      variantId: studioVariants.id,
      imageUrl: studioVariants.imageUrl,
      creativeId: adCreatives.id,
      creativeName: adCreatives.name,
    })
    .from(studioVariants)
    .innerJoin(
      studioGenerations,
      eq(studioGenerations.id, studioVariants.generationId),
    )
    .innerJoin(adCreatives, eq(adCreatives.id, studioVariants.linkedCreativeId))
    .where(
      and(
        eq(studioVariants.organizationId, organizationId),
        eq(studioGenerations.organizationId, organizationId),
        eq(adCreatives.organizationId, organizationId),
        isNotNull(studioVariants.linkedCreativeId),
        isNotNull(studioVariants.imageUrl),
      ),
    );
  if (linkedVariants.length === 0 || limit <= 0) return [];

  const creativeIds = Array.from(
    new Set(linkedVariants.map((variant) => variant.creativeId)),
  );
  const now = Date.now();
  const windowStart = new Date(now - WINNER_WINDOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const trendSplit = new Date(now - WINNER_TREND_SPLIT_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const creativeCondition = inArray(adCreatives.id, creativeIds);
  const [performance, recentPerformance, priorPerformance] = await Promise.all([
    fetchCreativePerformanceRows(organizationId, [creativeCondition]),
    fetchCreativePerformanceRows(organizationId, [
      creativeCondition,
      gte(performanceLogs.dateStart, trendSplit),
    ]),
    fetchCreativePerformanceRows(organizationId, [
      creativeCondition,
      gte(performanceLogs.dateStart, windowStart),
      lt(performanceLogs.dateStart, trendSplit),
    ]),
  ]);
  const performanceById = new Map(
    performance.map((row) => [row.creativeId, row]),
  );
  const recentById = new Map(
    recentPerformance.map((row) => [row.creativeId, row]),
  );
  const priorById = new Map(
    priorPerformance.map((row) => [row.creativeId, row]),
  );

  return linkedVariants
    .flatMap((variant) => {
      if (!variant.imageUrl) return [];
      const metrics = performanceById.get(variant.creativeId);
      if (!metrics) return [];
      const recent = recentById.get(variant.creativeId);
      const prior = priorById.get(variant.creativeId);
      return [{
        variantId: variant.variantId,
        imageUrl: variant.imageUrl,
        creativeName: variant.creativeName,
        roas: toNullableNumber(metrics.roas),
        purchases: toNullableNumber(metrics.purchases),
        spend: toNullableNumber(metrics.spend),
        trend: classifyTrend({
          recentRoas: toNumber(recent?.roas),
          priorRoas: toNumber(prior?.roas),
          recentSpend: toNumber(recent?.spend),
        }),
      }];
    })
    .sort(
      (a, b) =>
        (b.roas ?? -1) - (a.roas ?? -1) ||
        (b.purchases ?? -1) - (a.purchases ?? -1),
    )
    .slice(0, limit);
}
