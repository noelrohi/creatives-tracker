import {
  experimental_generateImage as generateImage,
  generateObject,
  generateText,
  stepCountIs,
  tool,
} from "ai";
import { logger, metadata, task, tags } from "@trigger.dev/sdk";
import sharp from "sharp";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { openai } from "@/lib/ai";
import { pastePatch, pasteSourceRegion, pixelBox } from "@/lib/image-composite";
import { readImageDimensions, studioFormatForDimensions } from "@/lib/image-dimensions";
import { buildKeepMask, clampRegion, expandRegion, type ProductRegion } from "@/lib/image-mask";
import { matteProduct, type MatteResult } from "@/lib/image-matte";
import { basePerformanceLogFilter } from "@/lib/performance-log-sql";
import {
  buildProductMatchPrompt,
  pickProductMatch,
  productMatchSchema,
  type ProductMatchCandidate,
} from "@/lib/product-match";
import { isHttpUrl } from "@/lib/remote-image";
import { getStudioBrandProfile, type StudioBrandProfile } from "@/lib/studio-brand";
import { putStudioObject, readStudioImage } from "@/lib/studio-storage";
import {
  loadStudioContextLibrary,
  readStudioContextSection,
  type StudioContextLibrary,
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
  setBriefInputSchema,
  type VariationFailureReason,
  type VariationRunInput,
  type VariationSource,
} from "@/lib/variation-agent";
import type {
  EarlierVariation,
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
/**
 * Margins tried around the located product box when matting it out of the
 * source, narrowest first: enough to clear the product's own edge, little
 * enough to stay off whatever sits next to it in the ad.
 */
const MATTE_MARGINS = [0.01, 0.02, 0.03];
/** A landing area is the product's footprint on a surface, not a hero product filling the frame. */
const MAX_LANDING_AREA = 0.5;
/** The product-match crop is upscaled to at least this on its longer side. */
const MATCH_CROP_MIN_EDGE = 512;
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
  // .nullable(), not .nullish(): OpenAI's strict structured outputs require
  // every key to be present, same as `product`.
  tile: locatorBoxSchema
    .nullable()
    .describe("Box around the card, tile, panel, or pedestal the product sits inside, or null."),
  landing: locatorBoxSchema
    .nullable()
    .describe(
      "On a generated scene with no product drawn: the empty area reserved for it, boxed as the product's footprint so its bottom edge rests on the surface; else null.",
    ),
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
 * `region` of `bytes` as PNG bytes, so a vision call can be shown the product
 * alone rather than the whole ad around it.
 */
async function cropRegion(bytes: Uint8Array, region: ProductRegion) {
  const meta = await sharp(bytes, { failOn: "none" }).metadata();
  // Same reason as the matte: the region describes the image as it is seen, so
  // orient first and box against the oriented size.
  const size = meta.autoOrient;
  if (!size?.width || !size?.height) throw new Error("cropRegion: could not read image dimensions");
  const box = pixelBox(clampRegion(region), size.width, size.height);
  if (box.width <= 0 || box.height <= 0) throw new Error("cropRegion: the region is empty after clamping");
  const pipeline = sharp(bytes, { failOn: "none" }).autoOrient().extract(box);
  // A tiny crop is thin evidence for "same model" — the R1/R2 confusion is the
  // likely symptom — so a small product box is upscaled before the vision call.
  if (Math.max(box.width, box.height) < MATCH_CROP_MIN_EDGE) {
    pipeline.resize({
      ...(box.width >= box.height
        ? { width: MATCH_CROP_MIN_EDGE }
        : { height: MATCH_CROP_MIN_EDGE }),
      withoutEnlargement: false,
    });
  }
  const cropped = await pipeline.png().toBuffer();
  return new Uint8Array(cropped);
}

/**
 * Finds the product in an image, tightly, plus the card or pedestal it sits on
 * when there is one, and — on a generated output that was asked to leave the
 * product out — the empty area reserved for it. On the source, `tile ?? product`
 * is what an edit protects and `product` is what the transplant cuts out; on an
 * asset (a brand product photo), `product` is what the fallback matte cuts; on
 * an output, `product ?? landing` is the paste target. Returns null on failure
 * or when the image offers neither: on the source that sends the run down the
 * generate path, on an output it skips the transplant.
 */
async function locateProduct(
  bytes: Uint8Array,
  brandName: string | null,
  label: "source" | "output" | "asset",
): Promise<{
  product: ProductRegion | null;
  tile: ProductRegion | null;
  landing: ProductRegion | null;
} | null> {
  try {
    const result = await generateObject({
      model: openai(LOCATOR_MODEL),
      schema: productLocationSchema,
      system: [
        `Locate the advertised physical product${brandName ? ` (${brandName})` : ""} in this static ad.`,
        "product: one normalized bounding box (x, y, w, h in 0-1 from the top-left) that covers the physical product itself as tightly as you can. Exclude its packaging, case, pedestal, card, panel, shadow, and any text, badge, or prop around it. When several units of the product appear, box the main one. When the packaging is itself the advertised product, box the packaging.",
        "tile: the card, tile, panel, or pedestal area with its own background that the product sits inside, or the packaging or case it sits in, on, or beside, when there is one, else null. Its edges must fall on a natural boundary, and it must not reach over headline text or unrelated props outside it.",
        "landing: only when no product is drawn and the image clearly leaves an empty, plainly lit area for one (a bare pedestal top, an empty card, a clear tabletop): the box where the product should be placed, sized like its footprint and resting on the surface. Null otherwise.",
        "Return product: null when no physical product is visible; tile is null then too; landing may still be set on a generated scene.",
      ].join("\n"),
      messages: [{ role: "user", content: [{ type: "image", image: bytes }] }],
    });
    const { product, tile, landing, confidence, note } = result.object;
    const region = product ? clampRegion(product) : null;
    const area = region ? region.w * region.h : 0;
    // Too small is noise; a source box that fills the canvas leaves the
    // variation nothing to change, so that run drops to the generate path
    // instead. An output box has no such job — it is only a paste target, and
    // a product-led generate legitimately fills most of the frame — so the
    // ceiling there only has to reject a box that is the whole ad.
    const maxArea = label === "output" ? 0.95 : 0.85;
    const usable = region !== null && confidence >= 0.4 && area >= 0.005 && area <= maxArea;
    // A tile that misses the product's centre is some other element, one
    // smaller than the product is not the surface it sits on, and one that
    // fills the canvas is the whole ad rather than a card. Either way the
    // product's own box is the safer answer, so drop the tile.
    const tileRegion = tile ? clampRegion(tile) : null;
    const tileArea = tileRegion ? tileRegion.w * tileRegion.h : 0;
    const usableTile =
      region !== null &&
      tileRegion !== null &&
      tileArea >= region.w * region.h &&
      tileArea <= 0.85 &&
      containsCentre(tileRegion, region)
        ? tileRegion
        : null;
    // The landing area only means something on a generated output: it is the
    // room the model was asked to leave for the real product. A drawn product
    // wins over it (pasting over a product is the older target, and a scene
    // with both is one the model half-obeyed), and a source ad or a product
    // photo has no landing area to speak of.
    const landingRegion = landing ? clampRegion(landing) : null;
    const landingArea = landingRegion ? landingRegion.w * landingRegion.h : 0;
    const usableLanding =
      label === "output" &&
      landingRegion !== null &&
      !usable &&
      confidence >= 0.4 &&
      landingArea >= 0.005 &&
      landingArea <= MAX_LANDING_AREA
        ? landingRegion
        : null;
    logger.info("Product locator", {
      label,
      found: Boolean(product),
      tile: usable ? usableTile : null,
      tileDropped: Boolean(tileRegion) && !(usable && usableTile),
      landing: usableLanding,
      landingDropped: Boolean(landingRegion) && !usableLanding,
      confidence,
      area,
      usable,
      note,
      // Only meaningful on a rejection; a call that returns a usable product
      // box or a usable landing area has no failed check to report.
      reason: usable || usableLanding
        ? null
        : !region
          ? "none"
          : confidence < 0.4
            ? "low_confidence"
            : area < 0.005
              ? "too_small"
              : area > maxArea
                ? "fills_canvas"
                // No check left to fail: `usable` and the chain agree.
                : null,
    });
    if (!usable && !usableLanding) return null;
    return {
      product: usable && region ? region : null,
      tile: usable ? usableTile : null,
      landing: usableLanding,
    };
  } catch (error) {
    logger.warn("Product locator failed", {
      label,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return null;
  }
}

/**
 * Cuts the product at `box` out of `bytes`, trying the margins narrowest
 * first. The box is tight, so the matte cuts an expanded one: the margin keeps
 * the product's anti-aliased edge out of the border ring the flood starts
 * from. Too wide a margin reaches the tile's own label or a neighbouring prop
 * and the border stops reading as background (measured on the R3 source: 3%
 * swallows the tile's gold caption and the matte falls back), so widen only
 * when the narrow cut failed.
 */
async function matteWithMargins(
  bytes: Uint8Array,
  box: ProductRegion,
  label: "source" | "asset",
): Promise<MatteResult> {
  let fallback: MatteResult | null = null;
  let matted: MatteResult | null = null;
  let chosen = MATTE_MARGINS[0];
  for (const margin of MATTE_MARGINS) {
    const cut = await matteProduct({ source: bytes, region: expandRegion(box, margin) });
    // The narrowest cut is what an unmatted result reports: least foreign
    // background, and nothing pastes it anyway.
    fallback ??= cut;
    if (cut.matted) {
      matted = cut;
      chosen = margin;
      break;
    }
  }
  const matte = matted ?? fallback;
  if (!matte) throw new Error("matteWithMargins: no margin was tried");
  logger.info("Matted the product", {
    label,
    matted: matte.matted,
    margin: chosen,
    coverage: matte.coverage,
    region: matte.region,
  });
  return matte;
}

/** A matted cut of the real product, pasted into every generate attempt. */
type ProductPatch = {
  matte: MatteResult;
  source: "source" | "asset";
  assetImageUrl: string | null;
};

/**
 * The fallback for a source that will not matte (no flat border to flood
 * from): ask which of the brand's product photos shows the same product, then
 * matte that instead — a photo on a studio background mattes where a busy ad
 * does not. Anything that goes wrong returns null, which simply means no
 * patch: the agent then draws the product itself, as it did before the
 * transplant existed.
 */
async function matteFromProductPhoto(args: {
  sourceBytes: Uint8Array;
  sourceProductBox: ProductRegion;
  brand: StudioBrandProfile | null;
  library: StudioContextLibrary;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  onStep: (label: string) => void;
}): Promise<ProductPatch | null> {
  const { sourceBytes, sourceProductBox, brand, library, fetchBytes, onStep } = args;
  try {
    // Candidates: the brand profile's product photo, then library product images.
    const candidates: ProductMatchCandidate[] = [
      ...(brand?.productImageUrl
        ? [{ imageUrl: brand.productImageUrl, label: "brand product photo" }]
        : []),
      ...library.images
        .filter((image) => image.kind === "product")
        .map((image) => ({ imageUrl: image.imageUrl, label: `${image.title}: ${image.description}` })),
    ].filter((candidate, index, all) => all.findIndex((c) => c.imageUrl === candidate.imageUrl) === index);
    if (candidates.length === 0) {
      logger.info("No product photo to fall back to");
      return null;
    }
    onStep("matching the product photo");
    // One unreachable photo must not abort the match. Fetch them one at a time
    // and drop the ones that fail, then number the prompt off the survivors and
    // index the answer back into that same list: the model's 1-based answer
    // only lines up with the images it was actually shown.
    const fetched: Array<{ candidate: ProductMatchCandidate; bytes: Uint8Array }> = [];
    for (const candidate of candidates) {
      try {
        fetched.push({ candidate, bytes: await fetchBytes(candidate.imageUrl) });
      } catch (error) {
        logger.warn("Candidate product photo could not be read; skipping it", {
          imageUrl: candidate.imageUrl,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }
    if (fetched.length === 0) {
      logger.info("No product photo to fall back to");
      return null;
    }
    const shown = fetched.map((entry) => entry.candidate);
    // The crop is the product alone: the match is about this product, not the
    // ad it sits in.
    const crop = await cropRegion(sourceBytes, expandRegion(sourceProductBox, 0.01));
    const result = await generateObject({
      model: openai(LOCATOR_MODEL),
      schema: productMatchSchema,
      system: buildProductMatchPrompt(brand?.brandName ?? null, shown),
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: crop },
            ...fetched.map((entry) => ({ type: "image" as const, image: entry.bytes })),
          ],
        },
      ],
    });
    const chosen = pickProductMatch(result.object, shown);
    logger.info("Product photo match", {
      candidates: shown.length,
      labels: shown.map((candidate) => candidate.label),
      match: result.object.match,
      confidence: result.object.confidence,
      note: result.object.note,
      chosen: chosen?.imageUrl ?? null,
    });
    if (!chosen) return null;
    const assetBytes = await fetchBytes(chosen.imageUrl);
    const located = await locateProduct(assetBytes, brand?.brandName ?? null, "asset");
    if (!located?.product) return null;
    const cut = await matteWithMargins(assetBytes, located.product, "asset");
    return cut.matted ? { matte: cut, source: "asset", assetImageUrl: chosen.imageUrl } : null;
  } catch (error) {
    logger.warn("Product photo fallback failed; no patch", {
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

      // The source path wants the product itself — an edit protects it and the
      // transplant cuts it out — so a result carrying only a landing area is
      // nothing to work with here.
      let located: { product: ProductRegion; tile: ProductRegion | null } | null = null;
      if (source.kind === "creative" && !payload.withoutSourceImage && sourceDimensions) {
        onStep("locating the product in the source");
        const result = await locateProduct(sourceBytes, brand?.brandName ?? null, "source");
        located = result?.product ? { product: result.product, tile: result.tile } : null;
      }
      // An edit protects the whole tile the product sits on so its seam falls on
      // a natural boundary; the transplant cuts the product alone.
      const sourceProductRegion: ProductRegion | null = located
        ? (located.tile ?? located.product)
        : null;
      const sourceProductBox = located?.product ?? null;
      // The transplant needs a matted cut of the real product. Resolve it now,
      // before the agent runs, so the prompt only promises an empty-scene
      // transplant when a cut exists: an empty pedestal with nothing pasted
      // into it is worse than a redrawn product. The cut is the same for every
      // attempt, so it is made once.
      let productPatch: ProductPatch | null = null;
      if (sourceProductBox) {
        onStep("cutting out the product");
        try {
          const cut = await matteWithMargins(sourceBytes, sourceProductBox, "source");
          if (cut.matted) productPatch = { matte: cut, source: "source", assetImageUrl: null };
          // An unmatted cut is a rectangle carrying the source's own background,
          // and the live batch showed it fails review on the seam every time. A
          // matching product photo is the better cut when there is one.
          else
            productPatch = await matteFromProductPhoto({
              sourceBytes,
              sourceProductBox,
              brand,
              library,
              fetchBytes,
              onStep,
            });
        } catch (error) {
          // No patch is a supported state — the agent draws the product itself
          // — so a matte that throws must not take the whole run with it.
          logger.warn("Source matte failed; no patch", {
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
        }
      }

      // What this creative already tested, newest first, so the agent rotates
      // the axis instead of repeating one. Only creative sources carry a
      // sourceCreativeId, so a competitor ad simply has no history here.
      const earlierRows =
        payload.source.kind === "creative"
          ? await db
              .select({
                status: studioVariants.status,
                mark: studioVariants.mark,
                plan: studioVariants.plan,
              })
              .from(studioGenerations)
              .innerJoin(
                studioVariants,
                eq(studioVariants.generationId, studioGenerations.id),
              )
              .where(
                and(
                  eq(studioGenerations.organizationId, payload.organizationId),
                  eq(studioGenerations.kind, "variation"),
                  eq(studioGenerations.sourceCreativeId, payload.source.id),
                  ne(studioGenerations.id, payload.generationId),
                ),
              )
              .orderBy(desc(studioGenerations.createdAt))
              .limit(10)
          : [];
      const earlierVariations: EarlierVariation[] = earlierRows.map((row) => ({
        axis: row.plan?.axis ?? null,
        hypothesis: row.plan?.hypothesis ?? null,
        summary: row.plan?.summary ?? null,
        mark: row.mark === "good" || row.mark === "bad" ? row.mark : null,
        status:
          row.status === "ready"
            ? "ready"
            : row.status === "failed"
              ? "failed"
              : "generating",
      }));

      const input: VariationRunInput = {
        source,
        sourceImage: sourceBytes,
        sourceProductRegion,
        note: payload.note ?? null,
        brand,
        library,
        format,
        useSourceLayout: !payload.withoutSourceImage,
        productPatch: productPatch ? { source: productPatch.source } : null,
        earlierVariations,
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
          // Generate mode composes freely: the model was asked to leave an
          // empty landing area for the real product, and it may have drawn a
          // product there anyway. Locate whichever the output offers and paste
          // the patch into it. Every failure here is recoverable — whatever the
          // model drew stays, `transplant` stays null, and the review is told
          // the paste did not run.
          let transplant: VariationTransplant | null = null;
          if (mode === "generate" && productPatch) {
            try {
              onStep(`locating the product in attempt ${attempt}`);
              const locatedOutput = await locateProduct(produced, brand?.brandName ?? null, "output");
              // A drawn product is the safer target: the paste covers it and
              // leaves the card or pedestal the model drew around it. The
              // landing area is the empty surface left instead, with nothing
              // underneath to leak around the edges.
              const to = locatedOutput?.product ?? locatedOutput?.landing ?? null;
              if (to) {
                const target = locatedOutput?.product ? "product" : "landing";
                const pastedPatch = await pastePatch({
                  output: produced,
                  patch: productPatch.matte.patch,
                  region: to,
                  // A product placed on a surface rests on it; a product
                  // covering another one sits where that one was.
                  align: target === "landing" ? "bottom" : "center",
                });
                produced = pastedPatch.bytes;
                // The matte crops to what it kept, so record that region
                // rather than the box it was asked to cut from.
                transplant = {
                  from: productPatch.matte.region,
                  to,
                  target,
                  patchSource: productPatch.source,
                  assetImageUrl: productPatch.assetImageUrl,
                  matted: true,
                };
                logger.info("Transplanted product", {
                  attempt,
                  ...transplant,
                  tile: locatedOutput?.tile ?? null,
                  box: pastedPatch.box,
                });
              } else {
                logger.warn(
                  "Transplant skipped: neither a product nor a landing area was located in the output",
                  { attempt },
                );
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
        reviewImage: async ({ imageUrl, prompt, mode, keepRegion, transplant, brief }) => {
          // The same gate the transplant block runs under. When it holds and
          // `transplant` is still null (the output locator found neither a
          // product nor a landing area, or the paste threw), the image is
          // whatever the model drew after being told not to draw the product,
          // so judging it against the product photo would fail it for obeying
          // us.
          const transplantExpected = mode === "generate" && Boolean(productPatch);
          // The photo the patch was cut from, when there is one. The third
          // image, the premise, and the same-model check all key off this one
          // value so they cannot describe a different set of images.
          const assetPhoto =
            transplant?.patchSource === "asset" ? (transplant.assetImageUrl ?? null) : null;
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
            // The strategic checklist compares the variation with the ad it
            // varies, so the source is the second image on every attempt that
            // has one — not only the edit and transplant attempts. A competitor
            // source or a "retry without image" run keeps the product photo
            // there instead.
            const sourceSecond =
              mode === "edit" ||
              Boolean(transplant) ||
              (source.kind === "creative" && !payload.withoutSourceImage);
            if (sourceSecond) {
              content.push({ type: "image", image: sourceBytes });
            } else if (brand?.productImageUrl) {
              content.push({ type: "image", image: await fetchBytes(brand.productImageUrl) });
            }
            // A wrong-SKU match is the asset fallback's known failure mode, and
            // the review cannot see it without the photo the patch was cut
            // from: attach it third so the two products can be compared.
            if (assetPhoto) {
              content.push({ type: "image", image: await fetchBytes(assetPhoto) });
            }
            const result = await generateObject({
              model: openai(REVIEW_MODEL),
              schema: reviewSchema,
              system: [
                mode === "edit"
                  ? `You are a strict creative reviewer for paid-social static ads. The first image is the generated ad, produced by editing the second image (the source); ${pastedUrls.has(imageUrl) ? "the source's product was pasted back into its box after the edit" : "the step that pastes the source's product back did not run, so the product you see is the image model's own re-render"}.`
                  : transplant
                    ? assetPhoto
                      ? `You are a strict creative reviewer for paid-social static ads. The first image is the generated ad, the second is the source ad it varies, and the third is the brand's product photo; the real product was cut out of that third image and ${transplant.target === "landing" ? "pasted into the empty area the model left for it" : "pasted over the product the model drew"}.`
                      : `You are a strict creative reviewer for paid-social static ads. The first image is the generated ad; the real product was cut out of the second image (the source) and ${transplant.target === "landing" ? "pasted into the empty area the model left for it" : "pasted over the product the model drew"}.`
                    : sourceSecond
                      ? "You are a strict creative reviewer for paid-social static ads. The first image is the generated ad; the second is the source ad it varies."
                      : "You are a strict creative reviewer for paid-social static ads. The first image is the generated ad; the second, when present, is the advertiser's real product photo.",
                "Checklist (all must hold for pass = true):",
                brief
                  ? `- The variation declares axis "${brief.axis}": ${brief.hypothesis.replace(/\n/g, " ")} Compare with the source: the change on that axis must be visible in the image, not only in the words. For scene, layout, angle, or funnel, the composition or setting must differ from the source; if only the copy changed, fail and say "only the words changed". For hook, offer, proof, colour, or copy, the named element must differ while the rest stays recognisably the same ad.`
                  : null,
                assetPhoto
                  ? "- The third image is the product photo the pasted product was cut from. The pasted product must be the same model as the product in the source (second image): same silhouette, openings, thickness, and colour. If it is a different model, fail and say so."
                  : null,
                mode === "edit" && keepRegion && pastedUrls.has(imageUrl)
                  ? `- The product from the source has been pasted back into its box (${pct(keepRegion)}). Check four things: its lighting, colour temperature, and perspective sit naturally against the new background; the pasted box lines up with the redrawn layout (no overlap or collision with a neighbouring card or element; a clean straight edge on flat background is acceptable and should only be mentioned as a note, not a failure); no second, re-rendered copy of the product appears anywhere outside the box; and the box does not cover copy or a focal element the prompt asked for. Name which of these failed.`
                  : mode === "edit"
                    ? "- The product matches the source image in shape, openings, material, and markings; no invented logos or text on it."
                    : transplant
                      ? `- ${assetPhoto ? "The pasted product" : "The source's product"} now sits in the box ${pct(transplant.to)}. Check: it is a plausible size for the scene; its lighting and colour do not clash with the surroundings; no remnant of the model's own product shows around its edges; nothing important is covered; and no second copy of the product appears anywhere else in the image; and the product rests on the surface rather than floating above it or sinking into it. Name which failed.`
                      : transplantExpected
                        ? "- The product is not pasted in on this attempt (the paste step did not run), so the product you see, if any, is the model's own rendering: do not fail it on markings or exact shape, and an empty landing area beside it is acceptable. But the ad must still show the product somewhere; if no product is visible at all, fail and say 'no product visible'."
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
              setBrief: tool({
                description:
                  "Record the source classification (funnel, lane, mechanics, locked elements), the one axis this variation tests, and the hypothesis. Required before generateImage; may be replaced until the first image.",
                inputSchema: setBriefInputSchema,
                execute: (raw) => run.setBrief(raw),
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
