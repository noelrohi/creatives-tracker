import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
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
  listAll: baseProcedure
    .meta(openApiQueryMeta("performanceLog", "listAll"))
    .query(async () => {
    return db
      .select()
      .from(performanceLogs)
      .orderBy(desc(performanceLogs.dateStart));
  }),

  listByAd: baseProcedure
    .meta(openApiQueryMeta("performanceLog", "listByAd"))
    .input(z.object({ adId: z.string() }))
    .query(async ({ input }) => {
      return db
        .select()
        .from(performanceLogs)
        .where(eq(performanceLogs.adId, input.adId))
        .orderBy(desc(performanceLogs.dateStart));
    }),

  create: baseProcedure
    .meta(openApiMutationMeta("performanceLog", "create"))
    .input(
      z.object({
        adId: z.string(),
        dateStart: z.string(),
        dateEnd: z.string(),
        ...perfFields,
      }),
    )
    .mutation(async ({ input }) => {
      const [log] = await db
        .insert(performanceLogs)
        .values(input)
        .returning();
      return log;
    }),

  bulkCreate: baseProcedure
    .meta(openApiMutationMeta("performanceLog", "bulkCreate"))
    .input(
      z.object({
        adId: z.string(),
        rows: z.array(
          z.object({
            dateStart: z.string(),
            dateEnd: z.string(),
            ...perfFields,
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.rows.length === 0) return [];
      const values = input.rows.map((row) => ({
        ...row,
        adId: input.adId,
      }));
      return db.insert(performanceLogs).values(values).returning();
    }),

  update: baseProcedure
    .meta(openApiMutationMeta("performanceLog", "update"))
    .input(
      z.object({
        id: z.string(),
        dateStart: z.string().optional(),
        dateEnd: z.string().optional(),
        ...perfFieldsNullable,
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const [log] = await db
        .update(performanceLogs)
        .set(data)
        .where(eq(performanceLogs.id, id))
        .returning();
      return log;
    }),

  delete: baseProcedure
    .meta(openApiMutationMeta("performanceLog", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .delete(performanceLogs)
        .where(eq(performanceLogs.id, input.id));
    }),
});
