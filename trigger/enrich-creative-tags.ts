/**
 * AI tag enrichment (spec §6.2, §6.3).
 *
 * Two passes, one task:
 *   1. Per-creative — one model call per `ad_creative` fills the enforced trio
 *      (persona / angle / awareness) plus the eight captured attributes.
 *   2. Per-ad-set — a cheap batched call classifies funnel stage from targeting
 *      and stamps every ad of the set.
 *
 * Both passes are resumable: each invocation processes a bounded batch and
 * loops until the candidate set is empty or the iteration cap is hit, so the
 * ~2,111-creative backfill can simply be run again. Nothing tracks attempts in
 * a column — a creative stops being a candidate once every enforced field has
 * an `attributesMeta` entry, whether `ai` or `human`.
 */
import { generateObject } from "ai";
import { logger, metadata, tags, task } from "@trigger.dev/sdk";
import { and, asc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { openai } from "@/lib/ai";
import {
  ANGLE_TYPES,
  AWARENESS_LEVELS,
  FUNNEL_STAGES,
  MODES,
  VISUAL_STYLES,
} from "@/lib/creative-taxonomy";
import {
  buildCreativeTagUpdate,
  resolveFunnelStageVerdicts,
  type CreativeTagModelOutput,
} from "@/lib/creative-tag-enrichment";
import { isVideoFile } from "@/lib/studio-assets";
import { adCreatives } from "@/schema/ad-creative";
import { adSets } from "@/schema/ad-set";
import { ads } from "@/schema/ad";
import { campaigns } from "@/schema/campaign";

const TAG_MODEL = "gpt-5.6-terra";
const CREATIVE_BATCH_SIZE = 25;
const AD_SET_BATCH_SIZE = 25;
const AD_SETS_PER_MODEL_CALL = 25;
const MAX_ITERATIONS = 40;

export type EnrichCreativeTagsPayload = {
  organizationId: string;
  /** Creatives per batch; the run loops over batches until done. */
  creativeLimit?: number;
  /** Ad sets per batch. */
  adSetLimit?: number;
  /** Safety cap on batches per invocation — the backfill resumes on re-run. */
  maxIterations?: number;
  skipCreatives?: boolean;
  skipAdSets?: boolean;
};

const creativeTagSchema = z.object({
  persona: z.string().nullable(),
  angle: z.string().nullable(),
  awarenessLevel: z.string().nullable(),
  confidence: z.object({
    persona: z.number().nullable(),
    angle: z.number().nullable(),
    awarenessLevel: z.number().nullable(),
  }),
  attributes: z.object({
    visualElements: z.array(z.string()).nullable(),
    visualStyle: z.string().nullable(),
    mode: z.string().nullable(),
    hook: z.string().nullable(),
    supportingTexts: z.array(z.string()).nullable(),
    cta: z.string().nullable(),
    promos: z.string().nullable(),
    disclaimer: z.string().nullable(),
  }),
});

const funnelStageBatchSchema = z.object({
  adSets: z.array(
    z.object({
      adSetId: z.string(),
      funnelStage: z.string().nullable(),
      confidence: z.number().nullable(),
    }),
  ),
});

const CREATIVE_SYSTEM_PROMPT = [
  "You tag paid-social ad creatives for a performance marketing team. Read the creative's copy and, when supplied, its image, then classify it.",
  "",
  "Return, on ad_creative:",
  `- persona: a short free-text description of who the ad speaks to (e.g. "post-partum mothers in their 30s"). Null if the copy gives no signal.`,
  `- angle: exactly one of ${ANGLE_TYPES.join(", ")}.`,
  `- awarenessLevel: exactly one of ${AWARENESS_LEVELS.join(", ")} — how much the reader is assumed to already know about the problem and the product.`,
  "- confidence: a number from 0 to 1 for each of persona, angle and awarenessLevel, independently.",
  "",
  "Also capture, in attributes (all optional — return null for anything you cannot actually see):",
  "- visualElements: open list of concrete things visible in the creative (product shot, before/after, phone screenshot, price badge, ...).",
  `- visualStyle: exactly one of ${VISUAL_STYLES.join(", ")}.`,
  `- mode: exactly one of ${MODES.join(", ")} — the overall tonal/colour treatment of the artwork.`,
  "- hook: the opening line that earns attention, verbatim.",
  "- supportingTexts: other on-image or body copy lines, verbatim.",
  "- cta: the call to action, verbatim.",
  "- promos: any offer, discount or bundle mentioned.",
  "- disclaimer: any fine print, legal or results-may-vary text.",
  "",
  "Rules: never invent a value to fill a slot — null is a valid, expected answer. Use the exact vocabulary strings above; a value outside the list is discarded. Report low confidence honestly rather than rounding up.",
].join("\n");

const FUNNEL_SYSTEM_PROMPT = [
  "You classify Meta ad sets by funnel stage from their targeting configuration.",
  "",
  `Return one entry per ad set with funnelStage as exactly one of ${FUNNEL_STAGES.join(", ")}, or null, plus a confidence from 0 to 1.`,
  "",
  "Conventions:",
  "- Retargeting signals — retarget, rmk, remarketing, dpa, viewcontent, add-to-cart / cart abandoners, purchasers, website custom audiences, customer lists — are bof.",
  "- Prospecting signals — lookalike / lal, broad, interest targeting, no custom audience, open targeting — are tof.",
  "- Warm-but-not-converting signals — engaged, video viewers, page/IG engagers, warm audiences — are mof.",
  "",
  "If the ad set gives no usable signal, return null for funnelStage. Untagged is an explicit, acceptable state; a guess written as fact is worse than no tag.",
  "Echo back the adSetId exactly as given.",
].join("\n");

function buildCreativeUserText(creative: {
  name: string;
  notes: string | null;
  caption: string | null;
  adName: string | null;
  format: string | null;
}): string {
  const lines = [`Creative name: ${creative.name}`];
  if (creative.format) lines.push(`Format: ${creative.format}`);
  if (creative.adName) lines.push(`Ad name: ${creative.adName}`);
  if (creative.caption) lines.push(`Ad caption / primary text:\n${creative.caption}`);
  if (creative.notes) lines.push(`Internal notes:\n${creative.notes}`);
  lines.push("Tag this creative.");
  return lines.join("\n\n");
}

function describeAdSet(row: {
  id: string;
  name: string;
  campaignName: string | null;
  targetingMethod: string[] | null;
  geos: string[] | null;
  demographics: string | null;
}) {
  return {
    adSetId: row.id,
    adSetName: row.name,
    campaignName: row.campaignName,
    targetingMethod: row.targetingMethod ?? [],
    geos: row.geos ?? [],
    demographics: row.demographics,
  };
}

/**
 * A creative is done when all three enforced fields carry provenance. `ai` and
 * `human` both count — re-runs refresh only what a human has not claimed, and
 * that refresh is an explicit re-trigger, not this backfill's job.
 */
const CREATIVE_PENDING_SQL = sql`NOT jsonb_exists_all(coalesce(${adCreatives.attributesMeta}, '{}'::jsonb), ARRAY['persona','angle','awarenessLevel']::text[])`;

async function enrichCreatives(params: {
  organizationId: string;
  limit: number;
  maxIterations: number;
}) {
  const skipIds: string[] = [];
  let processed = 0;
  let updated = 0;
  let failed = 0;
  let rejectedValues = 0;

  for (let iteration = 0; iteration < params.maxIterations; iteration += 1) {
    const candidates = await db
      .select({
        id: adCreatives.id,
        name: adCreatives.name,
        format: adCreatives.format,
        assetUrl: adCreatives.assetUrl,
        notes: adCreatives.notes,
        persona: adCreatives.persona,
        angle: adCreatives.angle,
        awarenessLevel: adCreatives.awarenessLevel,
        attributes: adCreatives.attributes,
        attributesMeta: adCreatives.attributesMeta,
      })
      .from(adCreatives)
      .where(
        and(
          eq(adCreatives.organizationId, params.organizationId),
          CREATIVE_PENDING_SQL,
          skipIds.length > 0 ? notInArray(adCreatives.id, skipIds) : undefined,
        ),
      )
      .orderBy(asc(adCreatives.createdAt))
      .limit(params.limit);

    if (candidates.length === 0) break;

    metadata.set(
      "step",
      `Tagging creatives (batch ${iteration + 1}, ${candidates.length})`,
    );

    const captionRows = await db
      .select({
        adCreativeId: ads.adCreativeId,
        adName: ads.name,
        caption: ads.caption,
      })
      .from(ads)
      .where(
        inArray(
          ads.adCreativeId,
          candidates.map((candidate) => candidate.id),
        ),
      );
    const contextByCreative = new Map<string, { adName: string | null; caption: string | null }>();
    for (const row of captionRows) {
      if (!row.adCreativeId) continue;
      const current = contextByCreative.get(row.adCreativeId);
      contextByCreative.set(row.adCreativeId, {
        adName: current?.adName ?? row.adName ?? null,
        caption: current?.caption ?? row.caption ?? null,
      });
    }

    for (const creative of candidates) {
      // Whatever happens below, this creative is not retried inside this run:
      // an unchanged row would otherwise be re-selected by the same query.
      skipIds.push(creative.id);
      processed += 1;

      const context = contextByCreative.get(creative.id);
      const userText = buildCreativeUserText({
        name: creative.name,
        notes: creative.notes,
        caption: context?.caption ?? null,
        adName: context?.adName ?? null,
        format: creative.format,
      });
      const imageUrl =
        creative.assetUrl && !isVideoFile(creative.assetUrl)
          ? creative.assetUrl
          : null;

      try {
        const result = await generateObject({
          model: openai(TAG_MODEL),
          schema: creativeTagSchema,
          system: CREATIVE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: imageUrl
                ? [
                    { type: "text" as const, text: userText },
                    { type: "image" as const, image: imageUrl },
                  ]
                : [{ type: "text" as const, text: userText }],
            },
          ],
        });

        const update = buildCreativeTagUpdate({
          existing: creative,
          output: result.object as CreativeTagModelOutput,
        });

        if (update.rejected.length > 0) {
          rejectedValues += update.rejected.length;
          logger.warn("Dropped out-of-vocabulary creative tags", {
            creativeId: creative.id,
            rejected: update.rejected,
          });
        }

        if (!update.changed) {
          logger.info("No creative tag changes to write", {
            creativeId: creative.id,
            skippedHuman: update.skippedHuman,
          });
          continue;
        }

        await db
          .update(adCreatives)
          .set({
            ...(update.persona !== undefined ? { persona: update.persona } : {}),
            ...(update.angle !== undefined ? { angle: update.angle } : {}),
            ...(update.awarenessLevel !== undefined
              ? { awarenessLevel: update.awarenessLevel }
              : {}),
            attributes: update.attributes,
            attributesMeta: update.attributesMeta,
          })
          .where(eq(adCreatives.id, creative.id));
        updated += 1;
      } catch (error) {
        failed += 1;
        logger.error("Creative tag enrichment failed", {
          creativeId: creative.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { processed, updated, failed, rejectedValues };
}

async function enrichAdSetFunnelStages(params: {
  organizationId: string;
  limit: number;
  maxIterations: number;
}) {
  const skipIds: string[] = [];
  let processed = 0;
  let adsStamped = 0;
  let failed = 0;
  let rejectedValues = 0;

  for (let iteration = 0; iteration < params.maxIterations; iteration += 1) {
    const candidates = await db
      .select({
        id: adSets.id,
        name: adSets.name,
        campaignName: campaigns.name,
        targetingMethod: adSets.targetingMethod,
        geos: adSets.geos,
        demographics: adSets.demographics,
      })
      .from(adSets)
      .leftJoin(campaigns, eq(adSets.campaignId, campaigns.id))
      .where(
        and(
          eq(adSets.organizationId, params.organizationId),
          sql`EXISTS (SELECT 1 FROM ${ads} WHERE ${ads.adSetId} = ${adSets.id} AND ${ads.metaId} IS NOT NULL AND ${ads.funnelStage} IS NULL AND (${ads.funnelStageSource} IS NULL OR ${ads.funnelStageSource} <> 'human'))`,
          skipIds.length > 0 ? notInArray(adSets.id, skipIds) : undefined,
        ),
      )
      .orderBy(asc(adSets.createdAt))
      .limit(params.limit);

    if (candidates.length === 0) break;

    metadata.set(
      "step",
      `Classifying ad-set funnel stage (batch ${iteration + 1}, ${candidates.length})`,
    );

    for (let start = 0; start < candidates.length; start += AD_SETS_PER_MODEL_CALL) {
      const chunk = candidates.slice(start, start + AD_SETS_PER_MODEL_CALL);
      for (const row of chunk) skipIds.push(row.id);
      processed += chunk.length;

      try {
        const result = await generateObject({
          model: openai(TAG_MODEL),
          schema: funnelStageBatchSchema,
          system: FUNNEL_SYSTEM_PROMPT,
          prompt: `Classify these ad sets:\n${JSON.stringify(chunk.map(describeAdSet), null, 2)}`,
        });

        const { accepted, rejected } = resolveFunnelStageVerdicts({
          knownAdSetIds: chunk.map((row) => row.id),
          verdicts: result.object.adSets,
        });

        if (rejected.length > 0) {
          rejectedValues += rejected.length;
          logger.warn("Dropped out-of-vocabulary funnel stages", { rejected });
        }

        for (const verdict of accepted) {
          const stamped = await db
            .update(ads)
            .set({
              funnelStage: verdict.funnelStage,
              funnelStageSource: "ai",
              funnelStageConfidence:
                verdict.confidence === null ? null : String(verdict.confidence),
            })
            .where(
              and(
                eq(ads.adSetId, verdict.adSetId),
                eq(ads.organizationId, params.organizationId),
                isNotNull(ads.metaId),
                sql`(${ads.funnelStageSource} IS NULL OR ${ads.funnelStageSource} <> 'human')`,
              ),
            )
            .returning({ id: ads.id });
          adsStamped += stamped.length;
        }
      } catch (error) {
        failed += chunk.length;
        logger.error("Funnel stage classification failed", {
          adSetIds: chunk.map((row) => row.id),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { processed, adsStamped, failed, rejectedValues };
}

export const enrichCreativeTagsTask = task({
  id: "enrich-creative-tags",
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
  },
  queue: { name: "enrich-creative-tags", concurrencyLimit: 1 },
  run: async (payload: EnrichCreativeTagsPayload) => {
    await tags.add(`enrich-creative-tags:org:${payload.organizationId}`);
    const maxIterations = payload.maxIterations ?? MAX_ITERATIONS;

    metadata.set("status", "running");
    metadata.set("organizationId", payload.organizationId);

    const creatives = payload.skipCreatives
      ? { processed: 0, updated: 0, failed: 0, rejectedValues: 0 }
      : await enrichCreatives({
          organizationId: payload.organizationId,
          limit: payload.creativeLimit ?? CREATIVE_BATCH_SIZE,
          maxIterations,
        });

    const adSetsResult = payload.skipAdSets
      ? { processed: 0, adsStamped: 0, failed: 0, rejectedValues: 0 }
      : await enrichAdSetFunnelStages({
          organizationId: payload.organizationId,
          limit: payload.adSetLimit ?? AD_SET_BATCH_SIZE,
          maxIterations,
        });

    metadata.set("status", "completed");
    metadata.set("step", "Completed AI tag enrichment");

    logger.info("Completed AI tag enrichment", {
      organizationId: payload.organizationId,
      creatives,
      adSets: adSetsResult,
    });

    return {
      creatives,
      adSets: adSetsResult,
      summary: `Tagged ${creatives.updated} creatives and stamped ${adSetsResult.adsStamped} ads with a funnel stage`,
    };
  },
});
