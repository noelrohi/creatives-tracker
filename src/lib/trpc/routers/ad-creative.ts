import { z } from "zod";
import { eq, desc, ilike, and, sql, type SQL } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { landingPages } from "@/schema/landing-page";
import { ads } from "@/schema/ad";
import { performanceLogs } from "@/schema/performance-log";

export const adCreativeRouter = router({
  list: baseProcedure
    .input(
      z
        .object({
          format: z
            .enum(["static", "video", "ugc", "carousel"])
            .optional(),
          awarenessLevel: z
            .enum([
              "unaware",
              "problem_aware",
              "solution_aware",
              "product_aware",
              "most_aware",
            ])
            .optional(),
          search: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const conditions: SQL[] = [];
      if (input?.format) {
        conditions.push(eq(adCreatives.format, input.format));
      }
      if (input?.awarenessLevel) {
        conditions.push(
          eq(adCreatives.awarenessLevel, input.awarenessLevel),
        );
      }
      if (input?.search) {
        conditions.push(ilike(adCreatives.name, `%${input.search}%`));
      }

      return db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          assetUrl: adCreatives.assetUrl,
          format: adCreatives.format,
          angle: adCreatives.angle,
          persona: adCreatives.persona,
          awarenessLevel: adCreatives.awarenessLevel,
          hook: adCreatives.hook,
          tone: adCreatives.tone,
          cta: adCreatives.cta,
          landingPageId: adCreatives.landingPageId,
          landingPageName: landingPages.name,
          notes: adCreatives.notes,
          createdAt: adCreatives.createdAt,
          updatedAt: adCreatives.updatedAt,
          totalSpend: sql<string | null>`(
            SELECT sum(pl.spend) FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
          )`.as("total_spend"),
          avgRoas: sql<string | null>`(
            SELECT avg(pl.roas) FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
          )`.as("avg_roas"),
          totalConversions: sql<number | null>`(
            SELECT sum(pl.conversions) FROM performance_log pl
            JOIN ad ON ad.id = pl.ad_id
            WHERE ad.ad_creative_id = ${adCreatives.id}
          )`.as("total_conversions"),
        })
        .from(adCreatives)
        .leftJoin(landingPages, eq(adCreatives.landingPageId, landingPages.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(adCreatives.createdAt));
    }),

  getById: baseProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [creative] = await db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          assetUrl: adCreatives.assetUrl,
          format: adCreatives.format,
          angle: adCreatives.angle,
          persona: adCreatives.persona,
          awarenessLevel: adCreatives.awarenessLevel,
          hook: adCreatives.hook,
          tone: adCreatives.tone,
          cta: adCreatives.cta,
          landingPageId: adCreatives.landingPageId,
          landingPageName: landingPages.name,
          notes: adCreatives.notes,
          createdAt: adCreatives.createdAt,
          updatedAt: adCreatives.updatedAt,
        })
        .from(adCreatives)
        .leftJoin(landingPages, eq(adCreatives.landingPageId, landingPages.id))
        .where(eq(adCreatives.id, input.id));
      if (!creative) throw new Error("Ad creative not found");
      return creative;
    }),

  create: baseProcedure
    .input(z.object({ name: z.string().optional() }).optional())
    .mutation(async ({ input }) => {
      const [creative] = await db
        .insert(adCreatives)
        .values({
          name: input?.name ?? "Untitled Creative",
        })
        .returning();
      return creative;
    }),

  update: baseProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        assetUrl: z.string().nullable().optional(),
        format: z.enum(["static", "video", "ugc", "carousel"]).nullable().optional(),
        angle: z.string().nullable().optional(),
        persona: z.string().nullable().optional(),
        awarenessLevel: z
          .enum(["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"])
          .nullable()
          .optional(),
        hook: z.string().nullable().optional(),
        tone: z.array(z.string()).nullable().optional(),
        cta: z.string().nullable().optional(),
        landingPageId: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const [creative] = await db
        .update(adCreatives)
        .set(data)
        .where(eq(adCreatives.id, id))
        .returning();
      return creative;
    }),

  duplicate: baseProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const [source] = await db
        .select()
        .from(adCreatives)
        .where(eq(adCreatives.id, input.id));
      if (!source) throw new Error("Ad creative not found");
      const [duplicate] = await db
        .insert(adCreatives)
        .values({
          name: `Copy of ${source.name}`,
          assetUrl: source.assetUrl,
          format: source.format,
          angle: source.angle,
          persona: source.persona,
          awarenessLevel: source.awarenessLevel,
          hook: source.hook,
          tone: source.tone,
          cta: source.cta,
          landingPageId: source.landingPageId,
          notes: source.notes,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: baseProcedure
    .input(
      z.array(
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
          linkClicks: z.number().int().optional(),
          clicksAll: z.number().int().optional(),
          cpc: z.string().optional(),
          ctrLinkClick: z.string().optional(),
          landingPageViews: z.number().int().optional(),
          costPerLpv: z.string().optional(),
          purchaseValue: z.string().optional(),
          delivery: z.string().optional(),
          dateStart: z.string(),
          dateEnd: z.string(),
        }),
      ),
    )
    .mutation(async ({ input }) => {
      const results: { id: string; name: string }[] = [];
      // Cache: ad name -> adId (dedup rows with same ad name)
      const adCache = new Map<string, string>();

      for (const row of input) {
        const adName = row.name;
        const status =
          row.delivery === "active" ? "active" as const
          : row.delivery === "inactive" || row.delivery === "not_delivering" ? "paused" as const
          : "active" as const;

        let adId = adCache.get(adName);

        if (!adId) {
          // Check if ad already exists by name
          const [existing] = await db
            .select({ id: ads.id, adCreativeId: ads.adCreativeId })
            .from(ads)
            .where(eq(ads.name, adName));

          if (existing) {
            adId = existing.id;
            // Update status on reimport
            await db.update(ads).set({ status }).where(eq(ads.id, adId));
            if (existing.adCreativeId) {
              results.push({ id: existing.adCreativeId, name: adName });
            }
          } else {
            // Create creative + ad
            const [creative] = await db
              .insert(adCreatives)
              .values({ name: adName })
              .returning();

            const [ad] = await db
              .insert(ads)
              .values({ name: adName, adCreativeId: creative.id, status })
              .returning();

            adId = ad.id;
            results.push({ id: creative.id, name: creative.name });
          }
          adCache.set(adName, adId);
        }

        // Upsert performance log — match on (adId, dateStart, dateEnd)
        const { name: _, delivery: __, ...perfData } = row;
        const hasPerf = perfData.spend || perfData.roas || perfData.conversions;
        if (hasPerf) {
          const [existingLog] = await db
            .select({ id: performanceLogs.id })
            .from(performanceLogs)
            .where(
              and(
                eq(performanceLogs.adId, adId),
                eq(performanceLogs.dateStart, perfData.dateStart),
                eq(performanceLogs.dateEnd, perfData.dateEnd),
              ),
            );

          if (existingLog) {
            await db
              .update(performanceLogs)
              .set(perfData)
              .where(eq(performanceLogs.id, existingLog.id));
          } else {
            await db.insert(performanceLogs).values({
              ...perfData,
              adId,
            });
          }
        }
      }
      return results;
    }),

  delete: baseProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.delete(adCreatives).where(eq(adCreatives.id, input.id));
    }),
});
