import { z } from "zod";
import { auth as triggerAuth } from "@trigger.dev/sdk";
import type { TRPCRouterRecord } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import type { VariationAttempt, VariationPlan } from "@/lib/variation-agent-types";
import { studioGenerations, studioVariants } from "@/schema/studio";
import { openApiMutationMeta, openApiQueryMeta } from "../openapi-meta";
import {
  createVariationGeneration,
  reconcileStaleGenerations,
  studioProcedure,
  studioWriteProcedure,
} from "./studio.shared";

const realtimeSchema = z
  .object({ runId: z.string(), publicAccessToken: z.string() })
  .nullable();

const variationListItemSchema = z.object({
  id: z.string(),
  status: z.string(),
  note: z.string().nullable(),
  format: z.string(),
  createdAt: z.date(),
  variant: z.object({
    id: z.string(),
    status: z.string(),
    imageUrl: z.string().nullable(),
    plan: z.custom<VariationPlan>().nullable(),
    attempts: z.custom<VariationAttempt[]>().nullable(),
    mark: z.string().nullable(),
    publishedAt: z.date().nullable(),
    moderationReason: z.string().nullable(),
  }),
  realtime: realtimeSchema,
});

async function realtimeFor(status: string, runId: string | null) {
  if (status !== "generating" || !runId) return null;
  return {
    runId,
    publicAccessToken: await triggerAuth.createPublicToken({
      scopes: { read: { runs: [runId] } },
      expirationTime: "1h",
    }),
  };
}

export const studioVariationProcedures = {
  variations: {
    create: studioWriteProcedure
      .meta(openApiMutationMeta(
        "studio", "variations.create", "Queue one variation of a static creative",
        "Runs the variation agent against the org's context library and returns the generation, its single variant, and a run-scoped realtime token. Poll variations.listForCreative; polling is canonical.",
      ))
      .input(z.object({ sourceCreativeId: z.string(), note: z.string().max(500).optional() }))
      .output(z.object({
        generationId: z.string(),
        variantId: z.string(),
        // A freshly queued run always has a run id, so this token is never null.
        realtime: realtimeSchema.unwrap(),
      }))
      .mutation(async ({ input, ctx }) => {
        const queued = await createVariationGeneration(ctx.organizationId, input);
        return {
          generationId: queued.generationId,
          variantId: queued.variantId,
          realtime: {
            runId: queued.runId,
            publicAccessToken: await triggerAuth.createPublicToken({
              scopes: { read: { runs: [queued.runId] } },
              expirationTime: "1h",
            }),
          },
        };
      }),

    listForCreative: studioProcedure
      .meta(openApiQueryMeta(
        "studio", "variations.listForCreative", "List variations of a creative",
        "Variation generations for one source creative, newest first, each with its single variant and a realtime token while generating.",
      ))
      .input(z.object({ creativeId: z.string() }))
      .output(z.array(variationListItemSchema))
      .query(async ({ input, ctx }) => {
        const rows = await db
          .select({
            id: studioGenerations.id,
            status: studioGenerations.status,
            runId: studioGenerations.runId,
            note: studioGenerations.note,
            format: studioGenerations.format,
            createdAt: studioGenerations.createdAt,
            updatedAt: studioGenerations.updatedAt,
            variantId: studioVariants.id,
            variantStatus: studioVariants.status,
            imageUrl: studioVariants.imageUrl,
            plan: studioVariants.plan,
            attempts: studioVariants.attempts,
            mark: studioVariants.mark,
            publishedAt: studioVariants.publishedAt,
            moderationReason: studioVariants.moderationReason,
          })
          .from(studioGenerations)
          .innerJoin(
            studioVariants,
            and(
              eq(studioVariants.generationId, studioGenerations.id),
              eq(studioVariants.organizationId, ctx.organizationId),
            ),
          )
          .where(
            and(
              eq(studioGenerations.organizationId, ctx.organizationId),
              eq(studioGenerations.kind, "variation"),
              eq(studioGenerations.sourceCreativeId, input.creativeId),
            ),
          )
          .orderBy(desc(studioGenerations.createdAt))
          .limit(100);
        const staleIds = new Set(
          await reconcileStaleGenerations(ctx.organizationId, rows),
        );
        return Promise.all(
          rows.map(async (row) => {
            const status = staleIds.has(row.id) ? "failed" : row.status;
            return {
              id: row.id,
              status,
              note: row.note,
              format: row.format,
              createdAt: row.createdAt,
              variant: {
                id: row.variantId,
                status: staleIds.has(row.id) ? "failed" : row.variantStatus,
                imageUrl: row.imageUrl,
                plan: row.plan,
                attempts: row.attempts,
                mark: row.mark,
                publishedAt: row.publishedAt,
                moderationReason: row.moderationReason,
              },
              realtime: await realtimeFor(status, row.runId),
            };
          }),
        );
      }),
  },
} satisfies TRPCRouterRecord;
