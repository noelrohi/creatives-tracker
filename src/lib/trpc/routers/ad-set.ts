import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { adSets } from "@/schema/ad-set";
import { adCreatives } from "@/schema/ad-creative";
import { landingPageVersions, landingPages } from "@/schema/landing-page";
import { campaignConfigs } from "@/schema/campaign-config";

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

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db.delete(adSets).where(and(eq(adSets.id, input.id), eq(adSets.organizationId, ctx.organizationId)));
    }),
});
