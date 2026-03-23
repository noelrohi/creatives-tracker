import { z } from "zod";
import { eq, desc, sql, avg, count, sum, and, gte, lte } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { ads } from "@/schema/ad";
import { performanceLogs } from "@/schema/performance-log";

const resolutionFields = [
  "format",
  "angle",
  "persona",
  "awarenessLevel",
  "tone",
] as const;

export const insightsRouter = router({
  byField: baseProcedure
    .input(
      z.object({
        field: z.enum(["format", "awareness_level"]),
        dateStart: z.string().optional(),
        dateEnd: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const column =
        input.field === "format"
          ? adCreatives.format
          : adCreatives.awarenessLevel;

      const conditions = [];
      if (input.dateStart) conditions.push(gte(performanceLogs.dateStart, input.dateStart));
      if (input.dateEnd) conditions.push(lte(performanceLogs.dateEnd, input.dateEnd));

      const rows = await db
        .select({
          value: column,
          avgRoas: avg(performanceLogs.roas).as("avg_roas"),
          avgCpa: avg(performanceLogs.cpa).as("avg_cpa"),
          avgCtr: avg(performanceLogs.ctr).as("avg_ctr"),
          totalSpend: sum(performanceLogs.spend).as("total_spend"),
          totalConversions: sum(performanceLogs.conversions).as("total_conversions"),
          creativeCount: sql<number>`count(distinct ${adCreatives.id})`.as("creative_count"),
          logCount: count().as("log_count"),
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .innerJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(column)
        .orderBy(desc(sql`avg(${performanceLogs.roas})`));

      return rows;
    }),

  byAngle: baseProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(50).default(10),
      }).optional(),
    )
    .query(async ({ input }) => {
      const rows = await db
        .select({
          angle: adCreatives.angle,
          avgRoas: avg(performanceLogs.roas).as("avg_roas"),
          avgCpa: avg(performanceLogs.cpa).as("avg_cpa"),
          totalSpend: sum(performanceLogs.spend).as("total_spend"),
          creativeCount: sql<number>`count(distinct ${adCreatives.id})`.as("creative_count"),
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .innerJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .groupBy(adCreatives.angle)
        .orderBy(desc(sql`avg(${performanceLogs.roas})`))
        .limit(input?.limit ?? 10);

      return rows;
    }),

  topCreatives: baseProcedure
    .input(
      z.object({
        metric: z.enum(["roas", "cpa", "ctr"]).default("roas"),
        limit: z.number().int().min(1).max(20).default(10),
      }).optional(),
    )
    .query(async ({ input }) => {
      const metric = input?.metric ?? "roas";
      const metricCol =
        metric === "roas"
          ? performanceLogs.roas
          : metric === "cpa"
            ? performanceLogs.cpa
            : performanceLogs.ctr;

      const orderDir = metric === "cpa" ? sql`avg(${metricCol}) ASC` : desc(sql`avg(${metricCol})`);

      const rows = await db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          format: adCreatives.format,
          angle: adCreatives.angle,
          persona: adCreatives.persona,
          awarenessLevel: adCreatives.awarenessLevel,
          avgRoas: avg(performanceLogs.roas).as("avg_roas"),
          avgCpa: avg(performanceLogs.cpa).as("avg_cpa"),
          avgCtr: avg(performanceLogs.ctr).as("avg_ctr"),
          totalSpend: sum(performanceLogs.spend).as("total_spend"),
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .innerJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .groupBy(
          adCreatives.id,
          adCreatives.name,
          adCreatives.format,
          adCreatives.angle,
          adCreatives.persona,
          adCreatives.awarenessLevel,
        )
        .orderBy(orderDir)
        .limit(input?.limit ?? 10);

      return rows;
    }),

  summary: baseProcedure
    .input(
      z.object({
        days: z.number().int().min(1).max(365).default(30),
      }).optional(),
    )
    .query(async ({ input }) => {
      const days = input?.days ?? 30;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const [row] = await db
        .select({
          totalSpend: sum(performanceLogs.spend).as("total_spend"),
          avgRoas: avg(performanceLogs.roas).as("avg_roas"),
          avgCpa: avg(performanceLogs.cpa).as("avg_cpa"),
          avgCtr: avg(performanceLogs.ctr).as("avg_ctr"),
          totalConversions: sum(performanceLogs.conversions).as("total_conversions"),
          logCount: count().as("log_count"),
          creativeCount: sql<number>`count(distinct ${ads.adCreativeId})`.as("creative_count"),
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .where(gte(performanceLogs.dateStart, cutoffStr));

      return row ?? {
        totalSpend: null,
        avgRoas: null,
        avgCpa: null,
        avgCtr: null,
        totalConversions: null,
        logCount: 0,
        creativeCount: 0,
      };
    }),
});
