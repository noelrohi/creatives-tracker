import { z } from "zod";
import { createSelectSchema } from "drizzle-zod";
import { tasks } from "@trigger.dev/sdk";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { orgProcedure, orgWriteProcedure } from "../init";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import {
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
import {
  fetchCreativePerformanceRows,
  toNumber,
} from "@/lib/studio-performance";
import { failStudioGeneration } from "@/lib/studio-generation-status";
import {
  buildRebrandBrief,
  buildRebrandPrompt,
  isStudioFormat,
  type StudioFormat,
} from "@/lib/studio-prompt";
import { buildElementsBrief } from "@/lib/studio-suggestions";
import {
  STUDIO_ANGLE_SEEDS,
  STUDIO_HOOK_TYPE_SEEDS,
  STUDIO_STYLE_SEEDS,
  studioSlug,
} from "@/lib/studio-taxonomy";
import type { generateStaticAdsTask } from "../../../../trigger/generate-static-ads";

export const awarenessLevelSchema = z.enum(AWARENESS_LEVELS);
export const studioFormatSchema = z
  .string()
  .refine(isStudioFormat, "Unsupported image dimensions")
  .transform((value) => value as StudioFormat);
export const remoteImageUrlSchema = z
  .string()
  .url()
  .refine(isHttpUrl, "Reference images must use HTTP or HTTPS");
export const persistedSwipeImageUrlSchema = remoteImageUrlSchema.refine((value) => {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "blob.vercel-storage.com" ||
    hostname.endsWith(".blob.vercel-storage.com");
}, "Swipe screenshots must be uploaded before saving");
export const taxonomyKindSchema = z.enum([
  "angle",
  "visual_style",
  "hook_type",
]);
export const markSchema = z.enum(["good", "bad"]);
export const studioCopyPackageRowSchema = createSelectSchema(studioCopyPackages);
export const studioGenerationRowSchema = createSelectSchema(studioGenerations);
export const studioSuggestionRowSchema = createSelectSchema(studioSuggestions);
export const studioVariantRowSchema = createSelectSchema(studioVariants);
export const sourceCreativeSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  assetUrl: z.string().nullable(),
  format: z.string().nullable(),
  roas: z.number().nullable(),
});
export const queuedGenerationSchema = z.object({
  runId: z.string(),
  generationId: z.string(),
});
const STALE_GENERATION_MS = 15 * 60 * 1000;

function requireImageStudioEnabled() {
  if (!isImageStudioEnabled()) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Image Studio is not enabled" });
  }
}

export const studioProcedure = orgProcedure.use(async ({ next }) => {
  requireImageStudioEnabled();
  return next();
});
export const studioWriteProcedure = orgWriteProcedure.use(async ({ next }) => {
  requireImageStudioEnabled();
  return next();
});

export function startOfStudioWeek(now = new Date()) {
  const start = new Date(now);
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - ((day + 6) % 7));
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export function normalizeOptionalUrl(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const url = new URL(trimmed);
  url.hash = "";
  return url.toString();
}

export async function requireTaxonomyValue(
  organizationId: string,
  id: string | null | undefined,
  kind: "angle" | "visual_style" | "hook_type",
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
      message:
        kind === "angle"
          ? "Invalid angle tag"
          : kind === "visual_style"
            ? "Invalid visual-style tag"
            : "Invalid hook-type tag",
    });
  }
}

export async function requireCopyPackage(
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

export type SourceCreativeSummary = {
  id: string;
  name: string;
  assetUrl: string | null;
  format: string | null;
  roas: number | null;
};

export async function fetchSourceCreatives(
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

export async function reconcileStaleGenerations(
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

export type CreateStudioGenerationParams = {
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
export async function createStudioGeneration(
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

export const EXTEND_WINNER_BRIEF =
  "Make 3 more like this proven winner — keep what works, vary one element per variant.";

export async function extendStudioWinner(
  organizationId: string,
  input: { variantId?: string; creativeId?: string },
) {
  if (!input.variantId && !input.creativeId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Winner source is required" });
  }
  const [source] = await db
    .select({
      imageUrl: studioVariants.imageUrl,
      linkedCreativeId: studioVariants.linkedCreativeId,
      brief: studioGenerations.brief,
      angle: studioGenerations.angle,
      format: studioGenerations.format,
      copyPackageId: studioGenerations.copyPackageId,
    })
    .from(studioVariants)
    .innerJoin(
      studioGenerations,
      eq(studioGenerations.id, studioVariants.generationId),
    )
    .where(
      and(
        eq(studioVariants.organizationId, organizationId),
        eq(studioGenerations.organizationId, organizationId),
        or(
          input.variantId
            ? eq(studioVariants.id, input.variantId)
            : undefined,
          input.creativeId
            ? eq(studioVariants.linkedCreativeId, input.creativeId)
            : undefined,
        ),
      ),
    )
    .orderBy(desc(studioVariants.createdAt))
    .limit(1);
  if (!source) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Image not found" });
  }
  if (!source.linkedCreativeId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Link this image to a live ad before extending it",
    });
  }
  if (!source.imageUrl) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This image is not ready to extend",
    });
  }
  return createStudioGeneration(organizationId, {
    brief: [EXTEND_WINNER_BRIEF, source.brief].join("\n"),
    angle: source.angle ?? undefined,
    count: 3,
    format: isStudioFormat(source.format) ? source.format : "square",
    referenceImageUrls: [source.imageUrl],
    sourceCreativeId: source.linkedCreativeId,
    copyPackageId: source.copyPackageId,
  });
}

export async function latestPackageForAngle(
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

export async function queueClaimedSuggestion(
  organizationId: string,
  suggestion: typeof studioSuggestions.$inferSelect,
  copyPackageOverride?: string | null,
  referenceImageOverride?: string[],
) {
  if (suggestion.kind === "extend_winner" && suggestion.sourceCreativeId) {
    const generation = await extendStudioWinner(organizationId, {
      creativeId: suggestion.sourceCreativeId,
    });
    await db
      .update(studioSuggestions)
      .set({ generationId: generation.generationId, updatedAt: new Date() })
      .where(
        and(
          eq(studioSuggestions.id, suggestion.id),
          eq(studioSuggestions.organizationId, organizationId),
          isNull(studioSuggestions.generationId),
        ),
      );
    return generation;
  }
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
        brand,
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

export async function seedTaxonomy(organizationId: string) {
  const rows = [
    ...STUDIO_ANGLE_SEEDS.map((name) => ({ kind: "angle", name })),
    ...STUDIO_STYLE_SEEDS.map((name) => ({ kind: "visual_style", name })),
    ...STUDIO_HOOK_TYPE_SEEDS.map((name) => ({ kind: "hook_type", name })),
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

export const generationInput = z.object({
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
