import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { router, protectedProcedure } from "../init";
import { db } from "@/db";
import { abTests, abTestVariants } from "@/schema/ab-test";
import { adSets } from "@/schema/ad-set";

export const abTestRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const tests = await db
      .select()
      .from(abTests)
      .where(eq(abTests.organizationId, ctx.organizationId))
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

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [test] = await db
        .select()
        .from(abTests)
        .where(
          and(
            eq(abTests.id, input.id),
            eq(abTests.organizationId, ctx.organizationId),
          ),
        );
      if (!test) throw new Error("A/B test not found");

      const variants = await db
        .select({
          id: abTestVariants.id,
          adSetId: abTestVariants.adSetId,
          label: abTestVariants.label,
          adSetName: adSets.name,
        })
        .from(abTestVariants)
        .innerJoin(adSets, eq(abTestVariants.adSetId, adSets.id))
        .where(eq(abTestVariants.abTestId, input.id))
        .orderBy(abTestVariants.createdAt);

      return { ...test, variants };
    }),

  create: protectedProcedure
    .input(
      z
        .object({
          name: z.string().optional(),
          hypothesis: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ input, ctx }) => {
      const [test] = await db
        .insert(abTests)
        .values({
          name: input?.name || "Untitled Test",
          hypothesis: input?.hypothesis,
          createdBy: ctx.session.user.id,
          organizationId: ctx.organizationId,
        })
        .returning();
      return test;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        hypothesis: z.string().nullable().optional(),
        status: z.enum(["running", "completed", "paused"]).optional(),
        winnerVariantId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const [test] = await db
        .update(abTests)
        .set(data)
        .where(
          and(
            eq(abTests.id, id),
            eq(abTests.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      return test;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(abTests)
        .where(
          and(
            eq(abTests.id, input.id),
            eq(abTests.organizationId, ctx.organizationId),
          ),
        );
    }),

  addVariant: protectedProcedure
    .input(
      z.object({
        abTestId: z.string(),
        adSetId: z.string(),
        label: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [variant] = await db
        .insert(abTestVariants)
        .values({
          abTestId: input.abTestId,
          adSetId: input.adSetId,
          label: input.label,
          organizationId: ctx.organizationId,
        })
        .returning();
      return variant;
    }),

  removeVariant: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .delete(abTestVariants)
        .where(
          and(
            eq(abTestVariants.id, input.id),
            eq(abTestVariants.organizationId, ctx.organizationId),
          ),
        );
    }),
});
