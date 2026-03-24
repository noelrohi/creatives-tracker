import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adSets } from "@/schema/ad-set";
import { adCreatives } from "@/schema/ad-creative";
import { landingPageVersions, landingPages } from "@/schema/landing-page";
import { campaigns } from "@/schema/campaign";
import { performanceLogs } from "@/schema/performance-log";

export const adRouter = router({
  list: baseProcedure.meta(openApiQueryMeta("ad", "list")).query(async () => {
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
        landingPageVersionId: ads.landingPageVersionId,
        landingPageName: landingPages.name,
        landingPageVersion: landingPageVersions.version,
        status: ads.status,
        notes: ads.notes,
        createdAt: ads.createdAt,
        updatedAt: ads.updatedAt,
      })
      .from(ads)
      .leftJoin(adSets, eq(ads.adSetId, adSets.id))
      .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
      .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
      .leftJoin(landingPageVersions, eq(ads.landingPageVersionId, landingPageVersions.id))
      .leftJoin(landingPages, eq(landingPageVersions.landingPageId, landingPages.id))
      .orderBy(desc(ads.createdAt));
  }),

  listByAdSet: baseProcedure
    .meta(openApiQueryMeta("ad", "listByAdSet"))
    .input(z.object({ adSetId: z.string() }))
    .query(async ({ input }) => {
      return db
        .select({
          id: ads.id,
          name: ads.name,
          adCreativeId: ads.adCreativeId,
          adCreativeName: adCreatives.name,
          landingPageVersionId: ads.landingPageVersionId,
          landingPageName: landingPages.name,
          landingPageVersion: landingPageVersions.version,
          status: ads.status,
          notes: ads.notes,
          createdAt: ads.createdAt,
        })
        .from(ads)
        .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .leftJoin(landingPageVersions, eq(ads.landingPageVersionId, landingPageVersions.id))
        .leftJoin(landingPages, eq(landingPageVersions.landingPageId, landingPages.id))
        .where(eq(ads.adSetId, input.adSetId))
        .orderBy(desc(ads.createdAt));
    }),

  listByCreative: baseProcedure
    .meta(openApiQueryMeta("ad", "listByCreative"))
    .input(z.object({ adCreativeId: z.string() }))
    .query(async ({ input }) => {
      return db
        .select({
          id: ads.id,
          name: ads.name,
          adSetId: ads.adSetId,
          adSetName: adSets.name,
          campaignName: campaigns.name,
          status: ads.status,
          notes: ads.notes,
          createdAt: ads.createdAt,
          totalSpend: sql<string | null>`sum(${performanceLogs.spend})`.as("total_spend"),
          avgRoas: sql<string | null>`avg(${performanceLogs.roas})`.as("avg_roas"),
          totalConversions: sql<number | null>`sum(${performanceLogs.conversions})`.as("total_conversions"),
          minDate: sql<string | null>`min(${performanceLogs.dateStart})`.as("min_date"),
          maxDate: sql<string | null>`max(${performanceLogs.dateEnd})`.as("max_date"),
        })
        .from(ads)
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
        .leftJoin(performanceLogs, eq(performanceLogs.adId, ads.id))
        .where(eq(ads.adCreativeId, input.adCreativeId))
        .groupBy(ads.id, ads.name, ads.adSetId, adSets.name, campaigns.name, ads.status, ads.notes, ads.createdAt)
        .orderBy(desc(ads.createdAt));
    }),

  getById: baseProcedure
    .meta(openApiQueryMeta("ad", "getById"))
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
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
          landingPageVersionId: ads.landingPageVersionId,
          landingPageName: landingPages.name,
          landingPageVersion: landingPageVersions.version,
          status: ads.status,
          notes: ads.notes,
            createdAt: ads.createdAt,
          updatedAt: ads.updatedAt,
        })
        .from(ads)
        .leftJoin(adSets, eq(ads.adSetId, adSets.id))
        .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
        .leftJoin(adCreatives, eq(ads.adCreativeId, adCreatives.id))
        .leftJoin(landingPageVersions, eq(ads.landingPageVersionId, landingPageVersions.id))
        .leftJoin(landingPages, eq(landingPageVersions.landingPageId, landingPages.id))
        .where(eq(ads.id, input.id));
      if (!ad) throw new Error("Ad not found");
      return ad;
    }),

  create: baseProcedure
    .meta(openApiMutationMeta("ad", "create"))
    .input(
      z.object({
        name: z.string().optional(),
        adSetId: z.string().optional(),
        adCreativeId: z.string().optional(),
        landingPageVersionId: z.string().optional(),
        metaId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const [ad] = await db
        .insert(ads)
        .values({
          name: input.name ?? "Untitled Ad",
          adSetId: input.adSetId,
          adCreativeId: input.adCreativeId,
          landingPageVersionId: input.landingPageVersionId,
          metaId: input.metaId,
        })
        .returning();
      return ad;
    }),

  update: baseProcedure
    .meta(openApiMutationMeta("ad", "update"))
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        adSetId: z.string().optional(),
        adCreativeId: z.string().nullable().optional(),
        landingPageVersionId: z.string().nullable().optional(),
        status: z.enum(["active", "paused", "archived"]).optional(),
        metaId: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const [ad] = await db
        .update(ads)
        .set(data)
        .where(eq(ads.id, id))
        .returning();
      return ad;
    }),

  duplicate: baseProcedure
    .meta(openApiMutationMeta("ad", "duplicate"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const [source] = await db
        .select()
        .from(ads)
        .where(eq(ads.id, input.id));
      if (!source) throw new Error("Ad not found");
      const [duplicate] = await db
        .insert(ads)
        .values({
          name: `Copy of ${source.name}`,
          adSetId: source.adSetId,
          adCreativeId: source.adCreativeId,
          landingPageVersionId: source.landingPageVersionId,
          status: source.status,
          notes: source.notes,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: baseProcedure
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
    .mutation(async ({ input }) => {
      const results: { adId: string; name: string }[] = [];

      for (const row of input.rows) {
        const [ad] = await db
          .insert(ads)
          .values({
            name: row.name,
            adSetId: input.adSetId,
          })
          .returning();

        const { name: _, ...perfData } = row;
        const hasPerf = perfData.spend || perfData.roas || perfData.conversions;
        if (hasPerf && perfData.dateStart && perfData.dateEnd) {
          await db.insert(performanceLogs).values({
            ...perfData,
            dateStart: perfData.dateStart,
            dateEnd: perfData.dateEnd,
            adId: ad.id,
          });
        }

        results.push({ adId: ad.id, name: ad.name });
      }

      return results;
    }),

  delete: baseProcedure
    .meta(openApiMutationMeta("ad", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .delete(ads)
        .where(eq(ads.id, input.id));
    }),
});
