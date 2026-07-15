import { z } from "zod";
import { auth as triggerAuth, tasks } from "@trigger.dev/sdk";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  openApiMutationMeta,
  openApiQueryMeta,
} from "../openapi-meta";
import {
  studioCopyPackages,
  studioGenerations,
  studioSuggestionRuns,
  studioSuggestions,
  studioSwipes,
  studioVariants,
} from "@/schema/studio";
import type { generateStudioSuggestionsTask } from "../../../../trigger/generate-studio-suggestions";
import {
  fetchSourceCreatives,
  queueClaimedSuggestion,
  queuedGenerationSchema,
  remoteImageUrlSchema,
  sourceCreativeSummarySchema,
  startOfStudioWeek,
  studioCopyPackageRowSchema,
  studioFormatSchema,
  studioProcedure,
  studioSuggestionRowSchema,
  studioVariantRowSchema,
  studioWriteProcedure,
} from "./studio.shared";

const latestSuggestionRunSchema = z.object({
  id: z.string(),
  status: z.enum(["triggered", "completed", "failed"]),
  errorSummary: z.string().nullable(),
  cardCount: z.number().int().nullable(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
});

const homeSchema = z.object({
  cards: z.array(
    studioSuggestionRowSchema.extend({
      source: sourceCreativeSummarySchema.nullable(),
      swipe: z.object({
        id: z.string(),
        imageUrl: z.string(),
        brandName: z.string().nullable(),
        createdAt: z.date(),
      }).nullable(),
      copyPackage: studioCopyPackageRowSchema.nullable(),
      generationStatus: z.string().nullable(),
    }),
  ),
  library: z.array(studioVariantRowSchema.pick({
    id: true,
    generationId: true,
    status: true,
    imageUrl: true,
    mark: true,
    publishedAt: true,
    moderationReason: true,
    copyPackageId: true,
    createdAt: true,
  })),
  expiredCount: z.number().int(),
  droppedWatch: z.number().int(),
  generatedAt: z.date().nullable(),
  latestRun: latestSuggestionRunSchema.nullable(),
});

const suggestionsSchema = z.object({
  cards: z.array(studioSuggestionRowSchema),
  generatedAt: z.date().nullable(),
  isRefreshing: z.boolean(),
  latestRun: latestSuggestionRunSchema.nullable(),
});

async function fetchLatestSuggestionRun(organizationId: string) {
  const [latestRun] = await db
    .select({
      id: studioSuggestionRuns.id,
      status: studioSuggestionRuns.status,
      errorSummary: studioSuggestionRuns.errorSummary,
      cardCount: studioSuggestionRuns.cardCount,
      createdAt: studioSuggestionRuns.createdAt,
      completedAt: studioSuggestionRuns.completedAt,
    })
    .from(studioSuggestionRuns)
    .where(eq(studioSuggestionRuns.organizationId, organizationId))
    .orderBy(desc(studioSuggestionRuns.createdAt))
    .limit(1);
  return latestRun ?? null;
}

function errorSummary(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const studioSuggestionProcedures = {
  home: studioProcedure
    .meta(openApiQueryMeta(
      "studio",
      "home",
      "Get the Image Studio home queue",
      "Returns this week's suggestion cards, recent generated images, and latestRun. Suggestions follow a weekly cadence; poll latestRun after a Monday refresh until its status is completed or failed.",
    ))
    .output(homeSchema)
    .query(async ({ ctx }) => {
    const cards = await db
      .select()
      .from(studioSuggestions)
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          or(
            and(
              inArray(studioSuggestions.status, [
                "proposed",
                "approved",
                "skipped",
              ]),
              gte(studioSuggestions.createdAt, startOfStudioWeek()),
            ),
            // Kept watch-list items outlive the week window: they wait until
            // Monday's refresh promotes or drops them.
            and(
              eq(studioSuggestions.status, "proposed"),
              eq(studioSuggestions.evidence, "thin"),
            ),
          ),
        ),
      )
      .orderBy(desc(studioSuggestions.createdAt))
      .limit(30);
    const sources = await fetchSourceCreatives(
      ctx.organizationId,
      cards.flatMap((card) => (card.sourceCreativeId ? [card.sourceCreativeId] : [])),
    );
    const swipeIds = cards.flatMap((card) => (card.swipeId ? [card.swipeId] : []));
    const swipes = swipeIds.length
      ? await db
          .select({
            id: studioSwipes.id,
            imageUrl: studioSwipes.imageUrl,
            brandName: studioSwipes.brandName,
            createdAt: studioSwipes.createdAt,
          })
          .from(studioSwipes)
          .where(
            and(
              eq(studioSwipes.organizationId, ctx.organizationId),
              inArray(studioSwipes.id, swipeIds),
            ),
          )
      : [];
    const swipesById = new Map(swipes.map((swipe) => [swipe.id, swipe]));
    const packageIds = cards.flatMap((card) =>
      card.copyPackageId ? [card.copyPackageId] : [],
    );
    const packages = packageIds.length
      ? await db
          .select()
          .from(studioCopyPackages)
          .where(
            and(
              eq(studioCopyPackages.organizationId, ctx.organizationId),
              inArray(studioCopyPackages.id, packageIds),
            ),
          )
      : [];
    const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]));
    const cardGenerationIds = cards.flatMap((card) =>
      card.generationId ? [card.generationId] : [],
    );
    const cardGenerations = cardGenerationIds.length
      ? await db
          .select({
            id: studioGenerations.id,
            status: studioGenerations.status,
          })
          .from(studioGenerations)
          .where(
            and(
              eq(studioGenerations.organizationId, ctx.organizationId),
              inArray(studioGenerations.id, cardGenerationIds),
            ),
          )
      : [];
    const generationStatusById = new Map(
      cardGenerations.map((generation) => [generation.id, generation.status]),
    );
    const recentGenerations = await db
      .select({ id: studioGenerations.id })
      .from(studioGenerations)
      .where(eq(studioGenerations.organizationId, ctx.organizationId))
      .orderBy(desc(studioGenerations.createdAt))
      .limit(8);
    const generationIds = recentGenerations.map((row) => row.id);
    const library = generationIds.length
      ? await db
          .select({
            id: studioVariants.id,
            generationId: studioVariants.generationId,
            status: studioVariants.status,
            imageUrl: studioVariants.imageUrl,
            mark: studioVariants.mark,
            publishedAt: studioVariants.publishedAt,
            moderationReason: studioVariants.moderationReason,
            copyPackageId: studioVariants.copyPackageId,
            createdAt: studioVariants.createdAt,
          })
          .from(studioVariants)
          .where(
            and(
              eq(studioVariants.organizationId, ctx.organizationId),
              inArray(studioVariants.generationId, generationIds),
            ),
          )
          .orderBy(desc(studioVariants.createdAt))
          .limit(8)
      : [];
    const expiredSince = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const expired = await db
      .select({
        id: studioSuggestions.id,
        evidence: studioSuggestions.evidence,
      })
      .from(studioSuggestions)
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          eq(studioSuggestions.status, "expired"),
          gte(studioSuggestions.updatedAt, expiredSince),
        ),
      );
    const latestRun = await fetchLatestSuggestionRun(ctx.organizationId);
    return {
      cards: cards.map((card) => ({
        ...card,
        source: card.sourceCreativeId ? sources.get(card.sourceCreativeId) ?? null : null,
        swipe: card.swipeId ? swipesById.get(card.swipeId) ?? null : null,
        copyPackage: card.copyPackageId
          ? packagesById.get(card.copyPackageId) ?? null
          : null,
        generationStatus: card.generationId
          ? generationStatusById.get(card.generationId) ?? null
          : null,
      })),
      library,
      // Watch-list drops are reported separately — keep them out of the
      // rotated-out count so the expiry note doesn't count them twice.
      expiredCount: expired.filter((card) => card.evidence !== "thin").length,
      droppedWatch: expired.filter((card) => card.evidence === "thin").length,
      generatedAt: cards[0]?.createdAt ?? null,
      latestRun,
    };
  }),

  /** Compatibility alias for callers that only need the queue cards. */
  suggestions: studioProcedure
    .meta(openApiQueryMeta(
      "studio",
      "suggestions",
      "List weekly Studio suggestions",
      "Lists the current weekly suggestion batch and latestRun. After a Monday refresh, poll until latestRun is completed or failed before acting on the fresh batch.",
    ))
    .output(suggestionsSchema)
    .query(async ({ ctx }) => {
    const cards = await db
      .select()
      .from(studioSuggestions)
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          or(
            and(
              inArray(studioSuggestions.status, [
                "proposed",
                "approved",
                "skipped",
              ]),
              gte(studioSuggestions.createdAt, startOfStudioWeek()),
            ),
            and(
              eq(studioSuggestions.status, "proposed"),
              eq(studioSuggestions.evidence, "thin"),
            ),
          ),
        ),
      )
      .orderBy(desc(studioSuggestions.createdAt));
    const latestRun = await fetchLatestSuggestionRun(ctx.organizationId);
    return {
      cards,
      generatedAt: cards[0]?.createdAt ?? null,
      isRefreshing: latestRun?.status === "triggered",
      latestRun,
    };
  }),

  refreshSuggestions: studioWriteProcedure
    .meta(openApiMutationMeta(
      "studio",
      "refreshSuggestions",
      "Refresh the weekly Studio suggestions",
      "Monday refresh semantics: expires unactioned non-thin proposals, starts a fresh weekly batch, and returns suggestionRunId. Poll home.latestRun until completed or failed; runId and publicAccessToken are an optional short-lived realtime upgrade.",
    ))
    .output(z.object({
      runId: z.string(),
      suggestionRunId: z.string(),
      publicAccessToken: z.string(),
      expiredCount: z.number().int(),
      skipped: z.literal(false),
    }))
    .mutation(async ({ ctx }) => {
    const expired = await db
      .update(studioSuggestions)
      .set({ status: "expired", actionedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          eq(studioSuggestions.status, "proposed"),
          isNull(studioSuggestions.evidence),
        ),
      )
      .returning({ id: studioSuggestions.id });
    const [suggestionRun] = await db
      .insert(studioSuggestionRuns)
      .values({ organizationId: ctx.organizationId })
      .returning({ id: studioSuggestionRuns.id });
    if (!suggestionRun) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not create suggestion refresh run",
      });
    }

    let handle: { id: string };
    try {
      handle = await tasks.trigger<typeof generateStudioSuggestionsTask>(
        "generate-studio-suggestions",
        {
          organizationId: ctx.organizationId,
          force: true,
          suggestionRunId: suggestionRun.id,
        },
      );
    } catch (error) {
      const completedAt = new Date();
      await db
        .update(studioSuggestionRuns)
        .set({
          status: "failed",
          errorSummary: errorSummary(error),
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(studioSuggestionRuns.id, suggestionRun.id));
      throw error;
    }
    await db
      .update(studioSuggestionRuns)
      .set({ triggerRunId: handle.id, updatedAt: new Date() })
      .where(eq(studioSuggestionRuns.id, suggestionRun.id));
    const publicAccessToken = await triggerAuth.createPublicToken({
      scopes: { read: { runs: [handle.id] } },
      expirationTime: "15m",
    });
    return {
      runId: handle.id,
      suggestionRunId: suggestionRun.id,
      publicAccessToken,
      expiredCount: expired.length,
      skipped: false as const,
    };
  }),

  setSuggestionStatus: studioWriteProcedure
    .meta(openApiMutationMeta(
      "studio",
      "setSuggestionStatus",
      "Approve or skip a Studio suggestion",
      "Records human or agent triage for a card in the current weekly suggestion batch; approval does not queue generation until approveSuggestion or generateApproved is called.",
    ))
    .input(
      z.object({
        suggestionId: z.string().optional(),
        variantId: z.string().optional(),
        status: z.enum(["approved", "skipped"]),
      }).refine((value) => value.suggestionId || value.variantId, "Suggestion id is required"),
    )
    .output(z.object({
      id: z.string(),
      status: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const id = input.suggestionId ?? input.variantId!;
      const now = new Date();
      const [updated] = await db
        .update(studioSuggestions)
        .set({
          status: input.status,
          actionedAt: now,
          claimedAt: input.status === "approved" ? undefined : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(studioSuggestions.id, id),
            eq(studioSuggestions.organizationId, ctx.organizationId),
            eq(studioSuggestions.status, "proposed"),
            isNull(studioSuggestions.generationId),
          ),
        )
        .returning({ id: studioSuggestions.id, status: studioSuggestions.status });
      if (!updated) {
        throw new TRPCError({ code: "CONFLICT", message: "This suggestion was already generated" });
      }
      return updated;
    }),

  approveSuggestion: studioWriteProcedure
    .meta(openApiMutationMeta(
      "studio",
      "approveSuggestion",
      "Approve and queue one Studio suggestion",
      "Claims one weekly suggestion and queues its generation. Poll generation by generationId until ready or failed; runId is only an optional realtime handle and polling is canonical.",
    ))
    .input(
      z.object({
        id: z.string(),
        brief: z.string().min(1).optional(),
        format: studioFormatSchema.optional(),
        count: z.number().int().min(1).max(4).optional(),
        copyPackageId: z.string().nullable().optional(),
        referenceImageUrls: z.array(remoteImageUrlSchema).max(4).optional(),
      }),
    )
    .output(queuedGenerationSchema)
    .mutation(async ({ input, ctx }) => {
      const now = new Date();
      const [claimed] = await db
        .update(studioSuggestions)
        .set({
          status: "approved",
          actionedAt: now,
          claimedAt: now,
          brief: input.brief,
          format: input.format,
          count: input.count,
          copyPackageId: input.copyPackageId,
          updatedAt: now,
        })
        .where(
          and(
            eq(studioSuggestions.id, input.id),
            eq(studioSuggestions.organizationId, ctx.organizationId),
            eq(studioSuggestions.status, "proposed"),
            isNull(studioSuggestions.claimedAt),
            isNull(studioSuggestions.generationId),
          ),
        )
        .returning();
      if (!claimed) {
        throw new TRPCError({ code: "CONFLICT", message: "This suggestion is already queued" });
      }
      try {
        return await queueClaimedSuggestion(
          ctx.organizationId,
          claimed,
          input.copyPackageId,
          input.referenceImageUrls,
        );
      } catch (error) {
        await db
          .update(studioSuggestions)
          .set({ status: "proposed", claimedAt: null, actionedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(studioSuggestions.id, input.id),
              eq(studioSuggestions.organizationId, ctx.organizationId),
              isNull(studioSuggestions.generationId),
            ),
          );
        throw error;
      }
    }),

  generateApproved: studioWriteProcedure
    .meta(openApiMutationMeta(
      "studio",
      "generateApproved",
      "Queue all approved Studio suggestions",
      "Queues each approved card from the weekly batch and returns its suggestionId and generationId. Poll generation or generations until each status is ready or failed; polling is canonical.",
    ))
    .output(z.object({
      queued: z.number().int(),
      failed: z.number().int(),
      generations: z.array(z.object({
        suggestionId: z.string(),
        generationId: z.string(),
      })),
    }))
    .mutation(async ({ ctx }) => {
    const approved = await db
      .select()
      .from(studioSuggestions)
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          eq(studioSuggestions.status, "approved"),
          isNull(studioSuggestions.claimedAt),
          isNull(studioSuggestions.generationId),
        ),
      )
      .orderBy(asc(studioSuggestions.createdAt));
    let queued = 0;
    let failed = 0;
    const generations: Array<{ suggestionId: string; generationId: string }> = [];
    for (const suggestion of approved) {
      const [claimed] = await db
        .update(studioSuggestions)
        .set({ claimedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(studioSuggestions.id, suggestion.id),
            eq(studioSuggestions.organizationId, ctx.organizationId),
            eq(studioSuggestions.status, "approved"),
            isNull(studioSuggestions.claimedAt),
            isNull(studioSuggestions.generationId),
          ),
        )
        .returning();
      if (!claimed) continue;
      try {
        const generation = await queueClaimedSuggestion(
          ctx.organizationId,
          claimed,
        );
        generations.push({
          suggestionId: suggestion.id,
          generationId: generation.generationId,
        });
        queued += 1;
      } catch {
        failed += 1;
        await db
          .update(studioSuggestions)
          .set({ claimedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(studioSuggestions.id, suggestion.id),
              eq(studioSuggestions.organizationId, ctx.organizationId),
              isNull(studioSuggestions.generationId),
            ),
          );
      }
    }
    return { queued, failed, generations };
  }),

  suggestionPrefill: studioProcedure
    .meta(openApiQueryMeta(
      "studio",
      "suggestionPrefill",
      "Get generation prefill for a suggestion",
      "Returns the brief and source references needed to review or customize a weekly suggestion before queueing generation.",
    ))
    .input(z.object({ id: z.string().optional(), variantId: z.string().optional() }))
    .output(z.object({
      brief: z.string(),
      angle: z.string().nullable(),
      persona: z.string().nullable(),
      awarenessLevel: z.string().nullable(),
      format: z.string(),
      count: z.number().int(),
      copyPackageId: z.string().nullable(),
      imageUrl: z.string().nullable(),
      creativeId: z.string().nullable(),
      swipeId: z.string().nullable(),
    }))
    .query(async ({ input, ctx }) => {
      const [suggestion] = await db
        .select()
        .from(studioSuggestions)
        .where(
          and(
            eq(studioSuggestions.id, input.id ?? input.variantId ?? ""),
            eq(studioSuggestions.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!suggestion) throw new TRPCError({ code: "NOT_FOUND", message: "Suggestion not found" });
      const [swipe] = suggestion.swipeId
        ? await db
            .select({ imageUrl: studioSwipes.imageUrl })
            .from(studioSwipes)
            .where(
              and(
                eq(studioSwipes.id, suggestion.swipeId),
                eq(studioSwipes.organizationId, ctx.organizationId),
              ),
            )
            .limit(1)
        : [];
      const sourceMap = await fetchSourceCreatives(
        ctx.organizationId,
        suggestion.sourceCreativeId ? [suggestion.sourceCreativeId] : [],
      );
      const source = suggestion.sourceCreativeId
        ? sourceMap.get(suggestion.sourceCreativeId)
        : null;
      return {
        brief: suggestion.brief ?? suggestion.title,
        angle: suggestion.angle,
        persona: suggestion.persona,
        awarenessLevel: suggestion.awarenessLevel,
        format: suggestion.format,
        count: suggestion.count,
        copyPackageId: suggestion.copyPackageId,
        imageUrl: swipe?.imageUrl ?? source?.assetUrl ?? null,
        creativeId: suggestion.sourceCreativeId,
        swipeId: suggestion.swipeId,
      };
    }),
} satisfies TRPCRouterRecord;
