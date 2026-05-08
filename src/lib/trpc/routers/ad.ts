import { z } from "zod";
import { eq, desc, sql, and } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adSets } from "@/schema/ad-set";
import { adCreatives } from "@/schema/ad-creative";
import { campaigns } from "@/schema/campaign";
import { performanceLogs } from "@/schema/performance-log";
import { effectiveAdStatusSql } from "@/lib/effective-ad-status";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";

export const adRouter = router({
  list: orgProcedure.meta(openApiQueryMeta("ad", "list")).query(async ({ ctx }) => {
    return db
      .select({
        id: ads.id,
        name: ads.name,
        adSetId: ads.adSetId,
        adSetName: adSets.name,
        campaignId: adSets.campaignId,
        campaignName: campaigns.name,
        adCreativeId: ads.adCreativeId,
        adCreativeName: adCreatives.name,
        destinationUrl: ads.destinationUrl,
        status: effectiveAdStatusSql(ads.status, adSets.status),
        notes: ads.notes,
        createdAt: ads.createdAt,
        updatedAt: ads.updatedAt,
      })
      .from(ads)
      .leftJoin(adSets, eq(ads.adSetId, adSets.id))
      .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
      .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
      .where(eq(ads.organizationId, ctx.organizationId))
      .orderBy(desc(ads.createdAt));
  }),

  listByAdSet: orgProcedure
    .meta(openApiQueryMeta("ad", "listByAdSet"))
    .input(z.object({ adSetId: z.string() }))
    .query(async ({ input, ctx }) => {
      return db
        .select({
          id: ads.id,
          name: ads.name,
          adCreativeId: ads.adCreativeId,
          adCreativeName: adCreatives.name,
          destinationUrl: ads.destinationUrl,
          status: effectiveAdStatusSql(ads.status, adSets.status),
          notes: ads.notes,
          createdAt: ads.createdAt,
        })
        .from(ads)
        .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .where(and(eq(ads.adSetId, input.adSetId), eq(ads.organizationId, ctx.organizationId)))
        .orderBy(desc(ads.createdAt));
    }),

  listByCreative: orgProcedure
    .meta(openApiQueryMeta("ad", "listByCreative"))
    .input(z.object({
      adCreativeId: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const basePl = basePerformanceLogFilter("performance_log");
      const dateFilter = and(
        basePl,
        input.from ? sql`${performanceLogs.dateStart} >= ${input.from}` : undefined,
        input.to ? sql`${performanceLogs.dateEnd} <= ${input.to}` : undefined,
      );
      return db
        .select({
          id: ads.id,
          metaId: ads.metaId,
          name: ads.name,
          caption: ads.caption,
          adSetId: ads.adSetId,
          adSetName: adSets.name,
          campaignName: campaigns.name,
          destinationUrl: ads.destinationUrl,
          status: effectiveAdStatusSql(ads.status, adSets.status),
          notes: ads.notes,
          createdAt: ads.createdAt,
          totalSpend: sql<string | null>`sum(${performanceLogs.spend})`.as("total_spend"),
          avgRoas: sql<string | null>`coalesce(sum(${performanceLogs.purchaseValue}), 0) / nullif(sum(${performanceLogs.spend}), 0)`.as("avg_roas"),
          totalConversions: sql<number | null>`sum(${performanceLogs.conversions})`.as("total_conversions"),
          minDate: sql<string | null>`min(${performanceLogs.dateStart})`.as("min_date"),
          maxDate: sql<string | null>`max(${performanceLogs.dateEnd})`.as("max_date"),
        })
        .from(ads)
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
        .leftJoin(performanceLogs, and(eq(performanceLogs.adId, ads.id), dateFilter))
        .where(and(eq(ads.adCreativeId, input.adCreativeId), eq(ads.organizationId, ctx.organizationId)))
        .groupBy(ads.id, ads.metaId, ads.name, ads.caption, ads.adSetId, adSets.name, adSets.status, campaigns.name, ads.destinationUrl, ads.status, ads.notes, ads.createdAt)
        .orderBy(desc(ads.createdAt));
    }),

  getById: orgProcedure
    .meta(openApiQueryMeta("ad", "getById"))
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [ad] = await db
        .select({
          id: ads.id,
          name: ads.name,
          adSetId: ads.adSetId,
          adSetName: adSets.name,
          campaignId: adSets.campaignId,
          campaignName: campaigns.name,
          adCreativeId: ads.adCreativeId,
          adCreativeName: adCreatives.name,
          destinationUrl: ads.destinationUrl,
          status: effectiveAdStatusSql(ads.status, adSets.status),
          notes: ads.notes,
          createdAt: ads.createdAt,
          updatedAt: ads.updatedAt,
        })
        .from(ads)
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
        .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .where(and(eq(ads.id, input.id), eq(ads.organizationId, ctx.organizationId)));
      if (!ad) throw new Error("Ad not found");
      return ad;
    }),

  create: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "create"))
    .input(
      z.object({
        name: z.string().optional(),
        adSetId: z.string().optional(),
        adCreativeId: z.string().optional(),
        metaId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [ad] = await db
        .insert(ads)
        .values({
          name: input.name ?? "Untitled Ad",
          adSetId: input.adSetId,
          adCreativeId: input.adCreativeId,
          metaId: input.metaId,
          organizationId: ctx.organizationId,
        })
        .returning();
      return ad;
    }),

  update: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "update"))
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        adSetId: z.string().optional(),
        adCreativeId: z.string().nullable().optional(),
        status: z.enum(["active", "paused", "archived"]).optional(),
        metaId: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [ad] = await db
        .update(ads)
        .set(data)
        .where(and(eq(ads.id, id), eq(ads.organizationId, ctx.organizationId)))
        .returning();
      return ad;
    }),

  duplicate: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "duplicate"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(ads)
        .where(and(eq(ads.id, input.id), eq(ads.organizationId, ctx.organizationId)));
      if (!source) throw new Error("Ad not found");
      const [duplicate] = await db
        .insert(ads)
        .values({
          name: `Copy of ${source.name}`,
          adSetId: source.adSetId,
          adCreativeId: source.adCreativeId,
          status: source.status,
          notes: source.notes,
          organizationId: ctx.organizationId,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "bulkImport"))
    .input(
      z.object({
        adSetId: z.string(),
        rows: z.array(
          z.object({
            name: z.string(),
            roas: z.string().optional(),
            cpa: z.string().optional(),
            ctr: z.string().optional(),
            conversionRate: z.string().optional(),
            spend: z.string().optional(),
            conversions: z.number().int().optional(),
            impressions: z.number().int().optional(),
            reach: z.number().int().optional(),
            frequency: z.string().optional(),
            cpm: z.string().optional(),
            qualityRanking: z.string().optional(),
            engagementRateRanking: z.string().optional(),
            conversionRateRanking: z.string().optional(),
            dateStart: z.string().optional(),
            dateEnd: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const results: { adId: string; name: string }[] = [];

      for (const row of input.rows) {
        const [ad] = await db
          .insert(ads)
          .values({
            name: row.name,
            adSetId: input.adSetId,
            organizationId: ctx.organizationId,
          })
          .returning();

        const { name: _, ...perfData } = row;
        const hasPerf = perfData.spend || perfData.roas || perfData.conversions;
        if (hasPerf && perfData.dateStart && perfData.dateEnd) {
          await db
            .insert(performanceLogs)
            .values({
              ...perfData,
              dateStart: perfData.dateStart,
              dateEnd: perfData.dateEnd,
              adId: ad.id,
              organizationId: ctx.organizationId,
            })
            .onConflictDoNothing({
              target: [
                performanceLogs.adId,
                performanceLogs.dateStart,
                performanceLogs.dateEnd,
                performanceLogs.country,
                performanceLogs.platform,
                performanceLogs.placement,
                performanceLogs.device,
                performanceLogs.age,
                performanceLogs.gender,
              ],
            });
        }

        results.push({ adId: ad.id, name: ad.name });
      }

      return results;
    }),

  delete: orgWriteProcedure
    .meta(openApiMutationMeta("ad", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(ads)
        .where(and(eq(ads.id, input.id), eq(ads.organizationId, ctx.organizationId)));
    }),
});
