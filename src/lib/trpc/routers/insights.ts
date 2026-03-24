import { z } from "zod";
import { eq, desc, sql, avg, count, sum, and, gte, lte, isNull, or } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { ads } from "@/schema/ad";
import { performanceLogs } from "@/schema/performance-log";

function daysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function perfConditions(opts: { days?: number; dateStart?: string; dateEnd?: string; accountId?: string }) {
  const conds = [];
  if (opts.days) conds.push(gte(performanceLogs.dateStart, daysAgo(opts.days)));
  if (opts.dateStart) conds.push(gte(performanceLogs.dateStart, opts.dateStart));
  if (opts.dateEnd) conds.push(lte(performanceLogs.dateEnd, opts.dateEnd));
  if (opts.accountId) conds.push(eq(ads.accountId, opts.accountId));
  return conds.length > 0 ? and(...conds) : undefined;
}

export const insightsRouter = router({
  byField: baseProcedure
    .input(
      z.object({
        field: z.enum(["format", "awareness_level"]),
        days: z.number().int().min(1).max(365).optional(),
        dateStart: z.string().optional(),
        dateEnd: z.string().optional(),
        accountId: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const column =
        input.field === "format"
          ? adCreatives.format
          : adCreatives.awarenessLevel;

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
        .where(perfConditions(input))
        .groupBy(column)
        .orderBy(desc(sql`avg(${performanceLogs.roas})`));

      return rows;
    }),

  byAngle: baseProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(50).default(10),
        days: z.number().int().min(1).max(365).optional(),
        accountId: z.string().optional(),
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
        .where(perfConditions({ days: input?.days, accountId: input?.accountId }))
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
        days: z.number().int().min(1).max(365).optional(),
        accountId: z.string().optional(),
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

      // Only include creatives that have the requested metric
      const baseConds = perfConditions({ days: input?.days, accountId: input?.accountId });
      const metricFilter = sql`${metricCol} IS NOT NULL`;
      const where = baseConds ? and(baseConds, metricFilter) : metricFilter;

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
        .where(where)
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
        accountId: z.string().optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
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
        .where(perfConditions({ days: input?.days ?? 30, accountId: input?.accountId }));

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

  untaggedCount: baseProcedure
    .input(z.object({ accountId: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const conds = [
        isNull(adCreatives.format),
        isNull(adCreatives.angle),
        isNull(adCreatives.awarenessLevel),
      ];

      let query = db
        .select({ count: count().as("count") })
        .from(adCreatives)
        .innerJoin(ads, eq(ads.adCreativeId, adCreatives.id))
        .where(and(or(...conds), input?.accountId ? eq(ads.accountId, input.accountId) : undefined));

      const [row] = await query;
      return row?.count ?? 0;
    }),
});
