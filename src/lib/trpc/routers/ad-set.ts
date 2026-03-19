import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { adSets } from "@/schema/ad-set";
import { adCreatives } from "@/schema/ad-creative";
import { landingPageVersions, landingPages } from "@/schema/landing-page";
import { campaignConfigs } from "@/schema/campaign-config";
import { performanceLogs } from "@/schema/performance-log";

export const adSetRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select({
        id: adSets.id,
        name: adSets.name,
        adCreativeId: adSets.adCreativeId,
        adCreativeName: adCreatives.name,
        landingPageVersionId: adSets.landingPageVersionId,
        landingPageName: landingPages.name,
        landingPageVersion: landingPageVersions.version,
        campaignConfigId: adSets.campaignConfigId,
        campaignConfigName: campaignConfigs.name,
        notes: adSets.notes,
        createdBy: adSets.createdBy,
        createdAt: adSets.createdAt,
        updatedAt: adSets.updatedAt,
      })
      .from(adSets)
      .leftJoin(adCreatives, eq(adSets.adCreativeId, adCreatives.id))
      .leftJoin(
        landingPageVersions,
        eq(adSets.landingPageVersionId, landingPageVersions.id),
      )
      .leftJoin(
        landingPages,
        eq(landingPageVersions.landingPageId, landingPages.id),
      )
      .leftJoin(
        campaignConfigs,
        eq(adSets.campaignConfigId, campaignConfigs.id),
      )
      .where(eq(adSets.organizationId, ctx.organizationId))
      .orderBy(desc(adSets.createdAt));
  }),

  listByCampaign: protectedProcedure
    .input(z.object({ campaignConfigId: z.string() }))
    .query(async ({ input, ctx }) => {
      return db
        .select({
          id: adSets.id,
          name: adSets.name,
          adCreativeId: adSets.adCreativeId,
          adCreativeName: adCreatives.name,
          landingPageVersionId: adSets.landingPageVersionId,
          landingPageName: landingPages.name,
          landingPageVersion: landingPageVersions.version,
          notes: adSets.notes,
          createdAt: adSets.createdAt,
        })
        .from(adSets)
        .leftJoin(adCreatives, eq(adSets.adCreativeId, adCreatives.id))
        .leftJoin(landingPageVersions, eq(adSets.landingPageVersionId, landingPageVersions.id))
        .leftJoin(landingPages, eq(landingPageVersions.landingPageId, landingPages.id))
        .where(
          and(
            eq(adSets.campaignConfigId, input.campaignConfigId),
            eq(adSets.organizationId, ctx.organizationId),
          ),
        )
        .orderBy(desc(adSets.createdAt));
    }),

  listByCreative: protectedProcedure
    .input(z.object({ adCreativeId: z.string() }))
    .query(async ({ input, ctx }) => {
      return db
        .select({
          id: adSets.id,
          name: adSets.name,
          campaignConfigId: adSets.campaignConfigId,
          campaignConfigName: campaignConfigs.name,
          notes: adSets.notes,
          createdAt: adSets.createdAt,
        })
        .from(adSets)
        .leftJoin(campaignConfigs, eq(adSets.campaignConfigId, campaignConfigs.id))
        .where(
          and(
            eq(adSets.adCreativeId, input.adCreativeId),
            eq(adSets.organizationId, ctx.organizationId),
          ),
        )
        .orderBy(desc(adSets.createdAt));
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [adSet] = await db
        .select({
          id: adSets.id,
          name: adSets.name,
          adCreativeId: adSets.adCreativeId,
          adCreativeName: adCreatives.name,
          landingPageVersionId: adSets.landingPageVersionId,
          landingPageName: landingPages.name,
          landingPageVersion: landingPageVersions.version,
          campaignConfigId: adSets.campaignConfigId,
          campaignConfigName: campaignConfigs.name,
          notes: adSets.notes,
          createdBy: adSets.createdBy,
          createdAt: adSets.createdAt,
          updatedAt: adSets.updatedAt,
        })
        .from(adSets)
        .leftJoin(adCreatives, eq(adSets.adCreativeId, adCreatives.id))
        .leftJoin(
          landingPageVersions,
          eq(adSets.landingPageVersionId, landingPageVersions.id),
        )
        .leftJoin(
          landingPages,
          eq(landingPageVersions.landingPageId, landingPages.id),
        )
        .leftJoin(
          campaignConfigs,
          eq(adSets.campaignConfigId, campaignConfigs.id),
        )
        .where(and(eq(adSets.id, input.id), eq(adSets.organizationId, ctx.organizationId)));
      if (!adSet) throw new Error("Ad set not found");
      return adSet;
    }),

  create: protectedProcedure
    .input(z.object({ name: z.string().optional() }).optional())
    .mutation(async ({ input, ctx }) => {
      const [adSet] = await db
        .insert(adSets)
        .values({
          name: input?.name ?? "Untitled Ad Set",
          createdBy: ctx.session.user.id,
          organizationId: ctx.organizationId,
        })
        .returning();
      return adSet;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        adCreativeId: z.string().nullable().optional(),
        landingPageVersionId: z.string().nullable().optional(),
        campaignConfigId: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [adSet] = await db
        .update(adSets)
        .set(data)
        .where(and(eq(adSets.id, id), eq(adSets.organizationId, ctx.organizationId)))
        .returning();
      return adSet;
    }),

  duplicate: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(adSets)
        .where(and(eq(adSets.id, input.id), eq(adSets.organizationId, ctx.organizationId)));
      if (!source) throw new Error("Ad set not found");
      const [duplicate] = await db
        .insert(adSets)
        .values({
          name: `Copy of ${source.name}`,
          adCreativeId: source.adCreativeId,
          landingPageVersionId: source.landingPageVersionId,
          campaignConfigId: source.campaignConfigId,
          notes: source.notes,
          createdBy: ctx.session.user.id,
          organizationId: ctx.organizationId,
        })
        .returning();
      return duplicate;
    }),

  bulkImport: protectedProcedure
    .input(
      z.object({
        rows: z.array(
          z.object({
            name: z.string(),
            campaignName: z.string().optional(),
            campaignConfigId: z.string().optional(),
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
            dateStart: z.string(),
            dateEnd: z.string(),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const results: { adSetId: string; name: string }[] = [];
      // Cache campaign lookups
      const campaignCache = new Map<string, string>();

      for (const row of input.rows) {
        // Link to campaign: prefer explicit ID, fall back to name matching
        let campaignConfigId: string | undefined = row.campaignConfigId;
        if (!campaignConfigId && row.campaignName) {
          if (campaignCache.has(row.campaignName)) {
            campaignConfigId = campaignCache.get(row.campaignName);
          } else {
            const [existing] = await db
              .select({ id: campaignConfigs.id })
              .from(campaignConfigs)
              .where(
                and(
                  eq(campaignConfigs.name, row.campaignName),
                  eq(campaignConfigs.organizationId, ctx.organizationId),
                ),
              );
            if (existing) {
              campaignConfigId = existing.id;
              campaignCache.set(row.campaignName, existing.id);
            }
          }
        }

        const [adSet] = await db
          .insert(adSets)
          .values({
            name: row.name,
            campaignConfigId: campaignConfigId,
            createdBy: ctx.session.user.id,
            organizationId: ctx.organizationId,
          })
          .returning();

        const { name: _, campaignName: __, campaignConfigId: ___, ...perfData } = row;
        await db.insert(performanceLogs).values({
          ...perfData,
          adSetId: adSet.id,
          organizationId: ctx.organizationId,
        });

        results.push({ adSetId: adSet.id, name: adSet.name });
      }

      return results;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db.delete(adSets).where(and(eq(adSets.id, input.id), eq(adSets.organizationId, ctx.organizationId)));
    }),
});
