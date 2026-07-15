import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adCreatives } from "@/schema/ad-creative";
import { performanceLogs } from "@/schema/performance-log";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";

// Drizzle returns aggregated numerics as strings; these coerce them for math.
export function toNumber(value: string | number | null | undefined) {
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toNullableNumber(value: string | number | null | undefined) {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type CreativePerformanceRow = {
  creativeId: string;
  name: string;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  format: string | null;
  assetUrl: string | null;
  spend: string | null;
  purchases: number | null;
  purchaseValue: string | null;
  roas: string | null;
  adCount: number;
};

export async function fetchCreativePerformanceRows(
  organizationId: string,
  extraConditions: SQL[] = [],
) {
  const basePl = basePerformanceLogFilter("performance_log");
  const conditions: SQL[] = [
    eq(adCreatives.organizationId, organizationId),
    eq(ads.organizationId, organizationId),
    basePl,
    ...extraConditions,
  ];

  return db
    .select({
      creativeId: adCreatives.id,
      name: adCreatives.name,
      angle: adCreatives.angle,
      persona: adCreatives.persona,
      awarenessLevel: adCreatives.awarenessLevel,
      format: adCreatives.format,
      assetUrl: adCreatives.assetUrl,
      spend: sql<string | null>`sum(${performanceLogs.spend})::text`,
      purchases: sql<number | null>`sum(${performanceLogs.conversions})::int`,
      purchaseValue: sql<string | null>`sum(${performanceLogs.purchaseValue})::text`,
      roas: sql<string | null>`coalesce(sum(${performanceLogs.purchaseValue}), 0) / nullif(sum(${performanceLogs.spend}), 0)`,
      adCount: sql<number>`count(distinct ${ads.id})::int`,
    })
    .from(adCreatives)
    .innerJoin(ads, eq(ads.adCreativeId, adCreatives.id))
    .innerJoin(performanceLogs, eq(performanceLogs.adId, ads.id))
    .where(and(...conditions))
    .groupBy(
      adCreatives.id,
      adCreatives.name,
      adCreatives.angle,
      adCreatives.persona,
      adCreatives.awarenessLevel,
      adCreatives.format,
      adCreatives.assetUrl,
    ) as Promise<CreativePerformanceRow[]>;
}
