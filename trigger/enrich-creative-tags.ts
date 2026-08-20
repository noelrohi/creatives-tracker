/** Durable AI tag enrichment: bounded child batches under one parent run. */
import { generateObject } from "ai";
import { logger, metadata, tags, task } from "@trigger.dev/sdk";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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
import { resolveCreativeImageUrl } from "@/lib/creative-asset-repair";
import { adCreatives } from "@/schema/ad-creative";
import { adSets } from "@/schema/ad-set";
import { ads } from "@/schema/ad";
import { campaigns } from "@/schema/campaign";

const TAG_MODEL = "gpt-5.6-luna";
const CREATIVE_BATCH_SIZE = 10;
const AD_SET_BATCH_SIZE = 25;
const MAX_ITERATIONS = 500;

export type EnrichCreativeTagsPayload = {
  organizationId: string;
  /** Records handled by each bounded child task. */
  creativeLimit?: number;
  adSetLimit?: number;
  /** Safety cap per phase; re-run the parent to resume if reached. */
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
  "Rules: never invent a value to fill a slot — null is a valid, expected answer. Use the exact vocabulary strings above; a value outside the list is discarded, never stored. Report low confidence honestly rather than rounding up.",
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

const CREATIVE_PENDING_SQL = sql`NOT jsonb_exists_all(coalesce(${adCreatives.attributesMeta}, '{}'::jsonb), ARRAY['persona','angle','awarenessLevel']::text[])`;

function requireModelConfiguration() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for Intelligence enrichment");
  }
}

/**
 * The image is fetched by the model provider, not by us, so a failure comes
 * back as a generic API error naming the download. Anything else is a real
 * model failure and must keep propagating.
 */
function isImageFetchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /downloading file|upstream status code|invalid_image_url|timeout while downloading/i.test(
    message,
  );
}

function boundedLimit(value: number | undefined, fallback: number, max: number) {
  return Math.max(1, Math.min(value ?? fallback, max));
}

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

async function processCreativeBatch(params: {
  organizationId: string;
  afterId?: string | null;
  limit: number;
}) {
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
        params.afterId ? gt(adCreatives.id, params.afterId) : undefined,
      ),
    )
    .orderBy(asc(adCreatives.id))
    .limit(params.limit);

  if (candidates.length === 0) {
    return {
      processed: 0,
      updated: 0,
      adsStamped: 0,
      failed: 0,
      rejectedValues: 0,
      imagesRepaired: 0,
      imagesUnavailable: 0,
      nextCursor: null,
    };
  }

  const captionRows = await db
    .select({ adCreativeId: ads.adCreativeId, adName: ads.name, caption: ads.caption })
    .from(ads)
    .where(inArray(ads.adCreativeId, candidates.map((candidate) => candidate.id)));
  const contextByCreative = new Map<
    string,
    { adName: string | null; caption: string | null }
  >();
  for (const row of captionRows) {
    if (!row.adCreativeId) continue;
    const current = contextByCreative.get(row.adCreativeId);
    contextByCreative.set(row.adCreativeId, {
      adName: current?.adName ?? row.adName ?? null,
      caption: current?.caption ?? row.caption ?? null,
    });
  }

  let updated = 0;
  let failed = 0;
  let rejectedValues = 0;
  let imagesRepaired = 0;
  let imagesUnavailable = 0;

  for (const [index, creative] of candidates.entries()) {
    metadata
      .set("step", `Creative ${index + 1}/${candidates.length}: ${creative.name}`)
      .set("currentItem", {
        type: "creative",
        id: creative.id,
        name: creative.name,
        position: index + 1,
        total: candidates.length,
      });

    try {
      await logger.trace(
        `Creative ${index + 1}/${candidates.length} · ${creative.name}`,
        async () => {
          const context = contextByCreative.get(creative.id);
          const userText = buildCreativeUserText({
            name: creative.name,
            notes: creative.notes,
            caption: context?.caption ?? null,
            adName: context?.adName ?? null,
            format: creative.format,
          });
          metadata.set("itemStep", "Resolving creative image");
          const image = await resolveCreativeImageUrl({
            organizationId: params.organizationId,
            creativeId: creative.id,
            assetUrl: creative.assetUrl,
          });
          if (image.repaired) imagesRepaired += 1;
          if (image.outcome === "unreachable") {
            imagesUnavailable += 1;
            // Copy alone still yields usable tags, and tagging the row keeps it
            // from being re-picked — and re-failing — on every later run.
            logger.warn("Creative image unavailable; tagging from copy only", {
              creativeId: creative.id,
              creativeName: creative.name,
              assetUrl: creative.assetUrl,
            });
          }
          const imageUrl = image.url;

          const callModel = (withImage: string | null) =>
            generateObject({
              model: openai(TAG_MODEL),
              schema: creativeTagSchema,
              system: CREATIVE_SYSTEM_PROMPT,
              messages: [
                {
                  role: "user",
                  content: withImage
                    ? [
                        { type: "text" as const, text: userText },
                        { type: "image" as const, image: withImage },
                      ]
                    : [{ type: "text" as const, text: userText }],
                },
              ],
            });

          metadata.set("itemStep", "Calling Luna");
          const result = await logger.trace("Call Luna", async () => {
            try {
              return await callModel(imageUrl);
            } catch (error) {
              // The model fetches the image URL itself, so a host that serves us
              // can still refuse it. Falling back to copy beats losing the
              // creative to a permanently retried failure.
              if (!imageUrl || !isImageFetchError(error)) throw error;
              imagesUnavailable += 1;
              logger.warn("Model could not fetch the creative image; tagging from copy only", {
                creativeId: creative.id,
                creativeName: creative.name,
                imageUrl,
                error: error instanceof Error ? error.message : String(error),
              });
              return callModel(null);
            }
          });

          metadata.set("itemStep", "Validating and writing tags");
          await logger.trace("Validate and write tags", async () => {
            const update = buildCreativeTagUpdate({
              existing: creative,
              output: result.object as CreativeTagModelOutput,
            });
            rejectedValues += update.rejected.length;
            if (update.rejected.length > 0) {
              logger.warn("Dropped out-of-vocabulary creative tags", {
                creativeId: creative.id,
                rejected: update.rejected,
              });
            }
            if (!update.changed) return;

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
          });
          metadata.set("itemStep", "Completed");
        },
        {
          attributes: {
            "intelligence.item.type": "creative",
            "intelligence.item.id": creative.id,
            "intelligence.item.position": index + 1,
            "intelligence.item.total": candidates.length,
          },
        },
      );
    } catch (error) {
      failed += 1;
      metadata.set("itemStep", "Failed");
      logger.error("Creative tag enrichment failed", {
        creativeId: creative.id,
        creativeName: creative.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    processed: candidates.length,
    updated,
    adsStamped: 0,
    failed,
    rejectedValues,
    imagesRepaired,
    imagesUnavailable,
    nextCursor: candidates.at(-1)?.id ?? null,
  };
}

async function processAdSetBatch(params: {
  organizationId: string;
  afterId?: string | null;
  limit: number;
}) {
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
        sql`EXISTS (SELECT 1 FROM ${ads} WHERE ${ads.adSetId} = ${adSets.id} AND ${ads.metaId} IS NOT NULL AND ${ads.funnelStage} IS NULL AND ${ads.funnelStageSource} IS NULL)`,
        params.afterId ? gt(adSets.id, params.afterId) : undefined,
      ),
    )
    .orderBy(asc(adSets.id))
    .limit(params.limit);

  if (candidates.length === 0) {
    return {
      processed: 0,
      updated: 0,
      adsStamped: 0,
      failed: 0,
      rejectedValues: 0,
      imagesRepaired: 0,
      imagesUnavailable: 0,
      nextCursor: null,
    };
  }

  metadata
    .set("step", `Classifying ${candidates.length} ad sets with Luna`)
    .set("currentItem", {
      type: "ad_set_batch",
      ids: candidates.map((candidate) => candidate.id),
      total: candidates.length,
    })
    .set("itemStep", "Calling Luna");

  try {
    const result = await logger.trace(
      `Classify ${candidates.length} ad sets with Luna`,
      () =>
        generateObject({
          model: openai(TAG_MODEL),
          schema: funnelStageBatchSchema,
          system: FUNNEL_SYSTEM_PROMPT,
          prompt: `Classify these ad sets:\n${JSON.stringify(candidates.map(describeAdSet), null, 2)}`,
        }),
      {
        attributes: {
          "intelligence.item.type": "ad_set_batch",
          "intelligence.item.total": candidates.length,
        },
      },
    );
    metadata.set("itemStep", "Validating and writing stages");
    const { accepted, rejected } = resolveFunnelStageVerdicts({
      knownAdSetIds: candidates.map((row) => row.id),
      verdicts: result.object.adSets,
    });

    if (rejected.length > 0) {
      logger.warn("Dropped out-of-vocabulary funnel stages", { rejected });
    }

    let adsStamped = 0;
    const adSetNameById = new Map(candidates.map((row) => [row.id, row.name]));
    for (const [index, verdict] of accepted.entries()) {
      const adSetName = adSetNameById.get(verdict.adSetId) ?? verdict.adSetId;
      metadata
        .set("step", `Ad set ${index + 1}/${accepted.length}: ${adSetName}`)
        .set("currentItem", {
          type: "ad_set",
          id: verdict.adSetId,
          name: adSetName,
          position: index + 1,
          total: accepted.length,
        });
      const stamped = await logger.trace(
        `Ad set ${index + 1}/${accepted.length} · ${adSetName}`,
        () =>
          db
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
                isNull(ads.funnelStageSource),
              ),
            )
            .returning({ id: ads.id }),
        {
          attributes: {
            "intelligence.item.type": "ad_set",
            "intelligence.item.id": verdict.adSetId,
            "intelligence.funnel_stage": verdict.funnelStage ?? "untagged",
          },
        },
      );
      adsStamped += stamped.length;
    }
    metadata.set("itemStep", "Completed");

    return {
      processed: candidates.length,
      updated: 0,
      adsStamped,
      failed: 0,
      rejectedValues: rejected.length,
      imagesRepaired: 0,
      imagesUnavailable: 0,
      nextCursor: candidates.at(-1)?.id ?? null,
    };
  } catch (error) {
    metadata.set("itemStep", "Failed");
    logger.error("Funnel stage classification failed", {
      adSetIds: candidates.map((row) => row.id),
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      processed: candidates.length,
      updated: 0,
      adsStamped: 0,
      failed: candidates.length,
      rejectedValues: 0,
      imagesRepaired: 0,
      imagesUnavailable: 0,
      nextCursor: candidates.at(-1)?.id ?? null,
    };
  }
}

export const enrichCreativeTagsBatchTask = task({
  id: "enrich-creative-tags-batch",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000 },
  queue: { name: "enrich-creative-tags-batch", concurrencyLimit: 1 },
  maxDuration: 300,
  run: async (payload: {
    organizationId: string;
    phase: "creatives" | "ad_sets";
    afterId?: string | null;
    limit: number;
  }) => {
    requireModelConfiguration();
    return payload.phase === "creatives"
      ? processCreativeBatch(payload)
      : processAdSetBatch(payload);
  },
});

export const enrichCreativeTagsTask = task({
  id: "enrich-creative-tags",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000 },
  queue: { name: "enrich-creative-tags", concurrencyLimit: 1 },
  maxDuration: 3600,
  run: async (payload: EnrichCreativeTagsPayload) => {
    await tags.add(`enrich-creative-tags:org:${payload.organizationId}`);
    requireModelConfiguration();

    const maxIterations = payload.maxIterations ?? MAX_ITERATIONS;
    const creativeLimit = boundedLimit(
      payload.creativeLimit,
      CREATIVE_BATCH_SIZE,
      CREATIVE_BATCH_SIZE,
    );
    const adSetLimit = boundedLimit(payload.adSetLimit, AD_SET_BATCH_SIZE, AD_SET_BATCH_SIZE);
    const creatives = {
      processed: 0,
      updated: 0,
      failed: 0,
      rejectedValues: 0,
      imagesRepaired: 0,
      imagesUnavailable: 0,
    };
    const adSetResult = { processed: 0, adsStamped: 0, failed: 0, rejectedValues: 0 };

    if (!payload.skipCreatives) {
      let afterId: string | null = null;
      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        metadata
          .set("status", "running")
          .set("phase", "creatives")
          .set("step", `Tagging creative batch ${iteration + 1}`)
          .set("processed", creatives.processed)
          .set("updated", creatives.updated)
          .set("failed", creatives.failed)
          .set("cursor", afterId);
        const result = await enrichCreativeTagsBatchTask.triggerAndWait({
          organizationId: payload.organizationId,
          phase: "creatives",
          afterId,
          limit: creativeLimit,
        });
        if (!result.ok) {
          throw new Error(
            `Creative batch ${iteration + 1} failed after ${afterId ?? "start"}: ${String(result.error)}`,
          );
        }
        creatives.processed += result.output.processed;
        creatives.updated += result.output.updated ?? 0;
        creatives.failed += result.output.failed;
        creatives.rejectedValues += result.output.rejectedValues;
        creatives.imagesRepaired += result.output.imagesRepaired ?? 0;
        creatives.imagesUnavailable += result.output.imagesUnavailable ?? 0;
        if (!result.output.nextCursor) break;
        afterId = result.output.nextCursor;
      }
    }

    if (!payload.skipAdSets) {
      let afterId: string | null = null;
      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        metadata
          .set("phase", "ad_sets")
          .set("step", `Classifying ad-set batch ${iteration + 1}`)
          .set("processed", adSetResult.processed)
          .set("updated", adSetResult.adsStamped)
          .set("failed", adSetResult.failed)
          .set("cursor", afterId);
        const result = await enrichCreativeTagsBatchTask.triggerAndWait({
          organizationId: payload.organizationId,
          phase: "ad_sets",
          afterId,
          limit: adSetLimit,
        });
        if (!result.ok) {
          throw new Error(
            `Ad-set batch ${iteration + 1} failed after ${afterId ?? "start"}: ${String(result.error)}`,
          );
        }
        adSetResult.processed += result.output.processed;
        adSetResult.adsStamped += result.output.adsStamped ?? 0;
        adSetResult.failed += result.output.failed;
        adSetResult.rejectedValues += result.output.rejectedValues;
        if (!result.output.nextCursor) break;
        afterId = result.output.nextCursor;
      }
    }

    metadata.set("status", "completed").set("step", "Completed AI tag enrichment");
    logger.info("Completed AI tag enrichment", {
      organizationId: payload.organizationId,
      creatives,
      adSets: adSetResult,
    });
    return {
      creatives,
      adSets: adSetResult,
      summary: [
        `Tagged ${creatives.updated} creatives and stamped ${adSetResult.adsStamped} ads with a funnel-stage attempt`,
        creatives.imagesRepaired > 0
          ? `; repaired ${creatives.imagesRepaired} expired image URLs`
          : "",
        creatives.imagesUnavailable > 0
          ? `; ${creatives.imagesUnavailable} tagged from copy only (image unavailable)`
          : "",
      ].join(""),
    };
  },
});
