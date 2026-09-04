import {
  experimental_generateImage as generateImage,
  generateObject,
  generateText,
  stepCountIs,
  tool,
} from "ai";
import { logger, metadata, task, tags } from "@trigger.dev/sdk";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { openai } from "@/lib/ai";
import { pasteSourceRegion } from "@/lib/image-composite";
import { readImageDimensions, studioFormatForDimensions } from "@/lib/image-dimensions";
import { buildKeepMask, clampRegion, type ProductRegion } from "@/lib/image-mask";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";
import { isHttpUrl } from "@/lib/remote-image";
import { getStudioBrandProfile } from "@/lib/studio-brand";
import { putStudioObject, readStudioImage } from "@/lib/studio-storage";
import {
  loadStudioContextLibrary,
  readStudioContextSection,
} from "@/lib/studio-context";
import {
  failStudioGeneration,
  finalizeStudioGenerationIfSettled,
} from "@/lib/studio-generation-status";
import {
  fetchCreativePerformanceRows,
  toNullableNumber,
  toNumber,
} from "@/lib/studio-performance";
import { studioSizeFor, type StudioFormat } from "@/lib/studio-prompt";
import {
  buildVariationSystemPrompt,
  buildVariationUserContent,
  createVariationRun,
  finishInputSchema,
  generateImageInputSchema,
  MAX_STEPS,
  readContextInputSchema,
  resolveVariationOutcome,
  type VariationFailureReason,
  type VariationRunInput,
  type VariationSource,
} from "@/lib/variation-agent";
import type { VariationAttempt, VariationPlan } from "@/lib/variation-agent-types";
import { ads } from "@/schema/ad";
import { adCreatives } from "@/schema/ad-creative";
import { competitorAds } from "@/schema/competitor-signals";
import { performanceLogs } from "@/schema/performance-log";
import { studioGenerations, studioVariants } from "@/schema/studio";

const AGENT_MODEL = "gpt-5.6-terra";
const REVIEW_MODEL = "gpt-5.6-terra";
const LOCATOR_MODEL = "gpt-5.6-terra";
const IMAGE_MODEL = "gpt-image-2";
const PERFORMANCE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MODERATION_REASONS = [
  "claims",
  "likeness",
  "logo",
  "moderation",
] as const satisfies readonly VariationFailureReason[];

export type GenerateVariationPayload = {
  organizationId: string;
  generationId: string;
  variantId: string;
  source: { kind: "creative" | "competitor_ad"; id: string };
  note?: string | null;
  /** Set by "Retry without image": the source is never used as a layout reference. */
  withoutSourceImage?: boolean;
};

const reviewSchema = z.object({
  pass: z.boolean(),
  notes: z.array(z.string()),
});

// The locator's own schema is permissive: a box that overshoots by a rounding
// hair should be clamped, not thrown away with the whole edit path.
const productLocationSchema = z.object({
  product: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  confidence: z.number().min(0).max(1),
  note: z.string(),
});

/**
 * Finds the product in the source so an edit can protect it. Includes any
 * packaging the product sits in or on. Returns null on failure or when the
 * source shows no product, which sends the run down the generate path.
 */
async function locateSourceProduct(
  sourceBytes: Uint8Array,
  brandName: string | null,
): Promise<ProductRegion | null> {
  try {
    const result = await generateObject({
      model: openai(LOCATOR_MODEL),
      schema: productLocationSchema,
      system: [
        `Locate the advertised physical product${brandName ? ` (${brandName})` : ""} in this static ad.`,
        "Return one normalized bounding box (x, y, w, h in 0-1 from the top-left) that covers the whole product. When the product sits in, on, or beside its own packaging or case, cover both together. Do not include headline text, badges, or unrelated props.",
        "Return product: null when no physical product is visible (a text-only or lifestyle ad).",
      ].join("\n"),
      messages: [{ role: "user", content: [{ type: "image", image: sourceBytes }] }],
    });
    const { product, confidence, note } = result.object;
    const region = product ? clampRegion(product) : null;
    const area = region ? region.w * region.h : 0;
    // Too small is noise; too large leaves the variation nothing to change.
    const usable = region !== null && confidence >= 0.4 && area >= 0.005 && area <= 0.7;
    logger.info("Product locator", { found: Boolean(product), confidence, area, usable, note });
    return usable ? region : null;
  } catch (error) {
    logger.warn("Product locator failed; using generate mode", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return null;
  }
}

async function loadSource(
  payload: GenerateVariationPayload,
): Promise<VariationSource> {
  if (payload.source.kind === "creative") {
    const [row] = await db
      .select({
        id: adCreatives.id,
        name: adCreatives.name,
        assetUrl: adCreatives.assetUrl,
        notes: adCreatives.notes,
      })
      .from(adCreatives)
      .where(
        and(
          eq(adCreatives.id, payload.source.id),
          eq(adCreatives.organizationId, payload.organizationId),
        ),
      )
      .limit(1);
    if (!row?.assetUrl || !isHttpUrl(row.assetUrl)) {
      throw new Error("Source creative has no usable image URL");
    }
    const windowStart = new Date(Date.now() - PERFORMANCE_WINDOW_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const [[perf], [engagement]] = await Promise.all([
      fetchCreativePerformanceRows(payload.organizationId, [
        eq(adCreatives.id, row.id),
        gte(performanceLogs.dateStart, windowStart),
      ]),
      // The shared helper carries no click or impression sums, so CTR comes
      // from its own windowed aggregate over the same base filter.
      db
        .select({
          impressions: sql<string | null>`sum(${performanceLogs.impressions})::text`,
          linkClicks: sql<string | null>`sum(${performanceLogs.linkClicks})::text`,
        })
        .from(performanceLogs)
        .innerJoin(ads, eq(ads.id, performanceLogs.adId))
        .where(
          and(
            eq(ads.adCreativeId, row.id),
            eq(ads.organizationId, payload.organizationId),
            basePerformanceLogFilter("performance_log"),
            gte(performanceLogs.dateStart, windowStart),
          ),
        ),
    ]);
    const impressions = toNumber(engagement?.impressions);
    const linkClicks = toNumber(engagement?.linkClicks);
    return {
      kind: "creative",
      name: row.name,
      imageUrl: row.assetUrl,
      text: row.notes,
      performance: perf
        ? {
            spend: toNumber(perf.spend),
            roas: toNullableNumber(perf.roas),
            ctr: impressions > 0 ? (linkClicks / impressions) * 100 : null,
            purchases: perf.purchases ?? 0,
          }
        : null,
    };
  }

  const [ad] = await db
    .select({
      id: competitorAds.id,
      title: competitorAds.title,
      bodyText: competitorAds.bodyText,
      ctaText: competitorAds.ctaText,
      imageUrl: competitorAds.mirroredImageUrl,
    })
    .from(competitorAds)
    .where(
      and(
        eq(competitorAds.id, payload.source.id),
        eq(competitorAds.organizationId, payload.organizationId),
      ),
    )
    .limit(1);
  if (!ad?.imageUrl || !isHttpUrl(ad.imageUrl)) {
    throw new Error("Source competitor ad has no usable mirrored image");
  }
  return {
    kind: "competitor_ad",
    name: ad.title ?? "Competitor ad",
    imageUrl: ad.imageUrl,
    text: [ad.title, ad.bodyText, ad.ctaText].filter(Boolean).join("\n"),
    performance: null,
  };
}

type VariantUpdate = {
  status: "generating" | "ready" | "failed";
  imageUrl?: string | null;
  prompt?: string | null;
  plan?: VariationPlan | null;
  attempts?: VariationAttempt[] | null;
  moderationReason?: string | null;
};

export const generateVariationTask = task({
  id: "generate-variation",
  queue: { concurrencyLimit: 3 },
  maxDuration: 600,
  // Retries are inherited from trigger.config.ts. A retry after a post-loop
  // persistence failure must not re-spend image-model calls, so the run exits
  // early when the variant is already ready (see below); blob keys carry the
  // attempt number so a re-run never collides with a previous upload.
  // Marks the row failed only once every attempt is exhausted, or after a
  // maxDuration timeout or crash that never reaches the run's own catch.
  onFailure: async ({ payload }: { payload: GenerateVariationPayload }) => {
    await failStudioGeneration(payload.generationId, payload.organizationId);
  },
  run: async (payload: GenerateVariationPayload, { ctx }) => {
    await tags.add(`variation:org:${payload.organizationId}`);
    const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
    const steps: string[] = [];
    const onStep = (label: string) => {
      steps.push(label);
      metadata.set("steps", steps);
    };
    metadata.set("status", "generating");

    // A retried run whose previous attempt already produced and persisted the
    // image only needs to settle the generation status.
    const [existing] = await db
      .select({ status: studioVariants.status })
      .from(studioVariants)
      .where(
        and(
          eq(studioVariants.id, payload.variantId),
          eq(studioVariants.organizationId, payload.organizationId),
        ),
      )
      .limit(1);
    if (existing?.status === "ready") {
      const status = await finalizeStudioGenerationIfSettled(
        payload.generationId,
        payload.organizationId,
      );
      metadata.set("status", status ?? "generating");
      onStep("done");
      return { outcome: "ready" as const, reason: null };
    }

    onStep("loading source and context");

    const markVariant = (values: VariantUpdate) =>
      db
        .update(studioVariants)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(studioVariants.id, payload.variantId),
            eq(studioVariants.organizationId, payload.organizationId),
          ),
        );

    await markVariant({ status: "generating" });

    try {
      const [source, brand, library] = await Promise.all([
        loadSource(payload),
        getStudioBrandProfile(payload.organizationId),
        loadStudioContextLibrary(payload.organizationId),
      ]);

      // Fetch the source once: its bytes feed the agent, the image model, and
      // the header decides the output format, which the generation row then
      // records. Generated images are cached under their URL too, so the
      // review always gets bytes (a local-storage URL is not reachable by the
      // model provider).
      const imageBytes = new Map<string, Uint8Array>();
      const fetchBytes = async (url: string) => {
        const cached = imageBytes.get(url);
        if (cached) return cached;
        const bytes = await readStudioImage(url);
        imageBytes.set(url, bytes);
        return bytes;
      };
      const sourceBytes = await fetchBytes(source.imageUrl);
      const sourceDimensions = readImageDimensions(sourceBytes);
      const format: StudioFormat = studioFormatForDimensions(sourceDimensions);
      await db
        .update(studioGenerations)
        .set({ format, updatedAt: new Date() })
        .where(
          and(
            eq(studioGenerations.id, payload.generationId),
            eq(studioGenerations.organizationId, payload.organizationId),
          ),
        );

      let sourceProductRegion: ProductRegion | null = null;
      if (source.kind === "creative" && !payload.withoutSourceImage && sourceDimensions) {
        onStep("locating the product in the source");
        sourceProductRegion = await locateSourceProduct(sourceBytes, brand?.brandName ?? null);
      }

      const input: VariationRunInput = {
        source,
        sourceImage: sourceBytes,
        sourceProductRegion,
        note: payload.note ?? null,
        brand,
        library,
        format,
        useSourceLayout: !payload.withoutSourceImage,
      };

      const run = createVariationRun(input, {
        readSection: (documentId, sectionId) =>
          readStudioContextSection(payload.organizationId, documentId, sectionId),
        produceImage: async ({ prompt, mode, keepRegion, referenceImageUrls, format, attempt }) => {
          const references: Uint8Array[] = [];
          for (const url of referenceImageUrls) references.push(await fetchBytes(url));
          if (mode === "edit" && !sourceDimensions) {
            logger.warn("Edit mode without source dimensions; falling back to an unmasked call", { attempt });
          }
          const result = await logger.trace(`${mode === "edit" ? "Edit" : "Generate"} attempt ${attempt}`, () =>
            mode === "edit" && sourceDimensions
              ? generateImage({
                  model: openai.image(IMAGE_MODEL),
                  // references holds only the source in edit mode. The mask
                  // holds composition and placement; preservation happens in
                  // the paste below.
                  prompt: {
                    images: references,
                    mask: buildKeepMask({
                      width: sourceDimensions.width,
                      height: sourceDimensions.height,
                      keep: keepRegion,
                    }),
                    text: prompt,
                  },
                  size: studioSizeFor(format),
                })
              : generateImage({
                  model: openai.image(IMAGE_MODEL),
                  prompt: references.length ? { text: prompt, images: references } : prompt,
                  size: studioSizeFor(format),
                }),
          );
          // The mask is guidance only: the provider regenerates the whole
          // canvas at `size` and re-renders the product. Paste the source's
          // region back so the product is preserved by construction, and store
          // and review those bytes.
          const produced =
            mode === "edit" && keepRegion && sourceDimensions
              ? (await pasteSourceRegion({ source: sourceBytes, output: result.image.uint8Array, region: keepRegion })).bytes
              : result.image.uint8Array;
          const stored = await putStudioObject(
            `${env}/create/${ctx.run.id}-${ctx.attempt.number}-${attempt}.png`,
            produced,
            "image/png",
          );
          imageBytes.set(stored.url, produced);
          return { imageUrl: stored.url };
        },
        reviewImage: async ({ imageUrl, prompt, mode, keepRegion }) => {
          try {
            const content: Array<
              { type: "text"; text: string } | { type: "image"; image: Uint8Array }
            > = [
              {
                type: "text",
                text: `Review this generated ad against the prompt below and the checklist.\n\nPROMPT:\n${prompt}`,
              },
              { type: "image", image: await fetchBytes(imageUrl) },
            ];
            if (mode === "edit") {
              content.push({ type: "image", image: sourceBytes });
            } else if (brand?.productImageUrl) {
              content.push({ type: "image", image: await fetchBytes(brand.productImageUrl) });
            }
            const result = await generateObject({
              model: openai(REVIEW_MODEL),
              schema: reviewSchema,
              system: [
                mode === "edit"
                  ? "You are a strict creative reviewer for paid-social static ads. The first image is the generated ad, produced by editing the second image (the source); the source's product was pasted back into its box after the edit."
                  : "You are a strict creative reviewer for paid-social static ads. The first image is the generated ad; the second, when present, is the advertiser's real product photo.",
                "Checklist (all must hold for pass = true):",
                mode === "edit" && keepRegion
                  ? `- The product from the source has been pasted back into its box (${Math.round(keepRegion.x * 100)}% to ${Math.round((keepRegion.x + keepRegion.w) * 100)}% across, ${Math.round(keepRegion.y * 100)}% to ${Math.round((keepRegion.y + keepRegion.h) * 100)}% down). Check four things: its lighting, colour temperature, and perspective sit naturally against the new background; there is no visible rectangular seam or halo at the box edge; no second, re-rendered copy of the product appears anywhere outside the box; and the box does not cover copy or a focal element the prompt asked for. Name which of these failed.`
                  : "- The product matches the product photo in shape, openings, material, and markings; no invented logos or text on it.",
                "- Every line of ad copy (headline, subhead, badges, CTA, tile labels) is legible and matches the quoted copy in the prompt, with no garbled or invented copy. Incidental labels on props and packaging inside the scene (a shampoo bottle, a book spine) are fine and are not ad copy.",
                `- No logos or brand marks other than ${brand?.brandName ?? "the advertiser's"}; no platform UI, no watermarks.`,
                "- The palette is consistent with a clean brand look: no clashing neon, no split panels unless the prompt asked for them.",
                brand?.prohibitedClaims.length
                  ? `- None of these claims appear or are implied: ${brand.prohibitedClaims.join("; ")}.`
                  : null,
                "Return pass and a short list of concrete notes; on a pass, notes may be empty.",
              ]
                .filter(Boolean)
                .join("\n"),
              messages: [{ role: "user", content }],
            });
            return result.object;
          } catch (error) {
            // Fail closed: the review is the gate that lets an attempt ship
            // without an explicit finish, so an unreviewed image never becomes
            // ready on its own. The agent still sees the attempt and may
            // finish with it deliberately; the note stays in attempts.
            logger.warn("Variation review failed; treating as not passed", {
              error:
                error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
            return { pass: false, notes: ["review unavailable"] };
          }
        },
        onStep,
      });

      // A throwing tool aborts generateText; the attempts already recorded on
      // run.state must still decide the outcome, so the loop error is logged
      // and resolution proceeds.
      try {
        await logger.trace("Variation agent loop", () =>
          generateText({
            model: openai(AGENT_MODEL),
            system: buildVariationSystemPrompt(input),
            messages: [{ role: "user", content: buildVariationUserContent(input) }],
            stopWhen: [stepCountIs(MAX_STEPS)],
            tools: {
              readContext: tool({
                description:
                  "List a reference document's sections (omit sectionId) or read one section's content.",
                inputSchema: readContextInputSchema,
                execute: (raw) => run.readContext(raw),
              }),
              generateImage: tool({
                description:
                  "Generate one image from a finished prompt. Returns the attempt number and an automatic review. At most two calls; pass the returned attempt number to finish.",
                inputSchema: generateImageInputSchema,
                execute: (raw) => run.generateImage(raw),
              }),
              finish: tool({
                description: "End the run with the plan for the attempt you are shipping.",
                inputSchema: finishInputSchema,
                execute: (raw) => run.finish(raw),
              }),
            },
            // finish does not close the loop by itself: the model gets one more
            // step after it. Disarming the tools there stops a post-finish
            // generateImage call from spending another image-model call.
            prepareStep: () =>
              run.state.finished ? { toolChoice: "none", activeTools: [] } : undefined,
          }),
        );
      } catch (error) {
        logger.error("Variation agent loop ended with an error", {
          generationId: payload.generationId,
          variantId: payload.variantId,
          runId: ctx.run.id,
          imageCalls: run.state.imageCalls,
          contextReads: run.state.contextReads,
          attempts: run.state.attempts.length,
          error:
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }

      const outcome = resolveVariationOutcome(run.state);
      if (outcome.kind === "ready") {
        await markVariant({
          status: "ready",
          imageUrl: outcome.imageUrl,
          prompt:
            outcome.attempts.find((a) => a.attempt === outcome.plan.finalAttempt)
              ?.prompt ?? null,
          plan: outcome.plan,
          attempts: outcome.attempts,
          moderationReason: null,
        });
      } else {
        await markVariant({
          status: "failed",
          attempts: outcome.attempts,
          moderationReason: (MODERATION_REASONS as readonly string[]).includes(
            outcome.reason,
          )
            ? outcome.reason
            : null,
          plan: {
            summary: `Failed: ${outcome.reason}`,
            kept: [],
            changed: [],
            rationale: "",
            evidence: [],
            inImageCopy: [],
            finalAttempt: 0,
            synthesized: true,
          },
        });
      }
      const status = await finalizeStudioGenerationIfSettled(
        payload.generationId,
        payload.organizationId,
      );
      metadata.set("status", status ?? "generating");
      onStep(outcome.kind === "ready" ? "done" : `failed (${outcome.reason})`);
      return {
        outcome: outcome.kind,
        reason: outcome.kind === "failed" ? outcome.reason : null,
      };
    } catch (error) {
      logger.error("Variation generation failed", {
        generationId: payload.generationId,
        variantId: payload.variantId,
        runId: ctx.run.id,
        error:
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      // Rethrow without marking the row failed: Trigger may retry this
      // attempt, and onFailure marks the generation once retries are spent.
      throw error;
    }
  },
});
