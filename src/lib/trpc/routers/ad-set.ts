import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { adSets } from "@/schema/ad-set";
import { adCreatives } from "@/schema/ad-creative";
import { landingPageVersions, landingPages } from "@/schema/landing-page";
import { campaignConfigs } from "@/schema/campaign-config";

export const adSetRouter = router({
  list: protectedProcedure.query(async () => {
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
      .orderBy(desc(adSets.createdAt));
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
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
        .where(eq(adSets.id, input.id));
      if (!adSet) throw new Error("Ad set not found");
      return adSet;
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        adCreativeId: z.string(),
        landingPageVersionId: z.string(),
        campaignConfigId: z.string(),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [adSet] = await db
        .insert(adSets)
        .values({ ...input, createdBy: ctx.session.user.id })
        .returning();
      return adSet;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        adCreativeId: z.string().optional(),
        landingPageVersionId: z.string().optional(),
        campaignConfigId: z.string().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const [adSet] = await db
        .update(adSets)
        .set(data)
        .where(eq(adSets.id, id))
        .returning();
      return adSet;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.delete(adSets).where(eq(adSets.id, input.id));
    }),
});
