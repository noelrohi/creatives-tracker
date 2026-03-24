import { z } from "zod";
import { eq, desc, ilike, and, sql, type SQL } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { landingPages } from "@/schema/landing-page";
import { ads } from "@/schema/ad";
import { performanceLogs } from "@/schema/performance-log";
import { accounts } from "@/schema/account";

export const adCreativeRouter = router({
  list: baseProcedure
    .meta(openApiQueryMeta("adCreative", "list"))
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
          accountId: z.string().optional(),
          untaggedOnly: z.boolean().optional(),
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
      if (input?.accountId) {
        conditions.push(sql`EXISTS (SELECT 1 FROM ad WHERE ad.ad_creative_id = ${adCreatives.id} AND ad.account_id = ${input.accountId})`);
      }
      if (input?.untaggedOnly) {
        conditions.push(sql`(${adCreatives.format} IS NULL AND ${adCreatives.angle} IS NULL AND ${adCreatives.awarenessLevel} IS NULL)`);
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
          adStatus: sql<string | null>`(
            SELECT ad.status FROM ad
            WHERE ad.ad_creative_id = ${adCreatives.id}
            LIMIT 1
          )`.as("ad_status"),
          metaAdId: sql<string | null>`(
            SELECT ad.meta_id FROM ad
            WHERE ad.ad_creative_id = ${adCreatives.id}
            LIMIT 1
          )`.as("meta_ad_id"),
        })
        .from(adCreatives)
        .leftJoin(landingPages, eq(adCreatives.landingPageId, landingPages.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(adCreatives.createdAt));
    }),

  getById: baseProcedure
    .meta(openApiQueryMeta("adCreative", "getById"))
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
    .meta(openApiMutationMeta("adCreative", "create"))
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
    .meta(openApiMutationMeta("adCreative", "update"))
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
    .meta(openApiMutationMeta("adCreative", "duplicate"))
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
    .meta(openApiMutationMeta("adCreative", "bulkImport"))
    .input(
      z.object({
        accountId: z.string().optional(),
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
          linkClicks: z.number().int().optional(),
          clicksAll: z.number().int().optional(),
          cpc: z.string().optional(),
          ctrLinkClick: z.string().optional(),
          landingPageViews: z.number().int().optional(),
          costPerLpv: z.string().optional(),
          purchaseValue: z.string().optional(),
          addToCart: z.number().int().optional(),
          initiateCheckout: z.number().int().optional(),
          costPerAddToCart: z.string().optional(),
          videoViews3s: z.number().int().optional(),
          videoThruplay: z.number().int().optional(),
          videoAvgWatchTime: z.string().optional(),
          country: z.string().optional(),
          platform: z.string().optional(),
          placement: z.string().optional(),
          device: z.string().optional(),
          age: z.string().optional(),
          gender: z.string().optional(),
          delivery: z.string().optional(),
          adId: z.string().optional(),
          campaignId: z.string().optional(),
          adSetId: z.string().optional(),
            dateStart: z.string(),
            dateEnd: z.string(),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      // 1. Collect unique ads from import, keyed by metaAdId (primary) or name (fallback)
      const adInfoMap = new Map<string, { name: string; delivery?: string; metaAdId?: string }>();
      for (const row of input.rows) {
        const key = row.adId || row.name;
        if (!adInfoMap.has(key)) {
          adInfoMap.set(key, { name: row.name, delivery: row.delivery, metaAdId: row.adId });
        }
      }

      // 2. Fetch existing ads by meta_id first, then by name for any unmatched
      const metaIds = [...adInfoMap.values()].map((a) => a.metaAdId).filter(Boolean) as string[];
      const existingByMetaId = new Map<string, { id: string; name: string; adCreativeId: string | null }>();
      if (metaIds.length > 0) {
        const rows = await db
          .select({ id: ads.id, name: ads.name, adCreativeId: ads.adCreativeId, metaId: ads.metaId })
          .from(ads)
          .where(sql`${ads.metaId} IN (${sql.join(metaIds.map((m) => sql`${m}`), sql`, `)})`);
        for (const row of rows) {
          if (row.metaId) existingByMetaId.set(row.metaId, row);
        }
      }

      const unmatchedNames: string[] = [];
      for (const info of adInfoMap.values()) {
        if (info.metaAdId && existingByMetaId.has(info.metaAdId)) continue;
        if (!info.metaAdId) unmatchedNames.push(info.name);
      }

      const existingByName = new Map<string, { id: string; name: string; adCreativeId: string | null }>();
      if (unmatchedNames.length > 0) {
        const rows = await db
          .select({ id: ads.id, name: ads.name, adCreativeId: ads.adCreativeId })
          .from(ads)
          .where(sql`${ads.name} IN (${sql.join(unmatchedNames.map((n) => sql`${n}`), sql`, `)})`);
        for (const row of rows) {
          existingByName.set(row.name, row);
        }
      }

      // Build a unified map of existing ads (metaId match takes priority)
      const existingMap = new Map<string, { id: string; name: string; adCreativeId: string | null }>();
      for (const [key, info] of adInfoMap) {
        const byMeta = info.metaAdId ? existingByMetaId.get(info.metaAdId) : undefined;
        const byName = existingByName.get(info.name);
        const existing = byMeta || byName;
        if (existing) existingMap.set(key, existing);
      }

      const newKeys = [...adInfoMap.keys()].filter((k) => !existingMap.has(k));
      const needsBackfill = [...existingMap.values()].filter((a) => !a.adCreativeId);

      // 3. Batch create creatives for new ads + backfills
      const creativesToCreate = [
        ...newKeys.map((k) => ({ name: adInfoMap.get(k)!.name })),
        ...needsBackfill.map((a) => ({ name: a.name })),
      ];

      let createdCreatives: { id: string; name: string }[] = [];
      if (creativesToCreate.length > 0) {
        for (let i = 0; i < creativesToCreate.length; i += 500) {
          const batch = creativesToCreate.slice(i, i + 500);
          const inserted = await db.insert(adCreatives).values(batch).returning();
          createdCreatives.push(...inserted);
        }
      }

      const creativeByName = new Map(createdCreatives.map((c) => [c.name, c.id]));

      // 4. Update backfilled ads with their new creative IDs
      for (const ad of needsBackfill) {
        const creativeId = creativeByName.get(ad.name);
        if (creativeId) {
          await db.update(ads).set({ adCreativeId: creativeId }).where(eq(ads.id, ad.id));
        }
      }

      // 5. Batch create new ads
      if (newKeys.length > 0) {
        const newAdsValues = newKeys.map((key) => {
          const info = adInfoMap.get(key)!;
          const status =
            info.delivery === "active" ? "active" as const
            : info.delivery === "inactive" || info.delivery === "not_delivering" ? "paused" as const
            : "active" as const;
          return {
            name: info.name,
            adCreativeId: creativeByName.get(info.name),
            status,
            metaId: info.metaAdId,
            accountId: input.accountId,
          };
        });

        for (let i = 0; i < newAdsValues.length; i += 500) {
          const batch = newAdsValues.slice(i, i + 500);
          await db.insert(ads).values(batch).returning();
        }
      }

      // 6. Update existing ads (name, status, metaId, accountId)
      for (const [key, existing] of existingMap) {
        const info = adInfoMap.get(key)!;
        const status =
          info.delivery === "active" ? "active" as const
          : info.delivery === "inactive" || info.delivery === "not_delivering" ? "paused" as const
          : "active" as const;
        await db.update(ads).set({
          name: info.name,
          status,
          ...(info.metaAdId ? { metaId: info.metaAdId } : {}),
          ...(input.accountId ? { accountId: input.accountId } : {}),
        }).where(eq(ads.id, existing.id));
      }

      // 7. Re-fetch all ads to build name→id map (use current names after updates)
      const allAdNames = [...adInfoMap.values()].map((a) => a.name);
      const allAds = allAdNames.length > 0
        ? await db
            .select({ id: ads.id, name: ads.name, metaId: ads.metaId })
            .from(ads)
            .where(sql`${ads.name} IN (${sql.join(allAdNames.map((n) => sql`${n}`), sql`, `)})`)
        : [];
      const adIdByName = new Map(allAds.map((a) => [a.name, a.id]));
      const adIdByMetaId = new Map(allAds.filter((a) => a.metaId).map((a) => [a.metaId!, a.id]));

      // 8. Batch delete existing perf logs for these ads + date ranges, then bulk insert
      const perfRows: (typeof performanceLogs.$inferInsert)[] = [];

      for (const row of input.rows) {
        const adId = (row.adId && adIdByMetaId.get(row.adId)) || adIdByName.get(row.name);
        if (!adId) continue;

        const { name: _, delivery: __, adId: _m1, campaignId: _m2, adSetId: _m3, ...perfData } = row;
        const hasPerf = perfData.spend || perfData.roas || perfData.conversions || perfData.linkClicks || perfData.impressions;
        if (!hasPerf) continue;

        // Compute conversionRate from conversions / linkClicks if not provided
        let { conversionRate, ...restPerf } = perfData;
        if (!conversionRate && restPerf.conversions && restPerf.linkClicks && restPerf.linkClicks > 0) {
          conversionRate = ((restPerf.conversions / restPerf.linkClicks) * 100).toFixed(2);
        }

        perfRows.push({
          ...restPerf,
          conversionRate,
          adId,
        });
      }

      if (perfRows.length > 0) {
        // Get unique ad IDs in this import
        const importAdIds = [...new Set(perfRows.map((r) => r.adId))];

        // Get the date range of this import
        const dateStarts = perfRows.map((r) => r.dateStart).filter(Boolean) as string[];
        const dateEnds = perfRows.map((r) => r.dateEnd).filter(Boolean) as string[];
        const minDate = dateStarts.sort()[0];
        const maxDate = dateEnds.sort().reverse()[0];

        // Delete existing logs for these ads in this date range (clean slate for reimport)
        if (minDate && maxDate) {
          await db.delete(performanceLogs).where(
            and(
              sql`${performanceLogs.adId} IN (${sql.join(importAdIds.map((id) => sql`${id}`), sql`, `)})`,
              sql`${performanceLogs.dateStart} >= ${minDate}`,
              sql`${performanceLogs.dateEnd} <= ${maxDate}`,
            ),
          );
        }

        // Bulk insert in batches of 1000
        for (let i = 0; i < perfRows.length; i += 1000) {
          const batch = perfRows.slice(i, i + 1000);
          await db.insert(performanceLogs).values(batch);
        }
      }

      // Build results
      const results = allAds
        .filter((a) => {
          const creative = createdCreatives.find((c) => c.name === a.name);
          return !!creative;
        })
        .map((a) => {
          const creative = createdCreatives.find((c) => c.name === a.name)!;
          return { id: creative.id, name: a.name };
        });

      // Stamp account with import timestamp and latest data date
      if (input.accountId) {
        const dateEnds = perfRows.map((r) => r.dateEnd).filter(Boolean) as string[];
        const maxDataDate = dateEnds.sort().reverse()[0] ?? null;
        await db.update(accounts).set({
          lastImportedAt: new Date(),
          ...(maxDataDate ? { dataDateEnd: maxDataDate } : {}),
        }).where(eq(accounts.id, input.accountId));
      }

      return {
        created: results,
        totalRows: input.rows.length,
        uniqueAds: adInfoMap.size,
        perfLogs: perfRows.length,
      };
    }),

  getPerformance: baseProcedure
    .meta(openApiQueryMeta("adCreative", "getPerformance"))
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      // Creative-level aggregated metrics
      const [creative] = await db
        .select({
          totalSpend: sql<string | null>`sum(${performanceLogs.spend})`,
          avgRoas: sql<string | null>`avg(${performanceLogs.roas})`,
          avgCpa: sql<string | null>`avg(${performanceLogs.cpa})`,
          avgCtr: sql<string | null>`avg(${performanceLogs.ctr})`,
          totalConversions: sql<number | null>`sum(${performanceLogs.conversions})`,
          totalImpressions: sql<number | null>`sum(${performanceLogs.impressions})`,
          totalClicks: sql<number | null>`sum(${performanceLogs.linkClicks})`,
          logCount: sql<number>`count(*)`,
          minDate: sql<string | null>`min(${performanceLogs.dateStart})`,
          maxDate: sql<string | null>`max(${performanceLogs.dateEnd})`,
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(performanceLogs.adId, ads.id))
        .where(eq(ads.adCreativeId, input.id));

      // Portfolio averages for comparison
      const [portfolio] = await db
        .select({
          avgRoas: sql<string | null>`avg(${performanceLogs.roas})`,
          avgCpa: sql<string | null>`avg(${performanceLogs.cpa})`,
          avgCtr: sql<string | null>`avg(${performanceLogs.ctr})`,
        })
        .from(performanceLogs);

      // Derive live status from linked ads
      const adStatuses = await db
        .select({ status: ads.status })
        .from(ads)
        .where(eq(ads.adCreativeId, input.id));

      const liveStatus = adStatuses.length === 0
        ? "no_ads"
        : adStatuses.some((a) => a.status === "active")
          ? "active"
          : "paused";

      return {
        totalSpend: creative?.totalSpend ?? null,
        avgRoas: creative?.avgRoas ?? null,
        avgCpa: creative?.avgCpa ?? null,
        avgCtr: creative?.avgCtr ?? null,
        totalConversions: creative?.totalConversions ?? null,
        totalImpressions: creative?.totalImpressions ?? null,
        totalClicks: creative?.totalClicks ?? null,
        logCount: creative?.logCount ?? 0,
        minDate: creative?.minDate ?? null,
        maxDate: creative?.maxDate ?? null,
        portfolioAvgRoas: portfolio?.avgRoas ?? null,
        portfolioAvgCpa: portfolio?.avgCpa ?? null,
        portfolioAvgCtr: portfolio?.avgCtr ?? null,
        liveStatus,
      };
    }),

  delete: baseProcedure
    .meta(openApiMutationMeta("adCreative", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      // Delete linked ads (cascades to performance_logs via FK)
      await db.delete(ads).where(eq(ads.adCreativeId, input.id));
      await db.delete(adCreatives).where(eq(adCreatives.id, input.id));
    }),
});
