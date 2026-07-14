import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adCreatives } from "@/schema/ad-creative";
import { performanceLogs } from "@/schema/performance-log";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";

export type CreativePerformanceRow = {
  creativeId: string;
  name: string;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
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
      adCreatives.assetUrl,
    ) as Promise<CreativePerformanceRow[]>;
}
