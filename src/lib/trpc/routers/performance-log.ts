import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { router, orgProcedure } from "../init";
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
  listAll: orgProcedure
    .meta(openApiQueryMeta("performanceLog", "listAll"))
    .query(async ({ ctx }) => {
    return db
      .select()
      .from(performanceLogs)
      .where(eq(performanceLogs.organizationId, ctx.organizationId))
      .orderBy(desc(performanceLogs.dateStart));
  }),

  listByAd: orgProcedure
    .meta(openApiQueryMeta("performanceLog", "listByAd"))
    .input(z.object({ adId: z.string() }))
    .query(async ({ input, ctx }) => {
      return db
        .select()
        .from(performanceLogs)
        .where(and(eq(performanceLogs.adId, input.adId), eq(performanceLogs.organizationId, ctx.organizationId)))
        .orderBy(desc(performanceLogs.dateStart));
    }),

  create: orgProcedure
    .meta(openApiMutationMeta("performanceLog", "create"))
    .input(
      z.object({
        adId: z.string(),
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

  bulkCreate: orgProcedure
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
    .mutation(async ({ input, ctx }) => {
      if (input.rows.length === 0) return [];
      const values = input.rows.map((row) => ({
        ...row,
        adId: input.adId,
        organizationId: ctx.organizationId,
      }));
      return db.insert(performanceLogs).values(values).returning();
    }),

  update: orgProcedure
    .meta(openApiMutationMeta("performanceLog", "update"))
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

  delete: orgProcedure
    .meta(openApiMutationMeta("performanceLog", "delete"))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(performanceLogs)
        .where(and(eq(performanceLogs.id, input.id), eq(performanceLogs.organizationId, ctx.organizationId)));
    }),
});
