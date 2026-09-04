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
import { pastePatch, pasteSourceRegion } from "@/lib/image-composite";
import { readImageDimensions, studioFormatForDimensions } from "@/lib/image-dimensions";
import { buildKeepMask, clampRegion, expandRegion, type ProductRegion } from "@/lib/image-mask";
import { matteProduct, type MatteResult } from "@/lib/image-matte";
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
import type {
  VariationAttempt,
  VariationPlan,
  VariationTransplant,
} from "@/lib/variation-agent-types";
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
const locatorBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
const productLocationSchema = z.object({
  product: locatorBoxSchema
    .nullable()
    .describe("Tight box around the physical product itself, or null when none is visible."),
  tile: locatorBoxSchema
    .nullable()
    .describe("Box around the card, tile, panel, or pedestal the product sits inside, or null."),
  confidence: z.number().min(0).max(1),
  note: z.string(),
});

/** True when `outer` contains the centre point of `inner`. */
function containsCentre(outer: ProductRegion, inner: ProductRegion) {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

/** A region as review-readable percentages of the canvas. */
function pct(region: ProductRegion) {
  return `${Math.round(region.x * 100)}% to ${Math.round((region.x + region.w) * 100)}% across and ${Math.round(region.y * 100)}% to ${Math.round((region.y + region.h) * 100)}% down`;
}

/**
 * Finds the product in an image, tightly, plus the card or pedestal it sits on
 * when there is one. On the source, `tile ?? product` is what an edit protects
 * and `product` is what the transplant cuts out; on a generated output,
 * `product` is where the source's product gets pasted. Returns null on failure
 * or when the image shows no product: on the source that sends the run down the
 * generate path, on an output it skips the transplant.
 */
async function locateProduct(
  bytes: Uint8Array,
  brandName: string | null,
  label: "source" | "output",
): Promise<{ product: ProductRegion; tile: ProductRegion | null } | null> {
  try {
    const result = await generateObject({
      model: openai(LOCATOR_MODEL),
      schema: productLocationSchema,
      system: [
        `Locate the advertised physical product${brandName ? ` (${brandName})` : ""} in this static ad.`,
        "product: one normalized bounding box (x, y, w, h in 0-1 from the top-left) that covers the physical product itself as tightly as you can. Exclude its packaging, case, pedestal, card, panel, shadow, and any text, badge, or prop around it. When several units of the product appear, box the main one.",
        "tile: the card, tile, panel, or pedestal area with its own background that the product sits inside, when there is one, else null. Its edges must fall on a natural boundary, and it must not reach over headline text or unrelated props outside it.",
        "Return product: null when no physical product is visible (a text-only or lifestyle ad); tile is null then too.",
      ].join("\n"),
      messages: [{ role: "user", content: [{ type: "image", image: bytes }] }],
    });
    const { product, tile, confidence, note } = result.object;
    const region = product ? clampRegion(product) : null;
    const area = region ? region.w * region.h : 0;
    // Too small is noise; a box that fills the canvas leaves the variation
    // nothing to change, so that run drops to the generate path instead.
    const usable = region !== null && confidence >= 0.4 && area >= 0.005 && area <= 0.85;
    // A tile that misses the product's centre is some other element, and one
    // that fills the canvas is the whole ad rather than a card. Either way the
    // product's own box is the safer answer, so drop the tile.
    const tileRegion = tile ? clampRegion(tile) : null;
    const usableTile =
      region !== null &&
      tileRegion !== null &&
      tileRegion.w * tileRegion.h <= 0.85 &&
      containsCentre(tileRegion, region)
        ? tileRegion
        : null;
    logger.info("Product locator", {
      label,
      found: Boolean(product),
      tile: usableTile,
      confidence,
      area,
      usable,
      note,
      // Only meaningful on a rejection; a usable box has no failed check.
      reason: usable
        ? null
        : !region
          ? "none"
          : confidence < 0.4
            ? "low_confidence"
            : area < 0.005
              ? "too_small"
              : "fills_canvas",
    });
    return usable && region ? { product: region, tile: usableTile } : null;
  } catch (error) {
    logger.warn("Product locator failed", {
      label,
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
      // Which stored edit-mode outputs actually got the source's product pasted
      // back in: the review's premise depends on it, and the paste can degrade.
      // Generate mode carries its own transplant on the attempt instead.
      const pastedUrls = new Set<string>();
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

      let located: { product: ProductRegion; tile: ProductRegion | null } | null = null;
      if (source.kind === "creative" && !payload.withoutSourceImage && sourceDimensions) {
        onStep("locating the product in the source");
        located = await locateProduct(sourceBytes, brand?.brandName ?? null, "source");
      }
      // An edit protects the whole tile the product sits on so its seam falls on
      // a natural boundary; the transplant cuts the product alone.
      const sourceProductRegion: ProductRegion | null = located
        ? (located.tile ?? located.product)
        : null;
      const sourceProductBox = located?.product ?? null;
      // The product box is tight, so the matte cuts the expanded box: the 3%
      // margin keeps the product's anti-aliased edge out of the border ring the
      // flood starts from, and off the crop the matte reports back.
      const matteRegion = sourceProductBox ? expandRegion(sourceProductBox) : null;
      // The source product's matte is the same for every attempt; cut it once.
      let sourceMatte: Promise<MatteResult> | null = null;
      const matteSource = () =>
        (sourceMatte ??= matteProduct({ source: sourceBytes, region: matteRegion! }));

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
          // and review those bytes. A paste failure is ours, not the model's:
          // keep the unpasted output so the review still judges an image we
          // already paid for instead of aborting the agent loop.
          let produced = result.image.uint8Array;
          let pasted = false;
          if (mode === "edit" && keepRegion && sourceDimensions) {
            try {
              // Paste the same box the mask protected (region plus margin) so
              // the seam falls where the model was told to keep the source.
              const pasteResult = await pasteSourceRegion({ source: sourceBytes, output: produced, region: expandRegion(keepRegion) });
              produced = pasteResult.bytes;
              pasted = true;
              logger.info("Pasted source product", { attempt, box: pasteResult.box });
            } catch (error) {
              logger.warn("Product paste failed; keeping the unpasted output", {
                attempt,
                keepRegion,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
              });
            }
          }
          // Generate mode composes freely, so the model's own product is
          // wherever it decided to put it: locate it there and cover it with
          // the source's real product. Every failure here is recoverable —
          // the model's product stays and the review judges it as before.
          let transplant: VariationTransplant | null = null;
          if (mode === "generate" && matteRegion && source.kind === "creative" && !payload.withoutSourceImage) {
            try {
              onStep(`locating the product in attempt ${attempt}`);
              const locatedOutput = await locateProduct(produced, brand?.brandName ?? null, "output");
              if (locatedOutput) {
                // The tight product box: the paste covers the model's product
                // and leaves the card or pedestal it drew around it.
                const to = locatedOutput.product;
                const matte = await matteSource();
                const pastedPatch = await pastePatch({ output: produced, patch: matte.patch, region: to });
                produced = pastedPatch.bytes;
                // The matte crops to what it kept, so record that region rather
                // than the box it was asked to cut from.
                transplant = { from: matte.region, to, matted: matte.matted };
                logger.info("Transplanted source product", {
                  attempt,
                  to,
                  tile: locatedOutput.tile,
                  matted: matte.matted,
                  coverage: matte.coverage,
                  box: pastedPatch.box,
                });
              } else {
                logger.warn("Transplant skipped: product not located in the output", { attempt });
              }
            } catch (error) {
              logger.warn("Transplant failed; keeping the model's product", {
                attempt,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
              });
            }
          }
          const stored = await putStudioObject(
            `${env}/create/${ctx.run.id}-${ctx.attempt.number}-${attempt}.png`,
            produced,
            "image/png",
          );
          imageBytes.set(stored.url, produced);
          if (pasted) pastedUrls.add(stored.url);
          return { imageUrl: stored.url, transplant };
        },
        reviewImage: async ({ imageUrl, prompt, mode, keepRegion, transplant }) => {
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
            if (mode === "edit" || transplant) {
              content.push({ type: "image", image: sourceBytes });
            } else if (brand?.productImageUrl) {
              content.push({ type: "image", image: await fetchBytes(brand.productImageUrl) });
            }
            const result = await generateObject({
              model: openai(REVIEW_MODEL),
              schema: reviewSchema,
              system: [
                mode === "edit"
                  ? `You are a strict creative reviewer for paid-social static ads. The first image is the generated ad, produced by editing the second image (the source); ${pastedUrls.has(imageUrl) ? "the source's product was pasted back into its box after the edit" : "the step that pastes the source's product back did not run, so the product you see is the image model's own re-render"}.`
                  : transplant
                    ? "You are a strict creative reviewer for paid-social static ads. The first image is the generated ad; the source's own product was cut out of the second image (the source) and pasted over the product the model drew."
                    : "You are a strict creative reviewer for paid-social static ads. The first image is the generated ad; the second, when present, is the advertiser's real product photo.",
                "Checklist (all must hold for pass = true):",
                mode === "edit" && keepRegion && pastedUrls.has(imageUrl)
                  ? `- The product from the source has been pasted back into its box (${pct(keepRegion)}). Check four things: its lighting, colour temperature, and perspective sit naturally against the new background; the pasted box lines up with the redrawn layout (no overlap or collision with a neighbouring card or element; a clean straight edge on flat background is acceptable and should only be mentioned as a note, not a failure); no second, re-rendered copy of the product appears anywhere outside the box; and the box does not cover copy or a focal element the prompt asked for. Name which of these failed.`
                  : mode === "edit"
                    ? "- The product matches the source image in shape, openings, material, and markings; no invented logos or text on it."
                    : transplant
                      ? `- The source's product now sits in the box ${pct(transplant.to)}. Check: it is a plausible size for the scene; its lighting and colour do not clash with the surroundings; no remnant of the model's own product shows around its edges; and nothing important is covered. Name which failed.`
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
