import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { router, baseProcedure } from "../init";
import { db } from "@/db";
import { abTests, abTestVariants } from "@/schema/ab-test";
import { ads } from "@/schema/ad";

export const abTestRouter = router({
  list: baseProcedure.query(async () => {
    const tests = await db
      .select()
      .from(abTests)
      .orderBy(desc(abTests.createdAt));

    // Fetch variant counts
    const testsWithCounts = await Promise.all(
      tests.map(async (test) => {
        const variants = await db
          .select({ id: abTestVariants.id })
          .from(abTestVariants)
          .where(eq(abTestVariants.abTestId, test.id));
        return { ...test, variantCount: variants.length };
      }),
    );

    return testsWithCounts;
  }),

  getById: baseProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [test] = await db
        .select()
        .from(abTests)
        .where(eq(abTests.id, input.id));
      if (!test) throw new Error("A/B test not found");

      const variants = await db
        .select({
          id: abTestVariants.id,
          adId: abTestVariants.adId,
          label: abTestVariants.label,
          adName: ads.name,
        })
        .from(abTestVariants)
        .innerJoin(ads, eq(abTestVariants.adId, ads.id))
        .where(eq(abTestVariants.abTestId, input.id))
        .orderBy(abTestVariants.createdAt);

      return { ...test, variants };
    }),

  create: baseProcedure
    .input(
      z
        .object({
          name: z.string().optional(),
          hypothesis: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) => {
      const [test] = await db
        .insert(abTests)
        .values({
          name: input?.name || "Untitled Test",
          hypothesis: input?.hypothesis,
        })
        .returning();
      return test;
    }),

  update: baseProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        hypothesis: z.string().nullable().optional(),
        status: z.enum(["running", "completed", "paused"]).optional(),
        winnerVariantId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const [test] = await db
        .update(abTests)
        .set(data)
        .where(eq(abTests.id, id))
        .returning();
      return test;
    }),

  delete: baseProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .delete(abTests)
        .where(eq(abTests.id, input.id));
    }),

  addVariant: baseProcedure
    .input(
      z.object({
        abTestId: z.string(),
        adId: z.string(),
        label: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const [variant] = await db
        .insert(abTestVariants)
        .values({
          abTestId: input.abTestId,
          adId: input.adId,
          label: input.label,
        })
        .returning();
      return variant;
    }),

  removeVariant: baseProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .delete(abTestVariants)
        .where(eq(abTestVariants.id, input.id));
    }),
});
