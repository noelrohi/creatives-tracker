import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { studioGenerations, studioVariants } from "@/schema/studio";
import {
  fetchCreativePerformanceRows,
  toNullableNumber,
} from "@/lib/studio-performance";

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
