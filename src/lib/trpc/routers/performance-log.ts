import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { performanceLogs } from "@/schema/performance-log";

const perfFields = {
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
};

const perfFieldsNullable = {
  roas: z.string().nullable().optional(),
  cpa: z.string().nullable().optional(),
  ctr: z.string().nullable().optional(),
  conversionRate: z.string().nullable().optional(),
  spend: z.string().nullable().optional(),
  conversions: z.number().int().nullable().optional(),
  impressions: z.number().int().nullable().optional(),
  reach: z.number().int().nullable().optional(),
  frequency: z.string().nullable().optional(),
  cpm: z.string().nullable().optional(),
  qualityRanking: z.string().nullable().optional(),
  engagementRateRanking: z.string().nullable().optional(),
  conversionRateRanking: z.string().nullable().optional(),
};

export const performanceLogRouter = router({
  listAll: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select()
      .from(performanceLogs)
      .where(eq(performanceLogs.organizationId, ctx.organizationId))
      .orderBy(desc(performanceLogs.dateStart));
  }),

  listByAdSet: protectedProcedure
    .input(z.object({ adSetId: z.string() }))
    .query(async ({ input, ctx }) => {
      return db
        .select()
        .from(performanceLogs)
        .where(and(eq(performanceLogs.adSetId, input.adSetId), eq(performanceLogs.organizationId, ctx.organizationId)))
        .orderBy(desc(performanceLogs.dateStart));
    }),

  create: protectedProcedure
    .input(
      z.object({
        adSetId: z.string(),
        dateStart: z.string(),
        dateEnd: z.string(),
        ...perfFields,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [log] = await db
        .insert(performanceLogs)
        .values({ ...input, organizationId: ctx.organizationId })
        .returning();
      return log;
    }),

  bulkCreate: protectedProcedure
    .input(
      z.object({
        adSetId: z.string(),
        rows: z.array(
          z.object({
            dateStart: z.string(),
            dateEnd: z.string(),
            ...perfFields,
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.rows.length === 0) return [];
      const values = input.rows.map((row) => ({
        ...row,
        adSetId: input.adSetId,
        organizationId: ctx.organizationId,
      }));
      return db.insert(performanceLogs).values(values).returning();
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        dateStart: z.string().optional(),
        dateEnd: z.string().optional(),
        ...perfFieldsNullable,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [log] = await db
        .update(performanceLogs)
        .set(data)
        .where(and(eq(performanceLogs.id, id), eq(performanceLogs.organizationId, ctx.organizationId)))
        .returning();
      return log;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(performanceLogs)
        .where(and(eq(performanceLogs.id, input.id), eq(performanceLogs.organizationId, ctx.organizationId)));
    }),
});
