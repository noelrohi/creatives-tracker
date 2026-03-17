import { z } from "zod";
import { eq, desc, ilike, and, type SQL } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { landingPages } from "@/schema/landing-page";

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
          createdBy: adCreatives.createdBy,
          createdAt: adCreatives.createdAt,
          updatedAt: adCreatives.updatedAt,
        })
        .from(adCreatives)
        .leftJoin(landingPages, eq(adCreatives.landingPageId, landingPages.id))
        .where(eq(adCreatives.id, input.id));
      if (!creative) throw new Error("Ad creative not found");
      return creative;
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        assetUrl: z.string().optional(),
        format: z.enum(["static", "video", "ugc", "carousel"]),
        angle: z.string().min(1),
        persona: z.string().min(1),
        awarenessLevel: z.enum([
          "unaware",
          "problem_aware",
          "solution_aware",
          "product_aware",
          "most_aware",
        ]),
        hook: z.string().min(1),
        tone: z.array(z.string()).min(1),
        cta: z.string().min(1),
        landingPageId: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [creative] = await db
        .insert(adCreatives)
        .values({ ...input, createdBy: ctx.session.user.id })
        .returning();
      return creative;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        assetUrl: z.string().optional(),
        format: z.enum(["static", "video", "ugc", "carousel"]).optional(),
        angle: z.string().min(1).optional(),
        persona: z.string().min(1).optional(),
        awarenessLevel: z
          .enum([
            "unaware",
            "problem_aware",
            "solution_aware",
            "product_aware",
            "most_aware",
          ])
          .optional(),
        hook: z.string().min(1).optional(),
        tone: z.array(z.string()).optional(),
        cta: z.string().min(1).optional(),
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

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.delete(adCreatives).where(eq(adCreatives.id, input.id));
    }),
});
