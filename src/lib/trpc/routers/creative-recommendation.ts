import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  baseProcedure,
  featureEnabled,
  organizationRequired,
  router,
  writeAccessRequired,
} from "../init";
import { db } from "@/db";
import { creativeVariantBatches, creativeVariants } from "@/schema/creative-recommendation";
import {
  findEligibleWinnerCandidates,
  listApprovedCreativeVariants,
} from "@/lib/creative-recommendation-candidates";
import {
  CREATIVE_VARIANT_PROMPT_VERSION,
  generateCreativeVariants,
  hasCreativeVariantAiConfig,
} from "@/lib/creative-recommendations";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const windowInput = z
  .object({
    from: dateString,
    to: dateString,
    accountId: z.string().optional(),
    teamId: z.string().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.from > input.to) {
      ctx.addIssue({
        code: "custom",
        message: "from must be before or equal to to",
        path: ["from"],
      });
    }
  });

const reviewStatusSchema = z.enum(["good", "bad"]);
const recommendationsBaseProcedure = baseProcedure.use(featureEnabled("recommendations"));
const recommendationsOrgProcedure = recommendationsBaseProcedure.use(organizationRequired);
const recommendationsOrgWriteProcedure = recommendationsBaseProcedure.use(writeAccessRequired);

export const creativeRecommendationRouter = router({
  listCandidates: recommendationsOrgProcedure.input(windowInput).query(async ({ input, ctx }) => {
    return findEligibleWinnerCandidates({
      organizationId: ctx.organizationId,
      from: input.from,
      to: input.to,
      accountId: input.accountId,
      teamId: input.teamId,
    });
  }),

  generateVariants: recommendationsOrgWriteProcedure
    .input(
      windowInput.extend({
        sourceCreativeId: z.string().min(1),
        sourceAdId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (!hasCreativeVariantAiConfig()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "OPENAI_API_KEY is required to generate variants.",
        });
      }

      const [candidate] = await findEligibleWinnerCandidates({
        organizationId: ctx.organizationId,
        from: input.from,
        to: input.to,
        accountId: input.accountId,
        teamId: input.teamId,
        sourceCreativeId: input.sourceCreativeId,
        sourceAdId: input.sourceAdId,
      });

      if (!candidate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No eligible static winner was found for this creative in the selected window.",
        });
      }

      const generation = await generateCreativeVariants({
        source: candidate.sourceSnapshot,
        performance: candidate.performanceSnapshot,
      }).catch((error) => {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error
            ? `Variant generation failed: ${error.message}`
            : "Variant generation failed.",
        });
      });

      return db.transaction(async (tx) => {
        const [batch] = await tx
          .insert(creativeVariantBatches)
          .values({
            organizationId: ctx.organizationId,
            sourceCreativeId: candidate.sourceCreativeId,
            sourceAdId: candidate.sourceAdId,
            windowFrom: input.from,
            windowTo: input.to,
            model: generation.model,
            promptVersion: CREATIVE_VARIANT_PROMPT_VERSION,
            sourceSnapshot: candidate.sourceSnapshot,
            performanceSnapshot: candidate.performanceSnapshot,
            generatedCount: generation.variants.length,
            createdByUserId: ctx.userId,
          })
          .returning();

        const variants = await tx
          .insert(creativeVariants)
          .values(
            generation.variants.map((copy, index) => ({
              batchId: batch.id,
              organizationId: ctx.organizationId,
              position: index + 1,
              copy,
            })),
          )
          .returning();

        return { ...batch, variants };
      });
    }),

  listApprovedVariants: recommendationsOrgProcedure.query(async ({ ctx }) => {
    return listApprovedCreativeVariants(ctx.organizationId);
  }),

  reviewVariant: recommendationsOrgWriteProcedure
    .input(
      z.object({
        variantId: z.string().min(1),
        status: reviewStatusSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [variant] = await db
        .update(creativeVariants)
        .set({
          status: input.status,
          reviewedAt: new Date(),
          reviewedByUserId: ctx.userId,
        })
        .where(
          and(
            eq(creativeVariants.id, input.variantId),
            eq(creativeVariants.organizationId, ctx.organizationId),
          ),
        )
        .returning();

      if (!variant) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Variant not found.",
        });
      }

      return variant;
    }),
});
