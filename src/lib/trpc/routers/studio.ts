import { z } from "zod";
import { auth as triggerAuth, tasks } from "@trigger.dev/sdk";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import {
  studioGenerations,
  studioSuggestions,
  studioSuggestionVariants,
  studioVariants,
} from "@/schema/studio";
import { AWARENESS_LEVELS, type AwarenessLevel } from "@/lib/awareness";
import { isImageStudioEnabled } from "@/lib/image-studio-enabled";
import { isHttpUrl } from "@/lib/remote-image";
import { fetchCreativePerformanceRows } from "@/lib/studio-performance";
import {
  failStudioGeneration,
  finalizeStudioGenerationIfSettled,
} from "@/lib/studio-generation-status";
import {
  ART_DIRECTIONS,
  buildPrompt,
  isStudioFormat,
  type StudioFormat,
} from "@/lib/studio-prompt";
import { buildSuggestionBrief } from "@/lib/studio-suggestions";
import type {
  generateStaticAdsTask,
  generateStaticAdVariantTask,
} from "../../../../trigger/generate-static-ads";
import type { generateStudioSuggestionsTask } from "../../../../trigger/generate-studio-suggestions";

const awarenessLevelSchema = z.enum(AWARENESS_LEVELS);
const studioFormatSchema = z
  .string()
  .refine(isStudioFormat, "Unsupported image dimensions")
  .transform((value) => value as StudioFormat);
const remoteImageUrlSchema = z
  .string()
  .url()
  .refine(isHttpUrl, "Reference images must use HTTP or HTTPS");

const STALE_GENERATION_MS = 15 * 60 * 1000;

function requireImageStudioEnabled() {
  if (!isImageStudioEnabled()) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Image Studio is not enabled",
    });
  }
}

const studioProcedure = orgProcedure.use(async ({ next }) => {
  requireImageStudioEnabled();
  return next();
});

const studioWriteProcedure = orgWriteProcedure.use(async ({ next }) => {
  requireImageStudioEnabled();
  return next();
});

function toNumber(value: string | number | null | undefined) {
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

type SourceCreativeSummary = {
  id: string;
  name: string;
  assetUrl: string | null;
  roas: number | null;
};

async function fetchSourceCreatives(
  organizationId: string,
  creativeIds: string[],
): Promise<Map<string, SourceCreativeSummary>> {
  const ids = Array.from(new Set(creativeIds)).filter(Boolean);
  if (ids.length === 0) return new Map();

  const creatives = await db
    .select({
      id: adCreatives.id,
      name: adCreatives.name,
      assetUrl: adCreatives.assetUrl,
    })
    .from(adCreatives)
    .where(
      and(
        inArray(adCreatives.id, ids),
        eq(adCreatives.organizationId, organizationId),
      ),
    );

  const performance = await fetchCreativePerformanceRows(organizationId, [
    inArray(adCreatives.id, ids),
  ]);
  const roasById = new Map(
    performance.map((row) => [row.creativeId, toNumber(row.roas)]),
  );

  return new Map(
    creatives.map((creative) => [
      creative.id,
      {
        id: creative.id,
        name: creative.name,
        assetUrl: creative.assetUrl,
        roas: roasById.get(creative.id) ?? null,
      },
    ]),
  );
}

/** Flip generations stuck in "generating" (crashed runs) to failed. */
async function reconcileStaleGenerations(
  organizationId: string,
  rows: { id: string; status: string; updatedAt: Date }[],
) {
  const cutoff = new Date(Date.now() - STALE_GENERATION_MS);
  const staleIds = rows
    .filter((row) => row.status === "generating" && row.updatedAt < cutoff)
    .map((row) => row.id);
  if (staleIds.length === 0) return staleIds;

  await db
    .update(studioGenerations)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        inArray(studioGenerations.id, staleIds),
        eq(studioGenerations.organizationId, organizationId),
        eq(studioGenerations.status, "generating"),
      ),
    );
  await db
    .update(studioVariants)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        inArray(studioVariants.generationId, staleIds),
        eq(studioVariants.organizationId, organizationId),
        inArray(studioVariants.status, ["pending", "generating"]),
      ),
    );

  return staleIds;
}

type CreateStudioGenerationParams = {
  brief: string;
  angle?: string;
  persona?: string;
  awarenessLevel?: AwarenessLevel | null;
  count: number;
  format: StudioFormat;
  referenceImageUrls?: string[];
  sourceCreativeId?: string | null;
};

async function createStudioGeneration(
  organizationId: string,
  params: CreateStudioGenerationParams,
) {
  let sourceCreativeId: string | null = null;
  if (params.sourceCreativeId) {
    const [source] = await db
      .select({ id: adCreatives.id })
      .from(adCreatives)
      .where(
        and(
          eq(adCreatives.id, params.sourceCreativeId),
          eq(adCreatives.organizationId, organizationId),
        ),
      )
      .limit(1);
    sourceCreativeId = source?.id ?? null;
  }

  const [generation] = await db
    .insert(studioGenerations)
    .values({
      organizationId,
      brief: params.brief,
      angle: params.angle,
      persona: params.persona,
      awarenessLevel: params.awarenessLevel ?? null,
      count: params.count,
      format: params.format,
      referenceImageUrls: params.referenceImageUrls ?? null,
      sourceCreativeId,
    })
    .returning();

  await db.insert(studioVariants).values(
    Array.from({ length: params.count }, (_, index) => ({
      generationId: generation.id,
      organizationId,
      index,
      status: "pending",
    })),
  );

  let handle: Awaited<
    ReturnType<typeof tasks.trigger<typeof generateStaticAdsTask>>
  >;
  try {
    handle = await tasks.trigger<typeof generateStaticAdsTask>(
      "generate-static-ads",
      {
        generationId: generation.id,
        organizationId,
        brief: params.brief,
        angle: params.angle,
        persona: params.persona,
        awarenessLevel: params.awarenessLevel ?? null,
        count: params.count,
        format: params.format,
        referenceImageUrls: params.referenceImageUrls,
      },
    );
  } catch (error) {
    await failStudioGeneration(generation.id, organizationId);
    throw error;
  }

  await db
    .update(studioGenerations)
    .set({ runId: handle.id, updatedAt: new Date() })
    .where(
      and(
        eq(studioGenerations.id, generation.id),
        eq(studioGenerations.organizationId, organizationId),
      ),
    );

  return { runId: handle.id, generationId: generation.id };
}

export const studioRouter = router({
  generate: studioWriteProcedure
    .input(
      z.object({
        brief: z.string().min(1),
        angle: z.string().optional(),
        persona: z.string().optional(),
        awarenessLevel: awarenessLevelSchema.optional(),
        count: z.number().int().min(1).max(4).default(3),
        format: studioFormatSchema.default("square"),
        referenceImageUrls: z.array(remoteImageUrlSchema).max(4).optional(),
        sourceCreativeId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const generation = await createStudioGeneration(ctx.organizationId, input);
      const publicAccessToken = await triggerAuth.createPublicToken({
        scopes: {
          read: {
            runs: [generation.runId],
          },
        },
        expirationTime: "1h",
      });

      return { ...generation, publicAccessToken };
    }),

  retry: studioWriteProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const generation = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(studioGenerations)
          .set({ status: "generating", runId: null, updatedAt: new Date() })
          .where(
            and(
              eq(studioGenerations.id, input.id),
              eq(studioGenerations.organizationId, ctx.organizationId),
              eq(studioGenerations.status, "failed"),
            ),
          )
          .returning();

        if (!claimed) return null;

        await tx
          .update(studioVariants)
          .set({
            status: "pending",
            imageUrl: null,
            prompt: null,
            starredAt: null,
            savedCreativeId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(studioVariants.generationId, claimed.id),
              eq(studioVariants.organizationId, ctx.organizationId),
            ),
          );

        return claimed;
      });

      if (!generation) {
        const [existing] = await db
          .select({ id: studioGenerations.id })
          .from(studioGenerations)
          .where(
            and(
              eq(studioGenerations.id, input.id),
              eq(studioGenerations.organizationId, ctx.organizationId),
            ),
          )
          .limit(1);

        throw new TRPCError(
          existing
            ? { code: "CONFLICT", message: "Only failed generations can be retried" }
            : { code: "NOT_FOUND", message: "Generation not found" },
        );
      }

      let handle: Awaited<ReturnType<typeof tasks.trigger<typeof generateStaticAdsTask>>>;
      try {
        handle = await tasks.trigger<typeof generateStaticAdsTask>(
          "generate-static-ads",
          {
            generationId: generation.id,
            organizationId: ctx.organizationId,
            brief: generation.brief,
            angle: generation.angle ?? undefined,
            persona: generation.persona ?? undefined,
            awarenessLevel: generation.awarenessLevel,
            count: generation.count,
            format: generation.format as StudioFormat,
            referenceImageUrls: generation.referenceImageUrls ?? undefined,
          },
        );
      } catch (error) {
        await db
          .update(studioGenerations)
          .set({ status: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(studioGenerations.id, generation.id),
              eq(studioGenerations.organizationId, ctx.organizationId),
              eq(studioGenerations.status, "generating"),
            ),
          );
        throw error;
      }

      await db
        .update(studioGenerations)
        .set({ runId: handle.id, updatedAt: new Date() })
        .where(
          and(
            eq(studioGenerations.id, generation.id),
            eq(studioGenerations.organizationId, ctx.organizationId),
          ),
        );

      return { runId: handle.id };
    }),

  suggestions: studioProcedure.query(async ({ ctx }) => {
    const cards = await db
      .select({
        id: studioSuggestions.id,
        sourceCreativeId: studioSuggestions.sourceCreativeId,
        kind: studioSuggestions.kind,
        title: studioSuggestions.title,
        whyLine: studioSuggestions.whyLine,
        angle: studioSuggestions.angle,
        persona: studioSuggestions.persona,
        awarenessLevel: studioSuggestions.awarenessLevel,
        roas: studioSuggestions.roas,
        purchases: studioSuggestions.purchases,
        spend: studioSuggestions.spend,
        status: studioSuggestions.status,
        createdAt: studioSuggestions.createdAt,
        updatedAt: studioSuggestions.updatedAt,
      })
      .from(studioSuggestions)
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          eq(studioSuggestions.status, "active"),
        ),
      )
      .orderBy(desc(studioSuggestions.createdAt));

    if (cards.length === 0) {
      return { cards: [], generatedAt: null, isRefreshing: false };
    }

    const cardIds = cards.map((card) => card.id);
    const variants = await db
      .select({
        id: studioSuggestionVariants.id,
        suggestionId: studioSuggestionVariants.suggestionId,
        index: studioSuggestionVariants.index,
        headline: studioSuggestionVariants.headline,
        diffSummary: studioSuggestionVariants.diffSummary,
        copyLine: studioSuggestionVariants.copyLine,
        elements: studioSuggestionVariants.elements,
        format: studioSuggestionVariants.format,
        status: studioSuggestionVariants.status,
        generationId: studioSuggestionVariants.generationId,
        createdAt: studioSuggestionVariants.createdAt,
        updatedAt: studioSuggestionVariants.updatedAt,
      })
      .from(studioSuggestionVariants)
      .where(
        and(
          eq(studioSuggestionVariants.organizationId, ctx.organizationId),
          inArray(studioSuggestionVariants.suggestionId, cardIds),
        ),
      )
      .orderBy(asc(studioSuggestionVariants.index));

    const sources = await fetchSourceCreatives(
      ctx.organizationId,
      cards.flatMap((card) =>
        card.sourceCreativeId ? [card.sourceCreativeId] : [],
      ),
    );
    const variantsBySuggestionId = new Map<string, typeof variants>();
    for (const variant of variants) {
      const current = variantsBySuggestionId.get(variant.suggestionId) ?? [];
      current.push(variant);
      variantsBySuggestionId.set(variant.suggestionId, current);
    }

    return {
      cards: cards.map((card) => ({
        ...card,
        source: card.sourceCreativeId
          ? (sources.get(card.sourceCreativeId) ?? null)
          : null,
        variants: variantsBySuggestionId.get(card.id) ?? [],
      })),
      generatedAt: cards[0]?.createdAt ?? null,
      isRefreshing: false,
    };
  }),

  refreshSuggestions: studioWriteProcedure.mutation(async ({ ctx }) => {
    const cutoff = new Date(Date.now() - 2 * 60 * 1000);
    const [recent] = await db
      .select({ id: studioSuggestions.id })
      .from(studioSuggestions)
      .where(
        and(
          eq(studioSuggestions.organizationId, ctx.organizationId),
          eq(studioSuggestions.status, "active"),
          gte(studioSuggestions.createdAt, cutoff),
        ),
      )
      .limit(1);

    if (recent) return { runId: null, skipped: true as const };

    const handle = await tasks.trigger<typeof generateStudioSuggestionsTask>(
      "generate-studio-suggestions",
      { organizationId: ctx.organizationId },
    );
    return { runId: handle.id, skipped: false as const };
  }),

  setSuggestionStatus: studioWriteProcedure
    .input(
      z.object({
        variantId: z.string(),
        status: z.enum(["approved", "skipped", "suggested"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [updated] = await db
        .update(studioSuggestionVariants)
        .set({ status: input.status, updatedAt: new Date() })
        .where(
          and(
            eq(studioSuggestionVariants.id, input.variantId),
            eq(studioSuggestionVariants.organizationId, ctx.organizationId),
            inArray(studioSuggestionVariants.status, [
              "suggested",
              "approved",
              "skipped",
            ]),
          ),
        )
        .returning({
          id: studioSuggestionVariants.id,
          status: studioSuggestionVariants.status,
        });

      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Generated suggestions cannot be changed",
        });
      }
      return updated;
    }),

  suggestionPrefill: studioProcedure
    .input(z.object({ variantId: z.string() }))
    .query(async ({ input, ctx }) => {
      const [variant] = await db
        .select({
          headline: studioSuggestionVariants.headline,
          diffSummary: studioSuggestionVariants.diffSummary,
          copyLine: studioSuggestionVariants.copyLine,
          elements: studioSuggestionVariants.elements,
          sourceCreativeId: studioSuggestions.sourceCreativeId,
          title: studioSuggestions.title,
          angle: studioSuggestions.angle,
          persona: studioSuggestions.persona,
          awarenessLevel: studioSuggestions.awarenessLevel,
        })
        .from(studioSuggestionVariants)
        .innerJoin(
          studioSuggestions,
          eq(studioSuggestions.id, studioSuggestionVariants.suggestionId),
        )
        .where(
          and(
            eq(studioSuggestionVariants.id, input.variantId),
            eq(studioSuggestionVariants.organizationId, ctx.organizationId),
            eq(studioSuggestions.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);

      if (!variant) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Suggestion not found" });
      }

      const sources = await fetchSourceCreatives(
        ctx.organizationId,
        variant.sourceCreativeId ? [variant.sourceCreativeId] : [],
      );
      const source = variant.sourceCreativeId
        ? (sources.get(variant.sourceCreativeId) ?? null)
        : null;

      return {
        brief: buildSuggestionBrief(
          {
            headline: variant.headline,
            diffSummary: variant.diffSummary,
            copyLine: variant.copyLine,
            elements: variant.elements,
          },
          source?.name ?? variant.title,
        ),
        angle: variant.angle,
        persona: variant.persona,
        awarenessLevel: variant.awarenessLevel,
        imageUrl: source?.assetUrl ?? null,
        creativeId: variant.sourceCreativeId,
      };
    }),

  generateApproved: studioWriteProcedure.mutation(async ({ ctx }) => {
    const approved = await db
      .select({
        id: studioSuggestionVariants.id,
        headline: studioSuggestionVariants.headline,
        diffSummary: studioSuggestionVariants.diffSummary,
        copyLine: studioSuggestionVariants.copyLine,
        elements: studioSuggestionVariants.elements,
        format: studioSuggestionVariants.format,
        sourceCreativeId: studioSuggestions.sourceCreativeId,
        title: studioSuggestions.title,
        angle: studioSuggestions.angle,
        persona: studioSuggestions.persona,
        awarenessLevel: studioSuggestions.awarenessLevel,
      })
      .from(studioSuggestionVariants)
      .innerJoin(
        studioSuggestions,
        eq(studioSuggestions.id, studioSuggestionVariants.suggestionId),
      )
      .where(
        and(
          eq(studioSuggestionVariants.organizationId, ctx.organizationId),
          eq(studioSuggestions.organizationId, ctx.organizationId),
          eq(studioSuggestions.status, "active"),
          eq(studioSuggestionVariants.status, "approved"),
          sql`${studioSuggestionVariants.generationId} is null`,
        ),
      )
      .orderBy(asc(studioSuggestionVariants.index));

    const sources = await fetchSourceCreatives(
      ctx.organizationId,
      approved.flatMap((variant) =>
        variant.sourceCreativeId ? [variant.sourceCreativeId] : [],
      ),
    );
    let queued = 0;
    let failed = 0;

    for (const variant of approved) {
      try {
        const source = variant.sourceCreativeId
          ? (sources.get(variant.sourceCreativeId) ?? null)
          : null;
        const generation = await createStudioGeneration(ctx.organizationId, {
          brief: buildSuggestionBrief(
            {
              headline: variant.headline,
              diffSummary: variant.diffSummary,
              copyLine: variant.copyLine,
              elements: variant.elements,
            },
            source?.name ?? variant.title,
          ),
          angle: variant.angle ?? undefined,
          persona: variant.persona ?? undefined,
          awarenessLevel: variant.awarenessLevel,
          count: 1,
          format: isStudioFormat(variant.format) ? variant.format : "square",
          referenceImageUrls: source?.assetUrl ? [source.assetUrl] : undefined,
          sourceCreativeId: variant.sourceCreativeId,
        });

        await db
          .update(studioSuggestionVariants)
          .set({
            status: "generated",
            generationId: generation.generationId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(studioSuggestionVariants.id, variant.id),
              eq(studioSuggestionVariants.organizationId, ctx.organizationId),
              eq(studioSuggestionVariants.status, "approved"),
            ),
          );
        queued += 1;
      } catch {
        failed += 1;
      }
    }

    return { queued, failed };
  }),

  winningAngles: studioProcedure.query(async ({ ctx }) => {
    const rows = await fetchCreativePerformanceRows(ctx.organizationId, [
      sql`nullif(trim(${adCreatives.angle}), '') is not null`,
    ]);

    const byAngle = new Map<
      string,
      {
        angle: string;
        awarenessCounts: Map<string, number>;
        adCount: number;
        spend: number;
        purchases: number;
        purchaseValue: number;
        assetUrl: string | null;
        bestValue: number;
      }
    >();

    for (const row of rows) {
      if (!row.angle?.trim()) continue;

      const angle = row.angle.trim();
      const current = byAngle.get(angle) ?? {
        angle,
        awarenessCounts: new Map<string, number>(),
        adCount: 0,
        spend: 0,
        purchases: 0,
        purchaseValue: 0,
        assetUrl: null,
        bestValue: -1,
      };

      current.adCount += 1;
      current.spend += toNumber(row.spend);
      current.purchases += toNumber(row.purchases);
      current.purchaseValue += toNumber(row.purchaseValue);

      // Keep the highest-value creative's image as the angle's representative thumbnail.
      const rowValue = toNumber(row.purchaseValue);
      if (row.assetUrl && rowValue > current.bestValue) {
        current.bestValue = rowValue;
        current.assetUrl = row.assetUrl;
      }

      if (row.awarenessLevel) {
        current.awarenessCounts.set(
          row.awarenessLevel,
          (current.awarenessCounts.get(row.awarenessLevel) ?? 0) + 1,
        );
      }

      byAngle.set(angle, current);
    }

    return Array.from(byAngle.values())
      .map((group) => {
        const awarenessLevel =
          Array.from(group.awarenessCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ??
          null;

        return {
          angle: group.angle,
          awarenessLevel: awarenessLevel as AwarenessLevel | null,
          adCount: group.adCount,
          roas: group.spend > 0 ? group.purchaseValue / group.spend : 0,
          spend: group.spend,
          purchases: group.purchases,
          assetUrl: group.assetUrl,
        };
      })
      .filter((group) => group.spend > 0 || group.purchases > 0)
      .sort((a, b) => b.roas - a.roas)
      .slice(0, 8);
  }),

  topByPurchases: studioProcedure.query(async ({ ctx }) => {
    const rows = await fetchCreativePerformanceRows(ctx.organizationId);

    return rows
      .map((row) => ({
        creativeId: row.creativeId,
        name: row.name,
        angle: row.angle,
        persona: row.persona,
        awarenessLevel: row.awarenessLevel as AwarenessLevel | null,
        assetUrl: row.assetUrl,
        purchases: toNumber(row.purchases),
        purchaseValue: toNumber(row.purchaseValue),
        roas: toNumber(row.roas),
      }))
      .filter((row) => row.purchases > 0 || row.purchaseValue > 0)
      .sort((a, b) => b.purchases - a.purchases)
      .slice(0, 8);
  }),

  generations: studioProcedure.query(async ({ ctx }) => {
    const generations = await db
      .select({
        id: studioGenerations.id,
        runId: studioGenerations.runId,
        brief: studioGenerations.brief,
        angle: studioGenerations.angle,
        persona: studioGenerations.persona,
        awarenessLevel: studioGenerations.awarenessLevel,
        status: studioGenerations.status,
        count: studioGenerations.count,
        format: studioGenerations.format,
        referenceImageUrls: studioGenerations.referenceImageUrls,
        sourceCreativeId: studioGenerations.sourceCreativeId,
        createdAt: studioGenerations.createdAt,
        updatedAt: studioGenerations.updatedAt,
      })
      .from(studioGenerations)
      .where(eq(studioGenerations.organizationId, ctx.organizationId))
      .orderBy(desc(studioGenerations.createdAt))
      .limit(50);

    const generationIds = generations.map((generation) => generation.id);
    if (generationIds.length === 0) {
      return [];
    }

    const staleIds = await reconcileStaleGenerations(ctx.organizationId, generations);
    for (const generation of generations) {
      if (staleIds.includes(generation.id)) generation.status = "failed";
    }

    const variants = await db
      .select({
        id: studioVariants.id,
        generationId: studioVariants.generationId,
        index: studioVariants.index,
        status: studioVariants.status,
        imageUrl: studioVariants.imageUrl,
        starredAt: studioVariants.starredAt,
      })
      .from(studioVariants)
      .where(
        and(
          eq(studioVariants.organizationId, ctx.organizationId),
          inArray(studioVariants.generationId, generationIds),
        ),
      )
      .orderBy(asc(studioVariants.index));

    const sources = await fetchSourceCreatives(
      ctx.organizationId,
      generations.flatMap((generation) =>
        generation.sourceCreativeId ? [generation.sourceCreativeId] : [],
      ),
    );

    const variantsByGenerationId = new Map<string, typeof variants>();
    for (const variant of variants) {
      const current = variantsByGenerationId.get(variant.generationId) ?? [];
      current.push(variant);
      variantsByGenerationId.set(variant.generationId, current);
    }

    return generations.map((generation) => ({
      ...generation,
      source: generation.sourceCreativeId
        ? (sources.get(generation.sourceCreativeId) ?? null)
        : null,
      variants: (variantsByGenerationId.get(generation.id) ?? []).map((variant) => ({
        id: variant.id,
        index: variant.index,
        status: variant.status,
        imageUrl: variant.imageUrl,
        starredAt: variant.starredAt,
      })),
    }));
  }),

  generation: studioProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [generation] = await db
        .select()
        .from(studioGenerations)
        .where(
          and(
            eq(studioGenerations.id, input.id),
            eq(studioGenerations.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);

      if (!generation) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Generation not found" });
      }

      const staleIds = await reconcileStaleGenerations(ctx.organizationId, [generation]);
      if (staleIds.includes(generation.id)) generation.status = "failed";

      const variants = await db
        .select()
        .from(studioVariants)
        .where(
          and(
            eq(studioVariants.generationId, generation.id),
            eq(studioVariants.organizationId, ctx.organizationId),
          ),
        )
        .orderBy(asc(studioVariants.index));

      const realtime =
        generation.status === "generating" && generation.runId
          ? {
              runId: generation.runId,
              publicAccessToken: await triggerAuth.createPublicToken({
                scopes: {
                  read: {
                    runs: [generation.runId],
                  },
                },
                expirationTime: "1h",
              }),
            }
          : null;

      const sources = await fetchSourceCreatives(
        ctx.organizationId,
        generation.sourceCreativeId ? [generation.sourceCreativeId] : [],
      );

      return {
        generation,
        variants,
        realtime,
        source: generation.sourceCreativeId
          ? (sources.get(generation.sourceCreativeId) ?? null)
          : null,
      };
    }),

  setStarred: studioWriteProcedure
    .input(
      z.object({
        variantIds: z.array(z.string()).min(1).max(50),
        starred: z.boolean(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const updated = await db
        .update(studioVariants)
        .set({
          starredAt: input.starred ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(studioVariants.id, input.variantIds),
            eq(studioVariants.organizationId, ctx.organizationId),
            eq(studioVariants.status, "ready"),
          ),
        )
        .returning({ id: studioVariants.id });

      return { updatedCount: updated.length };
    }),

  retryVariant: studioWriteProcedure
    .input(z.object({ variantId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const claimed = await db.transaction(async (tx) => {
        const [variant] = await tx
          .select({
            id: studioVariants.id,
            index: studioVariants.index,
            generationId: studioVariants.generationId,
            status: studioVariants.status,
            brief: studioGenerations.brief,
            angle: studioGenerations.angle,
            persona: studioGenerations.persona,
            awarenessLevel: studioGenerations.awarenessLevel,
            count: studioGenerations.count,
            format: studioGenerations.format,
            referenceImageUrls: studioGenerations.referenceImageUrls,
          })
          .from(studioVariants)
          .innerJoin(
            studioGenerations,
            eq(studioGenerations.id, studioVariants.generationId),
          )
          .where(
            and(
              eq(studioVariants.id, input.variantId),
              eq(studioVariants.organizationId, ctx.organizationId),
              eq(studioGenerations.organizationId, ctx.organizationId),
            ),
          )
          .for("update");

        if (!variant) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Variant not found" });
        }
        if (variant.status !== "failed") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Only failed images can be retried",
          });
        }

        await tx
          .update(studioVariants)
          .set({
            status: "pending",
            imageUrl: null,
            prompt: null,
            starredAt: null,
            savedCreativeId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(studioVariants.id, variant.id),
              eq(studioVariants.organizationId, ctx.organizationId),
            ),
          );

        await tx
          .update(studioGenerations)
          .set({ status: "generating", updatedAt: new Date() })
          .where(
            and(
              eq(studioGenerations.id, variant.generationId),
              eq(studioGenerations.organizationId, ctx.organizationId),
            ),
          );

        return variant;
      });

      try {
        await tasks.trigger<typeof generateStaticAdVariantTask>(
          "generate-static-ad-variant",
          {
            generationId: claimed.generationId,
            organizationId: ctx.organizationId,
            variantIndex: claimed.index,
            basePrompt: buildPrompt({
              brief: claimed.brief,
              angle: claimed.angle,
              persona: claimed.persona,
              awarenessLevel: claimed.awarenessLevel,
              format: claimed.format as StudioFormat,
            }),
            artDirection:
              claimed.count > 1
                ? ART_DIRECTIONS[claimed.index % ART_DIRECTIONS.length]
                : null,
            format: claimed.format as StudioFormat,
            referenceImageUrls: claimed.referenceImageUrls ?? undefined,
            finalizeGeneration: true,
          },
        );
      } catch (error) {
        await db
          .update(studioVariants)
          .set({ status: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(studioVariants.id, claimed.id),
              eq(studioVariants.organizationId, ctx.organizationId),
            ),
          );

        await finalizeStudioGenerationIfSettled(
          claimed.generationId,
          ctx.organizationId,
        );
        throw error;
      }

      return { ok: true };
    }),

  remixSource: studioProcedure
    .input(z.object({ creativeId: z.string() }))
    .query(async ({ input, ctx }) => {
      const [creative] = await db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          assetUrl: adCreatives.assetUrl,
          angle: adCreatives.angle,
          persona: adCreatives.persona,
          awarenessLevel: adCreatives.awarenessLevel,
        })
        .from(adCreatives)
        .where(
          and(
            eq(adCreatives.id, input.creativeId),
            eq(adCreatives.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);

      if (!creative) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Creative not found" });
      }

      return creative;
    }),
});
