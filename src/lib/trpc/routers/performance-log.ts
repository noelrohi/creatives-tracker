import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { performanceLogs } from "@/schema/performance-log";

export const performanceLogRouter = router({
  listByAdSet: protectedProcedure
    .input(z.object({ adSetId: z.string() }))
    .query(async ({ input }) => {
      return db
        .select()
        .from(performanceLogs)
        .where(eq(performanceLogs.adSetId, input.adSetId))
        .orderBy(desc(performanceLogs.dateStart));
    }),

  create: protectedProcedure
    .input(
      z.object({
        adSetId: z.string(),
        roas: z.string().optional(),
        cpa: z.string().optional(),
        ctr: z.string().optional(),
        conversionRate: z.string().optional(),
        spend: z.string().optional(),
        conversions: z.number().int().optional(),
        dateStart: z.string(),
        dateEnd: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const [log] = await db
        .insert(performanceLogs)
        .values(input)
        .returning();
      return log;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        roas: z.string().nullable().optional(),
        cpa: z.string().nullable().optional(),
        ctr: z.string().nullable().optional(),
        conversionRate: z.string().nullable().optional(),
        spend: z.string().nullable().optional(),
        conversions: z.number().int().nullable().optional(),
        dateStart: z.string().optional(),
        dateEnd: z.string().optional(),
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

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .delete(performanceLogs)
        .where(eq(performanceLogs.id, input.id));
    }),
});
