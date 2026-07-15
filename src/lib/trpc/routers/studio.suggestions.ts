import { z } from "zod";
import { auth as triggerAuth, tasks } from "@trigger.dev/sdk";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  studioCopyPackages,
  studioGenerations,
  studioSuggestions,
  studioSwipes,
  studioVariants,
} from "@/schema/studio";
import type { generateStudioSuggestionsTask } from "../../../../trigger/generate-studio-suggestions";
import {
  fetchSourceCreatives,
  queueClaimedSuggestion,
  remoteImageUrlSchema,
  startOfStudioWeek,
  studioFormatSchema,
  studioProcedure,
  studioWriteProcedure,
} from "./studio.shared";

export const studioSuggestionProcedures = {
  home: studioProcedure.query(async ({ ctx }) => {
    const cards = await db
      .select()
      .from(studioSuggestions)
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          inArray(studioSuggestions.status, ["proposed", "approved", "skipped"]),
          gte(studioSuggestions.createdAt, startOfStudioWeek()),
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
      .select({ id: studioSuggestions.id })
      .from(studioSuggestions)
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          eq(studioSuggestions.status, "expired"),
          gte(studioSuggestions.updatedAt, expiredSince),
        ),
      );
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
      expiredCount: expired.length,
      generatedAt: cards[0]?.createdAt ?? null,
    };
  }),

  /** Compatibility alias for callers that only need the queue cards. */
  suggestions: studioProcedure.query(async ({ ctx }) => {
    const cards = await db
      .select()
      .from(studioSuggestions)
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          inArray(studioSuggestions.status, ["proposed", "approved", "skipped"]),
          gte(studioSuggestions.createdAt, startOfStudioWeek()),
        ),
      )
      .orderBy(desc(studioSuggestions.createdAt));
    return { cards, generatedAt: cards[0]?.createdAt ?? null, isRefreshing: false };
  }),

  refreshSuggestions: studioWriteProcedure.mutation(async ({ ctx }) => {
    const expired = await db
      .update(studioSuggestions)
      .set({ status: "expired", actionedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          eq(studioSuggestions.status, "proposed"),
        ),
      )
      .returning({ id: studioSuggestions.id });
    const handle = await tasks.trigger<typeof generateStudioSuggestionsTask>(
      "generate-studio-suggestions",
      { organizationId: ctx.organizationId, force: true },
    );
    const publicAccessToken = await triggerAuth.createPublicToken({
      scopes: { read: { runs: [handle.id] } },
      expirationTime: "15m",
    });
    return {
      runId: handle.id,
      publicAccessToken,
      expiredCount: expired.length,
      skipped: false as const,
    };
  }),

  setSuggestionStatus: studioWriteProcedure
    .input(
      z.object({
        suggestionId: z.string().optional(),
        variantId: z.string().optional(),
        status: z.enum(["approved", "skipped"]),
      }).refine((value) => value.suggestionId || value.variantId, "Suggestion id is required"),
    )
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

  generateApproved: studioWriteProcedure.mutation(async ({ ctx }) => {
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
        await queueClaimedSuggestion(ctx.organizationId, claimed);
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
    return { queued, failed };
  }),

  suggestionPrefill: studioProcedure
    .input(z.object({ id: z.string().optional(), variantId: z.string().optional() }))
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
