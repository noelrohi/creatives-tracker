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
import { readImageDimensions, studioFormatForDimensions } from "@/lib/image-dimensions";
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
      const format: StudioFormat = studioFormatForDimensions(
        readImageDimensions(sourceBytes),
      );
      await db
        .update(studioGenerations)
        .set({ format, updatedAt: new Date() })
        .where(
          and(
            eq(studioGenerations.id, payload.generationId),
            eq(studioGenerations.organizationId, payload.organizationId),
          ),
        );

      const input: VariationRunInput = {
        source,
        sourceImage: sourceBytes,
        note: payload.note ?? null,
        brand,
        library,
        format,
        useSourceLayout: !payload.withoutSourceImage,
      };

      const run = createVariationRun(input, {
        readSection: (documentId, sectionId) =>
          readStudioContextSection(payload.organizationId, documentId, sectionId),
        produceImage: async ({ prompt, referenceImageUrls, format, attempt }) => {
          const references: Uint8Array[] = [];
          for (const url of referenceImageUrls) references.push(await fetchBytes(url));
          const result = await logger.trace(`Generate attempt ${attempt}`, () =>
            generateImage({
              model: openai.image(IMAGE_MODEL),
              prompt: references.length ? { text: prompt, images: references } : prompt,
              size: studioSizeFor(format),
            }),
          );
          const stored = await putStudioObject(
            `${env}/create/${ctx.run.id}-${ctx.attempt.number}-${attempt}.png`,
            result.image.uint8Array,
            "image/png",
          );
          imageBytes.set(stored.url, result.image.uint8Array);
          return { imageUrl: stored.url };
        },
        reviewImage: async ({ imageUrl, prompt }) => {
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
            if (brand?.productImageUrl) {
              content.push({ type: "image", image: await fetchBytes(brand.productImageUrl) });
            }
            const result = await generateObject({
              model: openai(REVIEW_MODEL),
              schema: reviewSchema,
              system: [
                "You are a strict creative reviewer for paid-social static ads. The first image is the generated ad; the second, when present, is the advertiser's real product photo.",
                "Checklist (all must hold for pass = true):",
                "- The product matches the product photo in shape, openings, material, and markings; no invented logos or text on it.",
                "- Every word visible in the image is legible and matches the quoted copy in the prompt; no garbled or extra text.",
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
