import { z } from "zod";
import { auth as triggerAuth, tasks } from "@trigger.dev/sdk";
import { TRPCError } from "@trpc/server";
import { del } from "@vercel/blob";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { router, orgProcedure, orgWriteProcedure } from "../init";
import { db } from "@/db";
import { ads } from "@/schema/ad";
import { adCreatives } from "@/schema/ad-creative";
import {
  studioBrandProfiles,
  studioCopyPackages,
  studioGenerations,
  studioSuggestions,
  studioSwipes,
  studioTaxonomyValues,
  studioVariants,
} from "@/schema/studio";
import { AWARENESS_LEVELS, type AwarenessLevel } from "@/lib/awareness";
import { isImageStudioEnabled } from "@/lib/image-studio-enabled";
import { isHttpUrl } from "@/lib/remote-image";
import { getStudioBrandProfile } from "@/lib/studio-brand";
import { fetchCreativePerformanceRows } from "@/lib/studio-performance";
import {
  failStudioGeneration,
  finalizeStudioGenerationIfSettled,
} from "@/lib/studio-generation-status";
import {
  artDirectionFor,
  buildPrompt,
  isStudioFormat,
  type StudioFormat,
} from "@/lib/studio-prompt";
import { buildElementsBrief } from "@/lib/studio-suggestions";
import {
  buildRebrandBrief,
  buildRebrandPrompt,
  STUDIO_ANGLE_SEEDS,
  STUDIO_STYLE_SEEDS,
  studioSlug,
} from "@/lib/studio-v2";
import type {
  generateStaticAdsTask,
  generateStaticAdVariantTask,
} from "../../../../trigger/generate-static-ads";
import type {
  analyzeStudioSwipeTask,
  generateStudioSuggestionsTask,
} from "../../../../trigger/generate-studio-suggestions";

const awarenessLevelSchema = z.enum(AWARENESS_LEVELS);
const studioFormatSchema = z
  .string()
  .refine(isStudioFormat, "Unsupported image dimensions")
  .transform((value) => value as StudioFormat);
const remoteImageUrlSchema = z
  .string()
  .url()
  .refine(isHttpUrl, "Reference images must use HTTP or HTTPS");
const persistedSwipeImageUrlSchema = remoteImageUrlSchema.refine((value) => {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "blob.vercel-storage.com" ||
    hostname.endsWith(".blob.vercel-storage.com");
}, "Swipe screenshots must be uploaded before saving");
const taxonomyKindSchema = z.enum(["angle", "visual_style"]);
const markSchema = z.enum(["good", "bad"]);
const STALE_GENERATION_MS = 15 * 60 * 1000;

function requireImageStudioEnabled() {
  if (!isImageStudioEnabled()) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Image Studio is not enabled" });
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

function toNullableNumber(value: string | number | null | undefined) {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function startOfStudioWeek(now = new Date()) {
  const start = new Date(now);
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - ((day + 6) % 7));
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function normalizeOptionalUrl(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const url = new URL(trimmed);
  url.hash = "";
  return url.toString();
}

async function requireTaxonomyValue(
  organizationId: string,
  id: string | null | undefined,
  kind: "angle" | "visual_style",
) {
  if (!id) return;
  const [value] = await db
    .select({ id: studioTaxonomyValues.id })
    .from(studioTaxonomyValues)
    .where(
      and(
        eq(studioTaxonomyValues.id, id),
        eq(studioTaxonomyValues.organizationId, organizationId),
        eq(studioTaxonomyValues.kind, kind),
        isNull(studioTaxonomyValues.archivedAt),
      ),
    )
    .limit(1);
  if (!value) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: kind === "angle" ? "Invalid angle tag" : "Invalid visual-style tag",
    });
  }
}

async function requireCopyPackage(
  organizationId: string,
  id: string | null | undefined,
) {
  if (!id) return;
  const [pkg] = await db
    .select({ id: studioCopyPackages.id })
    .from(studioCopyPackages)
    .where(
      and(
        eq(studioCopyPackages.id, id),
        eq(studioCopyPackages.organizationId, organizationId),
        isNull(studioCopyPackages.archivedAt),
      ),
    )
    .limit(1);
  if (!pkg) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid copy package" });
  }
}

type SourceCreativeSummary = {
  id: string;
  name: string;
  assetUrl: string | null;
  format: string | null;
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
      format: adCreatives.format,
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
      { ...creative, roas: roasById.get(creative.id) ?? null },
    ]),
  );
}

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
  swipeId?: string | null;
  copyPackageId?: string | null;
};

/** The single entry point for all Studio generation scaffolding and queueing. */
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
    if (!source) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Source creative not found" });
    }
    sourceCreativeId = source.id;
  }
  let swipeId: string | null = null;
  if (params.swipeId) {
    const [swipe] = await db
      .select({ id: studioSwipes.id })
      .from(studioSwipes)
      .where(
        and(
          eq(studioSwipes.id, params.swipeId),
          eq(studioSwipes.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!swipe) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Swipe not found" });
    }
    swipeId = swipe.id;
  }
  let copyPackage: {
    id: string;
    name: string;
    primaryText: string;
    headline: string;
    description: string;
  } | null = null;
  if (params.copyPackageId) {
    const [pkg] = await db
      .select({
        id: studioCopyPackages.id,
        name: studioCopyPackages.name,
        primaryText: studioCopyPackages.primaryText,
        headline: studioCopyPackages.headline,
        description: studioCopyPackages.description,
      })
      .from(studioCopyPackages)
      .where(
        and(
          eq(studioCopyPackages.id, params.copyPackageId),
          eq(studioCopyPackages.organizationId, organizationId),
          isNull(studioCopyPackages.archivedAt),
        ),
      )
      .limit(1);
    if (!pkg) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid copy package" });
    }
    copyPackage = pkg;
  }
  const copyPackageId = copyPackage?.id ?? null;
  const generationBrief = copyPackage
    ? [
        params.brief,
        `Copy tone reference — ${copyPackage.name}. Match this voice without copying it word-for-word. Primary text: "${copyPackage.primaryText}" Headline: "${copyPackage.headline}" Description: "${copyPackage.description}"`,
      ].join("\n")
    : params.brief;

  const [generation] = await db
    .insert(studioGenerations)
    .values({
      organizationId,
      brief: generationBrief,
      angle: params.angle,
      persona: params.persona,
      awarenessLevel: params.awarenessLevel ?? null,
      count: params.count,
      format: params.format,
      referenceImageUrls: params.referenceImageUrls ?? null,
      sourceCreativeId,
      swipeId,
      copyPackageId,
    })
    .returning();
  await db.insert(studioVariants).values(
    Array.from({ length: params.count }, (_, index) => ({
      generationId: generation.id,
      organizationId,
      index,
      status: "pending",
      copyPackageId,
    })),
  );

  try {
    const handle = await tasks.trigger<typeof generateStaticAdsTask>(
      "generate-static-ads",
      {
        generationId: generation.id,
        organizationId,
        brief: generationBrief,
        angle: params.angle,
        persona: params.persona,
        awarenessLevel: params.awarenessLevel ?? null,
        count: params.count,
        format: params.format,
        referenceImageUrls: params.referenceImageUrls,
      },
    );
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
  } catch (error) {
    await failStudioGeneration(generation.id, organizationId);
    throw error;
  }
}

async function latestPackageForAngle(
  organizationId: string,
  angleId: string | null,
) {
  if (!angleId) return null;
  const [pkg] = await db
    .select({ id: studioCopyPackages.id })
    .from(studioCopyPackages)
    .where(
      and(
        eq(studioCopyPackages.organizationId, organizationId),
        eq(studioCopyPackages.angleId, angleId),
        isNull(studioCopyPackages.archivedAt),
      ),
    )
    .orderBy(desc(studioCopyPackages.createdAt))
    .limit(1);
  return pkg?.id ?? null;
}

async function queueClaimedSuggestion(
  organizationId: string,
  suggestion: typeof studioSuggestions.$inferSelect,
  copyPackageOverride?: string | null,
  referenceImageOverride?: string[],
) {
  const sourceMap = await fetchSourceCreatives(
    organizationId,
    suggestion.sourceCreativeId ? [suggestion.sourceCreativeId] : [],
  );
  const source = suggestion.sourceCreativeId
    ? sourceMap.get(suggestion.sourceCreativeId)
    : null;
  const [swipe] = suggestion.swipeId
    ? await db
        .select({
          id: studioSwipes.id,
          imageUrl: studioSwipes.imageUrl,
          brandName: studioSwipes.brandName,
          elements: studioSwipes.elements,
        })
        .from(studioSwipes)
        .where(
          and(
            eq(studioSwipes.id, suggestion.swipeId),
            eq(studioSwipes.organizationId, organizationId),
          ),
        )
        .limit(1)
    : [];
  const packageId =
    copyPackageOverride !== undefined
      ? copyPackageOverride
      : suggestion.copyPackageId ??
        (await latestPackageForAngle(organizationId, suggestion.angleId));
  const baseBrief =
    suggestion.brief?.trim() ||
    (suggestion.elements
      ? buildElementsBrief(suggestion.elements)
      : suggestion.title);
  const brand = swipe ? await getStudioBrandProfile(organizationId) : null;
  const brief = swipe
    ? buildRebrandPrompt({
        brief:
          baseBrief ||
          buildRebrandBrief({
            brandName: brand?.brandName,
            sourceBrandName: swipe.brandName,
          }),
        elements: swipe.elements ?? suggestion.elements,
      })
    : baseBrief;
  const referenceImageUrls =
    referenceImageOverride !== undefined
      ? referenceImageOverride
      : swipe?.imageUrl
        ? [swipe.imageUrl]
        : source?.assetUrl
          ? [source.assetUrl]
          : undefined;
  const generation = await createStudioGeneration(organizationId, {
    brief,
    angle: suggestion.angle ?? undefined,
    persona: suggestion.persona ?? undefined,
    awarenessLevel: suggestion.awarenessLevel,
    // AI-proposed cards arrive with 3-4 from their own schema; user-queued
    // rebrands may legitimately be 1-2, so only clamp to the hard bounds.
    count: Math.min(4, Math.max(1, suggestion.count)),
    format: isStudioFormat(suggestion.format) ? suggestion.format : "square",
    referenceImageUrls,
    sourceCreativeId: suggestion.sourceCreativeId,
    swipeId: suggestion.swipeId,
    copyPackageId: packageId,
  });
  const now = new Date();
  await db
    .update(studioSuggestions)
    .set({
      generationId: generation.generationId,
      copyPackageId: packageId,
      updatedAt: now,
    })
    .where(
      and(
        eq(studioSuggestions.id, suggestion.id),
        eq(studioSuggestions.organizationId, organizationId),
        isNull(studioSuggestions.generationId),
      ),
    );
  if (suggestion.swipeId) {
    await db
      .update(studioSwipes)
      .set({ lastTriedAt: now, updatedAt: now })
      .where(
        and(
          eq(studioSwipes.id, suggestion.swipeId),
          eq(studioSwipes.organizationId, organizationId),
        ),
      );
  }
  return generation;
}

async function seedTaxonomy(organizationId: string) {
  const rows = [
    ...STUDIO_ANGLE_SEEDS.map((name) => ({ kind: "angle", name })),
    ...STUDIO_STYLE_SEEDS.map((name) => ({ kind: "visual_style", name })),
  ].map((value) => ({
    organizationId,
    kind: value.kind,
    name: value.name,
    slug: studioSlug(value.name),
  }));
  await db
    .insert(studioTaxonomyValues)
    .values(rows)
    .onConflictDoNothing({
      target: [
        studioTaxonomyValues.organizationId,
        studioTaxonomyValues.kind,
        studioTaxonomyValues.slug,
      ],
    });
}

const generationInput = z.object({
  brief: z.string().min(1),
  angle: z.string().optional(),
  persona: z.string().optional(),
  awarenessLevel: awarenessLevelSchema.optional(),
  count: z.number().int().min(1).max(4).default(3),
  format: studioFormatSchema.default("square"),
  referenceImageUrls: z.array(remoteImageUrlSchema).max(4).optional(),
  sourceCreativeId: z.string().optional(),
  swipeId: z.string().optional(),
  copyPackageId: z.string().optional(),
});

export const studioRouter = router({
  brandProfile: studioProcedure.query(({ ctx }) =>
    getStudioBrandProfile(ctx.organizationId),
  ),

  saveBrandProfile: studioWriteProcedure
    .input(
      z.object({
        brandName: z.string().trim().min(1),
        productDescription: z.string().trim().min(1),
        offer: z.string().trim().max(500).optional(),
        productImageUrl: remoteImageUrlSchema.nullish(),
        productNotes: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const values = {
        brandName: input.brandName,
        productDescription: input.productDescription,
        offer: input.offer || null,
        productImageUrl: input.productImageUrl ?? null,
        productNotes: input.productNotes || null,
      };
      await db
        .insert(studioBrandProfiles)
        .values({ organizationId: ctx.organizationId, ...values })
        .onConflictDoUpdate({
          target: studioBrandProfiles.organizationId,
          set: { ...values, updatedAt: new Date() },
        });
      return { ok: true };
    }),

  generate: studioWriteProcedure.input(generationInput).mutation(async ({ input, ctx }) => {
    const generation = await createStudioGeneration(ctx.organizationId, input);
    const publicAccessToken = await triggerAuth.createPublicToken({
      scopes: { read: { runs: [generation.runId] } },
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
            mark: null,
            publishedAt: null,
            moderationReason: null,
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
        throw new TRPCError({ code: "CONFLICT", message: "Only failed generations can be retried" });
      }
      try {
        const handle = await tasks.trigger<typeof generateStaticAdsTask>(
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
        await db
          .update(studioGenerations)
          .set({ runId: handle.id, updatedAt: new Date() })
          .where(eq(studioGenerations.id, generation.id));
        return { runId: handle.id };
      } catch (error) {
        await failStudioGeneration(generation.id, ctx.organizationId);
        throw error;
      }
    }),

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

  taxonomies: studioProcedure.query(async ({ ctx }) => {
    await seedTaxonomy(ctx.organizationId);
    return db
      .select()
      .from(studioTaxonomyValues)
      .where(eq(studioTaxonomyValues.organizationId, ctx.organizationId))
      .orderBy(asc(studioTaxonomyValues.kind), asc(studioTaxonomyValues.name));
  }),

  addTaxonomyValue: studioWriteProcedure
    .input(
      z.object({
        kind: taxonomyKindSchema,
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .refine((name) => studioSlug(name).length > 0, "Use letters or numbers"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [value] = await db
        .insert(studioTaxonomyValues)
        .values({
          organizationId: ctx.organizationId,
          kind: input.kind,
          name: input.name,
          slug: studioSlug(input.name),
        })
        .onConflictDoUpdate({
          target: [
            studioTaxonomyValues.organizationId,
            studioTaxonomyValues.kind,
            studioTaxonomyValues.slug,
          ],
          set: { name: input.name, archivedAt: null, updatedAt: new Date() },
        })
        .returning();
      return value;
    }),

  archiveTaxonomyValue: studioWriteProcedure
    .input(z.object({ id: z.string(), archived: z.boolean().default(true) }))
    .mutation(async ({ input, ctx }) => {
      const [value] = await db
        .update(studioTaxonomyValues)
        .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
        .where(
          and(
            eq(studioTaxonomyValues.id, input.id),
            eq(studioTaxonomyValues.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      if (!value) throw new TRPCError({ code: "NOT_FOUND", message: "Tag value not found" });
      return value;
    }),

  swipes: studioProcedure
    .input(
      z.object({
        includeArchived: z.boolean().default(false),
        angleId: z.string().optional(),
        visualStyleId: z.string().optional(),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const conditions = [eq(studioSwipes.organizationId, ctx.organizationId)];
      if (!input?.includeArchived) conditions.push(isNull(studioSwipes.archivedAt));
      if (input?.angleId) conditions.push(eq(studioSwipes.angleId, input.angleId));
      if (input?.visualStyleId) {
        conditions.push(eq(studioSwipes.visualStyleId, input.visualStyleId));
      }
      const [rows, taxonomy] = await Promise.all([
        db.select().from(studioSwipes).where(and(...conditions)).orderBy(desc(studioSwipes.createdAt)),
        db
          .select()
          .from(studioTaxonomyValues)
          .where(eq(studioTaxonomyValues.organizationId, ctx.organizationId)),
      ]);
      const byId = new Map(taxonomy.map((value) => [value.id, value]));
      return rows.map((swipe) => ({
        ...swipe,
        angle: swipe.angleId ? byId.get(swipe.angleId) ?? null : null,
        visualStyle: swipe.visualStyleId
          ? byId.get(swipe.visualStyleId) ?? null
          : null,
      }));
    }),

  createSwipe: studioWriteProcedure
    .input(
      z.object({
        imageUrl: persistedSwipeImageUrlSchema,
        sourceUrl: z.string().url().optional().or(z.literal("")),
        brandName: z.string().trim().max(100).optional(),
        angleId: z.string().optional(),
        visualStyleId: z.string().optional(),
        whyItWorks: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await Promise.all([
        requireTaxonomyValue(ctx.organizationId, input.angleId, "angle"),
        requireTaxonomyValue(
          ctx.organizationId,
          input.visualStyleId,
          "visual_style",
        ),
      ]);
      const sourceUrl = normalizeOptionalUrl(input.sourceUrl);
      if (sourceUrl) {
        const [existing] = await db
          .select()
          .from(studioSwipes)
          .where(
            and(
              eq(studioSwipes.organizationId, ctx.organizationId),
              eq(studioSwipes.sourceUrl, sourceUrl),
            ),
          )
          .limit(1);
        if (existing) return { swipe: existing, duplicate: true as const };
      }
      const [swipe] = await db
        .insert(studioSwipes)
        .values({
          organizationId: ctx.organizationId,
          imageUrl: input.imageUrl,
          sourceUrl,
          brandName: input.brandName || null,
          angleId: input.angleId ?? null,
          visualStyleId: input.visualStyleId ?? null,
          whyItWorks: input.whyItWorks || null,
          addedBy: ctx.userId,
        })
        .onConflictDoNothing({
          target: [studioSwipes.organizationId, studioSwipes.sourceUrl],
        })
        .returning();
      if (!swipe && sourceUrl) {
        const [existing] = await db
          .select()
          .from(studioSwipes)
          .where(
            and(
              eq(studioSwipes.organizationId, ctx.organizationId),
              eq(studioSwipes.sourceUrl, sourceUrl),
            ),
          )
          .limit(1);
        if (existing) return { swipe: existing, duplicate: true as const };
      }
      if (!swipe) {
        throw new TRPCError({ code: "CONFLICT", message: "Swipe could not be saved" });
      }
      await tasks
        .trigger<typeof analyzeStudioSwipeTask>("analyze-studio-swipe", {
          organizationId: ctx.organizationId,
          swipeId: swipe.id,
          imageUrl: swipe.imageUrl,
        })
        .catch(() => undefined);
      return { swipe, duplicate: false as const };
    }),

  updateSwipe: studioWriteProcedure
    .input(
      z.object({
        id: z.string(),
        sourceUrl: z.string().url().nullable().optional().or(z.literal("")),
        brandName: z.string().trim().max(100).nullable().optional(),
        angleId: z.string().nullable().optional(),
        visualStyleId: z.string().nullable().optional(),
        whyItWorks: z.string().trim().max(1000).nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, sourceUrl, ...values } = input;
      await Promise.all([
        requireTaxonomyValue(ctx.organizationId, values.angleId, "angle"),
        requireTaxonomyValue(
          ctx.organizationId,
          values.visualStyleId,
          "visual_style",
        ),
      ]);
      const [swipe] = await db
        .update(studioSwipes)
        .set({
          ...values,
          sourceUrl: sourceUrl === undefined ? undefined : normalizeOptionalUrl(sourceUrl),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(studioSwipes.id, id),
            eq(studioSwipes.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      if (!swipe) throw new TRPCError({ code: "NOT_FOUND", message: "Swipe not found" });
      return swipe;
    }),

  archiveSwipe: studioWriteProcedure
    .input(z.object({ id: z.string(), archived: z.boolean().default(true) }))
    .mutation(async ({ input, ctx }) => {
      const [swipe] = await db
        .update(studioSwipes)
        .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
        .where(
          and(
            eq(studioSwipes.id, input.id),
            eq(studioSwipes.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      if (!swipe) throw new TRPCError({ code: "NOT_FOUND", message: "Swipe not found" });
      return swipe;
    }),

  deleteSwipe: studioWriteProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [existing] = await db
        .select({ imageUrl: studioSwipes.imageUrl })
        .from(studioSwipes)
        .where(
          and(
            eq(studioSwipes.id, input.id),
            eq(studioSwipes.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      const deleted = await db
        .delete(studioSwipes)
        .where(
          and(
            eq(studioSwipes.id, input.id),
            eq(studioSwipes.organizationId, ctx.organizationId),
          ),
        )
        .returning({ id: studioSwipes.id });
      if (deleted.length === 1 && existing?.imageUrl) {
        await del(existing.imageUrl).catch(() => undefined);
      }
      return { deleted: deleted.length === 1 };
    }),

  rebrandSwipe: studioWriteProcedure
    .input(
      z.object({
        swipeId: z.string(),
        brief: z.string().trim().min(1),
        format: studioFormatSchema.default("square"),
        count: z.number().int().min(1).max(4).default(3),
        copyPackageId: z.string().nullable().optional(),
        mode: z.enum(["generate_now", "queue"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [swipe] = await db
        .select()
        .from(studioSwipes)
        .where(
          and(
            eq(studioSwipes.id, input.swipeId),
            eq(studioSwipes.organizationId, ctx.organizationId),
            isNull(studioSwipes.archivedAt),
          ),
        )
        .limit(1);
      if (!swipe) throw new TRPCError({ code: "NOT_FOUND", message: "Swipe not found" });
      await requireCopyPackage(ctx.organizationId, input.copyPackageId);
      const prompt = buildRebrandPrompt({ brief: input.brief, elements: swipe.elements });
      if (input.mode === "generate_now") {
        const generation = await createStudioGeneration(ctx.organizationId, {
          brief: prompt,
          count: input.count,
          format: input.format,
          referenceImageUrls: [swipe.imageUrl],
          swipeId: swipe.id,
          copyPackageId: input.copyPackageId,
        });
        await db
          .update(studioSwipes)
          .set({ lastTriedAt: new Date(), updatedAt: new Date() })
          .where(eq(studioSwipes.id, swipe.id));
        return { mode: input.mode, ...generation };
      }
      const [suggestion] = await db
        .insert(studioSuggestions)
        .values({
          organizationId: ctx.organizationId,
          swipeId: swipe.id,
          kind: "rebrand_swipe",
          title: `Rebrand${swipe.brandName ? `: ${swipe.brandName}` : " this swipe"}`,
          whyLine: swipe.whyItWorks || "Saved in your swipe file and not tried yet.",
          brief: input.brief,
          elements: swipe.elements,
          angleId: swipe.angleId,
          visualStyleId: swipe.visualStyleId,
          format: input.format,
          count: input.count,
          copyPackageId: input.copyPackageId,
          status: "proposed",
        })
        .returning();
      return { mode: input.mode, suggestionId: suggestion.id };
    }),

  copyPackages: studioProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .query(async ({ input, ctx }) => {
      const conditions = [eq(studioCopyPackages.organizationId, ctx.organizationId)];
      if (!input?.includeArchived) conditions.push(isNull(studioCopyPackages.archivedAt));
      return db
        .select()
        .from(studioCopyPackages)
        .where(and(...conditions))
        .orderBy(desc(studioCopyPackages.createdAt));
    }),

  createCopyPackage: studioWriteProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        angleId: z.string().nullable().optional(),
        primaryText: z.string().min(1),
        headline: z.string().min(1),
        description: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await requireTaxonomyValue(ctx.organizationId, input.angleId, "angle");
      const [pkg] = await db
        .insert(studioCopyPackages)
        .values({ organizationId: ctx.organizationId, ...input })
        .returning();
      return pkg;
    }),

  updateCopyPackage: studioWriteProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1).max(120).optional(),
        angleId: z.string().nullable().optional(),
        primaryText: z.string().min(1).optional(),
        headline: z.string().min(1).optional(),
        description: z.string().optional(),
        archived: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, archived, ...values } = input;
      await requireTaxonomyValue(ctx.organizationId, values.angleId, "angle");
      const [pkg] = await db
        .update(studioCopyPackages)
        .set({
          ...values,
          archivedAt: archived === undefined ? undefined : archived ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(studioCopyPackages.id, id),
            eq(studioCopyPackages.organizationId, ctx.organizationId),
          ),
        )
        .returning();
      if (!pkg) throw new TRPCError({ code: "NOT_FOUND", message: "Copy package not found" });
      return pkg;
    }),

  createCopyPackageFromCreative: studioWriteProcedure
    .input(
      z.object({
        creativeId: z.string(),
        name: z.string().trim().min(1).max(120).optional(),
        angleId: z.string().nullable().optional(),
        primaryText: z.string().trim().min(1).optional(),
        headline: z.string().trim().min(1).optional(),
        description: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [row] = await db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          angle: adCreatives.angle,
          caption: ads.caption,
        })
        .from(adCreatives)
        .leftJoin(
          ads,
          and(
            eq(ads.adCreativeId, adCreatives.id),
            eq(ads.organizationId, ctx.organizationId),
          ),
        )
        .where(
          and(
            eq(adCreatives.id, input.creativeId),
            eq(adCreatives.organizationId, ctx.organizationId),
          ),
        )
        .orderBy(desc(ads.updatedAt))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Creative not found" });
      await requireTaxonomyValue(ctx.organizationId, input.angleId, "angle");
      let angleId = input.angleId ?? null;
      if (!angleId && row.angle?.trim()) {
        const [angle] = await db
          .select({ id: studioTaxonomyValues.id })
          .from(studioTaxonomyValues)
          .where(
            and(
              eq(studioTaxonomyValues.organizationId, ctx.organizationId),
              eq(studioTaxonomyValues.kind, "angle"),
              eq(studioTaxonomyValues.slug, studioSlug(row.angle)),
            ),
          )
          .limit(1);
        if (angle) {
          angleId = angle.id;
        } else {
          const [createdAngle] = await db
            .insert(studioTaxonomyValues)
            .values({
              organizationId: ctx.organizationId,
              kind: "angle",
              name: row.angle.trim(),
              slug: studioSlug(row.angle),
            })
            .onConflictDoUpdate({
              target: [
                studioTaxonomyValues.organizationId,
                studioTaxonomyValues.kind,
                studioTaxonomyValues.slug,
              ],
              set: { name: row.angle.trim(), updatedAt: new Date() },
            })
            .returning({ id: studioTaxonomyValues.id });
          angleId = createdAngle?.id ?? null;
        }
      }
      const primaryText = input.primaryText ?? row.caption?.trim();
      if (!primaryText) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This creative has no synced primary text to save",
        });
      }
      const [pkg] = await db
        .insert(studioCopyPackages)
        .values({
          organizationId: ctx.organizationId,
          name: input.name ?? row.name,
          angleId,
          primaryText,
          headline: input.headline ?? row.name,
          description: input.description ?? "",
          sourceCreativeId: row.id,
        })
        .returning();
      return pkg;
    }),

  winningAngles: studioProcedure.query(async ({ ctx }) => {
    const rows = await fetchCreativePerformanceRows(ctx.organizationId, [
      sql`nullif(trim(${adCreatives.angle}), '') is not null`,
    ]);
    const byAngle = new Map<string, {
      angle: string;
      awarenessCounts: Map<string, number>;
      adCount: number;
      spend: number;
      purchases: number;
      purchaseValue: number;
      assetUrl: string | null;
      bestValue: number;
    }>();
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
      .map((group) => ({
        angle: group.angle,
        awarenessLevel: (Array.from(group.awarenessCounts.entries()).sort(
          (a, b) => b[1] - a[1],
        )[0]?.[0] ?? null) as AwarenessLevel | null,
        adCount: group.adCount,
        roas: group.spend > 0 ? group.purchaseValue / group.spend : 0,
        spend: group.spend,
        purchases: group.purchases,
        assetUrl: group.assetUrl,
      }))
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
      .select()
      .from(studioGenerations)
      .where(eq(studioGenerations.organizationId, ctx.organizationId))
      .orderBy(desc(studioGenerations.createdAt))
      .limit(50);
    if (generations.length === 0) return [];
    const staleIds = await reconcileStaleGenerations(ctx.organizationId, generations);
    for (const generation of generations) {
      if (staleIds.includes(generation.id)) generation.status = "failed";
    }
    const generationIds = generations.map((generation) => generation.id);
    const [variants, packages] = await Promise.all([
      db
        .select()
        .from(studioVariants)
        .where(
          and(
            eq(studioVariants.organizationId, ctx.organizationId),
            inArray(studioVariants.generationId, generationIds),
          ),
        )
        .orderBy(asc(studioVariants.index)),
      db
        .select()
        .from(studioCopyPackages)
        .where(eq(studioCopyPackages.organizationId, ctx.organizationId)),
    ]);
    const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
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
        ? sources.get(generation.sourceCreativeId) ?? null
        : null,
      variants: (variantsByGenerationId.get(generation.id) ?? []).map((variant) => ({
        ...variant,
        copyPackage: variant.copyPackageId
          ? packageById.get(variant.copyPackageId) ?? null
          : null,
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
      if (!generation) throw new TRPCError({ code: "NOT_FOUND", message: "Generation not found" });
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
      const packageIds = variants.flatMap((variant) =>
        variant.copyPackageId ? [variant.copyPackageId] : [],
      );
      const linkedCreativeIds = Array.from(
        new Set(
          variants.flatMap((variant) =>
            variant.linkedCreativeId ? [variant.linkedCreativeId] : [],
          ),
        ),
      );
      const [packages, linkedCreatives, linkedPerformance, sources] = await Promise.all([
        packageIds.length
          ? db
              .select()
              .from(studioCopyPackages)
              .where(
                and(
                  eq(studioCopyPackages.organizationId, ctx.organizationId),
                  inArray(studioCopyPackages.id, packageIds),
                ),
              )
          : [],
        linkedCreativeIds.length
          ? db
              .select({
                id: adCreatives.id,
                name: adCreatives.name,
                assetUrl: adCreatives.assetUrl,
                format: adCreatives.format,
              })
              .from(adCreatives)
              .where(
                and(
                  eq(adCreatives.organizationId, ctx.organizationId),
                  inArray(adCreatives.id, linkedCreativeIds),
                ),
              )
          : [],
        linkedCreativeIds.length
          ? fetchCreativePerformanceRows(ctx.organizationId, [
              inArray(adCreatives.id, linkedCreativeIds),
            ])
          : [],
        fetchSourceCreatives(
          ctx.organizationId,
          generation.sourceCreativeId ? [generation.sourceCreativeId] : [],
        ),
      ]);
      const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
      const linkedRoasById = new Map(
        linkedPerformance.map((row) => [row.creativeId, toNullableNumber(row.roas)]),
      );
      const linkedCreativeById = new Map(
        linkedCreatives.map((creative) => [
          creative.id,
          { ...creative, roas: linkedRoasById.get(creative.id) ?? null },
        ]),
      );
      const realtime =
        generation.status === "generating" && generation.runId
          ? {
              runId: generation.runId,
              publicAccessToken: await triggerAuth.createPublicToken({
                scopes: { read: { runs: [generation.runId] } },
                expirationTime: "1h",
              }),
            }
          : null;
      return {
        generation,
        variants: variants.map((variant) => ({
          ...variant,
          copyPackage: variant.copyPackageId
            ? packageById.get(variant.copyPackageId) ?? null
            : null,
          linkedCreative: variant.linkedCreativeId
            ? linkedCreativeById.get(variant.linkedCreativeId) ?? null
            : null,
        })),
        realtime,
        source: generation.sourceCreativeId
          ? sources.get(generation.sourceCreativeId) ?? null
          : null,
      };
    }),

  linkCandidates: studioProcedure
    .input(
      z.object({
        search: z.string().trim().max(80).optional(),
        publishedAfter: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const parsedPublishedAfter = input.publishedAfter
        ? new Date(input.publishedAfter)
        : null;
      const publishedAfter =
        parsedPublishedAfter && !Number.isNaN(parsedPublishedAfter.getTime())
          ? parsedPublishedAfter
          : null;
      const conditions = [eq(adCreatives.organizationId, ctx.organizationId)];
      if (input.search) {
        conditions.push(ilike(adCreatives.name, `%${input.search}%`));
      }
      const creatives = await db
        .select({
          id: adCreatives.id,
          name: adCreatives.name,
          assetUrl: adCreatives.assetUrl,
          format: adCreatives.format,
          createdAt: adCreatives.createdAt,
        })
        .from(adCreatives)
        .where(and(...conditions))
        .orderBy(
          ...(publishedAfter
            ? [
                sql`case when ${adCreatives.format} = 'static' and ${adCreatives.createdAt} >= ${publishedAfter} then 0 else 1 end`,
                desc(adCreatives.createdAt),
              ]
            : [desc(adCreatives.createdAt)]),
        )
        .limit(30);
      if (creatives.length === 0) return [];

      const performance = await fetchCreativePerformanceRows(ctx.organizationId, [
        inArray(adCreatives.id, creatives.map((creative) => creative.id)),
      ]);
      const performanceById = new Map(
        performance.map((row) => [
          row.creativeId,
          {
            roas: toNullableNumber(row.roas),
            spend: toNullableNumber(row.spend),
          },
        ]),
      );
      return creatives.map((creative) => ({
        ...creative,
        roas: performanceById.get(creative.id)?.roas ?? null,
        spend: performanceById.get(creative.id)?.spend ?? null,
      }));
    }),

  linkVariantToCreative: studioWriteProcedure
    .input(
      z.object({
        variantId: z.string(),
        creativeId: z.string().nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [variant] = await db
        .select({ id: studioVariants.id, publishedAt: studioVariants.publishedAt })
        .from(studioVariants)
        .where(
          and(
            eq(studioVariants.id, input.variantId),
            eq(studioVariants.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!variant) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Image not found" });
      }

      if (input.creativeId) {
        if (!variant.publishedAt) {
          throw new TRPCError({ code: "CONFLICT", message: "Publish the image first" });
        }
        const [creative] = await db
          .select({ id: adCreatives.id })
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
      }

      await db
        .update(studioVariants)
        .set({ linkedCreativeId: input.creativeId, updatedAt: new Date() })
        .where(
          and(
            eq(studioVariants.id, variant.id),
            eq(studioVariants.organizationId, ctx.organizationId),
          ),
        );
      return { ok: true };
    }),

  setVariantMark: studioWriteProcedure
    .input(z.object({ variantId: z.string(), mark: markSchema.nullable() }))
    .mutation(async ({ input, ctx }) => {
      const [variant] = await db
        .update(studioVariants)
        .set({
          mark: input.mark,
          publishedAt: input.mark === "good" ? undefined : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(studioVariants.id, input.variantId),
            eq(studioVariants.organizationId, ctx.organizationId),
            eq(studioVariants.status, "ready"),
          ),
        )
        .returning({
          id: studioVariants.id,
          mark: studioVariants.mark,
          publishedAt: studioVariants.publishedAt,
        });
      if (!variant) throw new TRPCError({ code: "NOT_FOUND", message: "Image not found" });
      return variant;
    }),

  setVariantPublished: studioWriteProcedure
    .input(z.object({ variantId: z.string(), published: z.boolean().default(true) }))
    .mutation(async ({ input, ctx }) => {
      const [variant] = await db
        .update(studioVariants)
        .set({ publishedAt: input.published ? new Date() : null, updatedAt: new Date() })
        .where(
          and(
            eq(studioVariants.id, input.variantId),
            eq(studioVariants.organizationId, ctx.organizationId),
            eq(studioVariants.status, "ready"),
            eq(studioVariants.mark, "good"),
          ),
        )
        .returning({ id: studioVariants.id, publishedAt: studioVariants.publishedAt });
      if (!variant) {
        throw new TRPCError({ code: "CONFLICT", message: "Only Good images can be published" });
      }
      return variant;
    }),

  retryVariant: studioWriteProcedure
    .input(z.object({ variantId: z.string(), withoutReferenceImage: z.boolean().default(false) }))
    .mutation(async ({ input, ctx }) => {
      const claimed = await db.transaction(async (tx) => {
        const [variant] = await tx
          .select({
            id: studioVariants.id,
            index: studioVariants.index,
            generationId: studioVariants.generationId,
            status: studioVariants.status,
            moderationReason: studioVariants.moderationReason,
            prompt: studioVariants.prompt,
            brief: studioGenerations.brief,
            angle: studioGenerations.angle,
            persona: studioGenerations.persona,
            awarenessLevel: studioGenerations.awarenessLevel,
            count: studioGenerations.count,
            format: studioGenerations.format,
            referenceImageUrls: studioGenerations.referenceImageUrls,
          })
          .from(studioVariants)
          .innerJoin(studioGenerations, eq(studioGenerations.id, studioVariants.generationId))
          .where(
            and(
              eq(studioVariants.id, input.variantId),
              eq(studioVariants.organizationId, ctx.organizationId),
              eq(studioGenerations.organizationId, ctx.organizationId),
            ),
          )
          .for("update");
        if (!variant) throw new TRPCError({ code: "NOT_FOUND", message: "Variant not found" });
        if (variant.status !== "failed") {
          throw new TRPCError({ code: "CONFLICT", message: "Only failed images can be retried" });
        }
        if (input.withoutReferenceImage && !variant.moderationReason) {
          throw new TRPCError({ code: "CONFLICT", message: "This image was not blocked by moderation" });
        }
        await tx
          .update(studioVariants)
          .set({
            status: "pending",
            imageUrl: null,
            prompt: null,
            mark: null,
            publishedAt: null,
            moderationReason: null,
            retryWithoutImageAt: input.withoutReferenceImage ? new Date() : undefined,
            updatedAt: new Date(),
          })
          .where(eq(studioVariants.id, variant.id));
        await tx
          .update(studioGenerations)
          .set({ status: "generating", updatedAt: new Date() })
          .where(eq(studioGenerations.id, variant.generationId));
        return variant;
      });
      const brand = await getStudioBrandProfile(ctx.organizationId);
      const layoutReferenceUrls = input.withoutReferenceImage
        ? []
        : claimed.referenceImageUrls ?? [];
      const retryReferenceImageUrls = input.withoutReferenceImage
        ? undefined
        : brand?.productImageUrl &&
            !layoutReferenceUrls.includes(brand.productImageUrl)
          ? [...layoutReferenceUrls, brand.productImageUrl]
          : claimed.referenceImageUrls ?? undefined;
      // Reuse the exact prompt the variant was generated with (the rewritten
      // one when the rewrite stage ran) so a retry stays consistent with its
      // siblings; fall back to the template prompt for pre-rewrite rows.
      const retryPrompt = claimed.prompt?.trim() || null;
      try {
        await tasks.trigger<typeof generateStaticAdVariantTask>(
          "generate-static-ad-variant",
          {
            generationId: claimed.generationId,
            organizationId: ctx.organizationId,
            variantIndex: claimed.index,
            basePrompt:
              retryPrompt ??
              buildPrompt({
                brief: claimed.brief,
                angle: claimed.angle,
                persona: claimed.persona,
                awarenessLevel: claimed.awarenessLevel,
                format: claimed.format as StudioFormat,
                brand,
              }),
            artDirection: retryPrompt
              ? null
              : artDirectionFor(
                  claimed.index,
                  claimed.count,
                  layoutReferenceUrls.length > 0,
                ),
            format: claimed.format as StudioFormat,
            referenceImageUrls: retryReferenceImageUrls,
            finalizeGeneration: true,
          },
        );
      } catch (error) {
        await db
          .update(studioVariants)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(studioVariants.id, claimed.id));
        await finalizeStudioGenerationIfSettled(claimed.generationId, ctx.organizationId);
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
      if (!creative) throw new TRPCError({ code: "NOT_FOUND", message: "Creative not found" });
      return creative;
    }),
});
