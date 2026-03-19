import { z } from "zod";
import { eq, desc, ilike, and, type SQL } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { landingPages } from "@/schema/landing-page";
import { adSets } from "@/schema/ad-set";
import { performanceLogs } from "@/schema/performance-log";

export const adCreativeRouter = router({
  list: protectedProcedure
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
    .query(async ({ input, ctx }) => {
      const conditions: SQL[] = [eq(adCreatives.organizationId, ctx.organizationId)];
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
          createdBy: adCreatives.createdBy,
          createdAt: adCreatives.createdAt,
          updatedAt: adCreatives.updatedAt,
        })
        .from(adCreatives)
        .leftJoin(landingPages, eq(adCreatives.landingPageId, landingPages.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(adCreatives.createdAt));
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
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
          createdBy: adCreatives.createdBy,
          createdAt: adCreatives.createdAt,
          updatedAt: adCreatives.updatedAt,
        })
        .from(adCreatives)
        .leftJoin(landingPages, eq(adCreatives.landingPageId, landingPages.id))
        .where(and(eq(adCreatives.id, input.id), eq(adCreatives.organizationId, ctx.organizationId)));
      if (!creative) throw new Error("Ad creative not found");
      return creative;
    }),

  create: protectedProcedure
    .input(z.object({ name: z.string().optional() }).optional())
    .mutation(async ({ input, ctx }) => {
      const [creative] = await db
        .insert(adCreatives)
        .values({
          name: input?.name ?? "Untitled Creative",
          createdBy: ctx.session.user.id,
          organizationId: ctx.organizationId,
        })
        .returning();
      return creative;
    }),

  update: protectedProcedure
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
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [creative] = await db
        .update(adCreatives)
        .set(data)
        .where(and(eq(adCreatives.id, id), eq(adCreatives.organizationId, ctx.organizationId)))
        .returning();
      return creative;
    }),

  duplicate: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(adCreatives)
        .where(and(eq(adCreatives.id, input.id), eq(adCreatives.organizationId, ctx.organizationId)));
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
            adSetName: z.string().optional(),
            adSetId: z.string().optional(),
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
      const results: { id: string; name: string }[] = [];
      // Cache ad set lookups: name → { adSetId, existed }
      const adSetCache = new Map<string, string>();

      for (const row of input.rows) {
        // Create the ad creative
        const [creative] = await db
          .insert(adCreatives)
          .values({
            name: row.name,
            createdBy: ctx.session.user.id,
            organizationId: ctx.organizationId,
          })
          .returning();

        // Find or create matching ad set — prefer explicit ID
        const targetAdSetName = row.adSetName;
        const explicitAdSetId = row.adSetId;
        if (explicitAdSetId || targetAdSetName) {
          let adSetId = explicitAdSetId || (targetAdSetName ? adSetCache.get(targetAdSetName) : undefined);
          if (!adSetId && targetAdSetName) {
            const [existing] = await db
              .select({ id: adSets.id })
              .from(adSets)
              .where(
                and(
                  eq(adSets.name, targetAdSetName),
                  eq(adSets.organizationId, ctx.organizationId),
                ),
              );
            if (existing) {
              adSetId = existing.id;
            } else {
              // Create ad set for this group
              const [newAdSet] = await db
                .insert(adSets)
                .values({
                  name: targetAdSetName,
                  adCreativeId: creative.id,
                  createdBy: ctx.session.user.id,
                  organizationId: ctx.organizationId,
                })
                .returning();
              adSetId = newAdSet.id;
            }
            if (targetAdSetName) adSetCache.set(targetAdSetName, adSetId);
          }

          // Create performance log on the ad set
          if (adSetId) {
            const { name: _, adSetName: __, adSetId: ___, ...perfData } = row;
            const hasPerf = perfData.spend || perfData.roas || perfData.conversions;
            if (hasPerf) {
              await db.insert(performanceLogs).values({
                ...perfData,
                adSetId,
                organizationId: ctx.organizationId,
              });
            }
          }
        }

        results.push({ id: creative.id, name: creative.name });
      }
      return results;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db.delete(adCreatives).where(and(eq(adCreatives.id, input.id), eq(adCreatives.organizationId, ctx.organizationId)));
    }),
});
