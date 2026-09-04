// Pure core of the variation agent: prompt construction, the three tool
// handlers over injected IO, and the rules that turn a finished run into an
// outcome. Everything with a rule or a budget lives here so the Trigger.dev
// task that drives the tool-calling loop stays thin IO wiring.

import { z } from "zod";
import type { StudioBrandProfile } from "@/lib/studio-brand";
import { productRegionSchema, type ProductRegion } from "@/lib/image-mask";
import { buildClaimsConstraint, scanTextForClaims } from "@/lib/studio-claims";
import type { StudioContextLibrary } from "@/lib/studio-context";
import { moderationReasonFromError } from "@/lib/studio-moderation";
import { studioSizeFor, type StudioFormat } from "@/lib/studio-prompt";
import type {
  VariationAttempt,
  VariationPlan,
  VariationReview,
} from "@/lib/variation-agent-types";

export const MAX_STEPS = 12;
export const MAX_CONTEXT_READS = 6;
export const MAX_IMAGE_ATTEMPTS = 2;
export const MAX_READ_CHARS = 8_000;

const MAX_INDEXED_SECTIONS = 40;

export type VariationSource = {
  kind: "creative" | "competitor_ad";
  name: string;
  imageUrl: string;
  text: string | null;
  performance: {
    spend: number;
    roas: number | null;
    ctr: number | null;
    purchases: number;
  } | null;
};

export type VariationRunInput = {
  source: VariationSource;
  /**
   * The source image's bytes, when the caller already holds them. Sent inline
   * to the agent instead of a URL, so a source stored where the model
   * provider cannot fetch (local dev storage) still reaches it.
   */
  sourceImage?: Uint8Array;
  /**
   * Where the product sits in the source (normalized box), from the locator.
   * `null` when the locator found none; `undefined` when it did not run.
   */
  sourceProductRegion?: ProductRegion | null;
  note: string | null;
  brand: StudioBrandProfile | null;
  library: StudioContextLibrary;
  format: StudioFormat;
  /** False on "retry without image": the source is never sent as a layout reference. */
  useSourceLayout: boolean;
};

export type VariationRunDeps = {
  readSection: (
    documentId: string,
    sectionId: string,
  ) => Promise<{ path: string; content: string } | null>;
  produceImage: (input: {
    prompt: string;
    mode: "edit" | "generate";
    /** The protected source region in edit mode; null in generate mode. */
    keepRegion: ProductRegion | null;
    referenceImageUrls: string[];
    format: StudioFormat;
    attempt: number;
  }) => Promise<{ imageUrl: string }>;
  reviewImage: (input: {
    imageUrl: string;
    prompt: string;
    mode: "edit" | "generate";
    keepRegion: ProductRegion | null;
  }) => Promise<VariationReview>;
  onStep: (label: string) => void;
};

export type VariationRunState = {
  contextReads: number;
  /** Image-model calls made, including ones the model blocked: each one cost a call. */
  imageCalls: number;
  claimsFlags: number;
  attempts: VariationAttempt[];
  plan: VariationPlan | null;
  finished: boolean;
  /** Set by the first finish on a rejected attempt, which bounces; a second finish ships it. */
  overrodeReview: boolean;
  moderationReason: "likeness" | "logo" | "moderation" | null;
};

export type VariationFailureReason =
  | "no_image"
  | "claims"
  | "review"
  | "likeness"
  | "logo"
  | "moderation";

export type VariationOutcome =
  | {
      kind: "ready";
      imageUrl: string;
      plan: VariationPlan;
      attempts: VariationAttempt[];
    }
  | { kind: "failed"; reason: VariationFailureReason; attempts: VariationAttempt[] };

export const variationPlanSchema = z.object({
  summary: z.string().min(1),
  kept: z.array(z.string()),
  changed: z.array(z.string()).min(1),
  rationale: z.string().min(1),
  evidence: z
    .array(
      z.object({
        documentId: z.string(),
        sectionId: z.string().optional(),
        title: z.string(),
      }),
    )
    .min(1, "Cite at least one document you used"),
  inImageCopy: z.array(z.string()),
  finalAttempt: z.number().int().positive(),
});

export const readContextInputSchema = z.object({
  documentId: z.string(),
  sectionId: z.string().optional(),
});

export const generateImageInputSchema = z.object({
  prompt: z.string().min(1),
  referenceImageIds: z.array(z.string()).default([]),
  keepSourceLayout: z.boolean().default(true),
  /** edit: masked edit of the source keeping the product; generate: draw from references. Defaults to edit when available. */
  mode: z.enum(["edit", "generate"]).optional(),
  /** Override the protected region in edit mode (normalized 0-1 box). */
  keepRegion: productRegionSchema.optional(),
});

export const finishInputSchema = z.object({ plan: variationPlanSchema });

/** Neutralizes anything that could close or open an XML-ish section in the prompt. */
export function escapeContextText(text: string) {
  return text.replace(/<(?=\s*\/?\s*[a-zA-Z])/g, "&lt;");
}

/** Escapes a value used inside an XML-ish attribute or a pipe-delimited index row. */
function escapeContextField(text: string) {
  return escapeContextText(text)
    .replace(/"/g, "&quot;")
    .replace(/\s*[\r\n]+\s*/g, " ");
}

function describeRegion(region: ProductRegion) {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return `${pct(region.x)} to ${pct(region.x + region.w)} across and ${pct(region.y)} to ${pct(region.y + region.h)} down`;
}

function editModeAvailable(input: VariationRunInput) {
  return Boolean(input.sourceProductRegion) && input.useSourceLayout && input.source.kind === "creative";
}

const PROCEDURE = [
  "You are the variation agent for a paid-social creative team. You receive one existing static ad (the source) and produce exactly one new variation of it as a finished image, then a plan explaining what you did.",
  "",
  "Procedure:",
  "1. Read the source image and its text. Identify its format lane (e.g. product-led routine, testimonial card, before/after, offer badge) and its angle.",
  "2. Check the core context, especially the resolution log and playbook, for what worked and did not work in that lane. Read reference sections only when they add something specific (a testimonial to quote, a customer phrase to reuse).",
  "3. Choose ONE primary change and keep everything else. Prefer moves the playbook supports: plain-language benefits, product-led minimal composition, soft claims (may / designed to support), ad-to-landing-page continuity.",
  "4. Write a finished image prompt and call generateImage. The prompt must be self-contained and under 120 words: one plain-language description of subject, composition, lighting, palette, and mood. Quote exactly, in double quotes, every word that appears in the image (headline, offer, CTA) and keep it short. End with: No other text. No watermarks, platform UI, or third-party logos.",
  "5. Read the review. If it failed, fix the specific problems and try once more. Then call finish with the attempt you are shipping. Finishing on an attempt the review rejected is allowed but bounces once; call finish again to confirm.",
  "",
  "Rules:",
  "- Any CONSTRAINT FROM THE USER is a hard constraint, not a suggestion.",
  "- Cite in evidence at least one document you actually used (core documents count; use their documentId), and only documents and sections you actually read.",
  "- Never quote a testimonial verbatim if it states a definitive medical outcome; soften it while keeping it authentic.",
].join("\n");

const REBRAND_MODE = [
  "REBRAND MODE: the source is a competitor's ad. Keep its layout, composition, and visual hierarchy. In the prompt, state that you replace all source branding, logos, products, recognizable people, and copy with ours, and write short exact replacement copy in quotes for every text block the source shows. Never reuse the source's words or marks. In this mode the rebrand is the one change; the single-change rule in step 3 does not apply.",
].join("\n");

const TOOLS_NOTE = [
  `Budgets: at most ${MAX_CONTEXT_READS} readContext calls, ${MAX_IMAGE_ATTEMPTS} generateImage calls, ${MAX_STEPS} steps in total. Tool errors tell you what to change; adapt instead of repeating the call.`,
].join("\n");

function brandBlock(brand: StudioBrandProfile | null, editAvailable: boolean) {
  if (!brand) return "<brand>No brand profile is configured.</brand>";

  const lines = [
    `${brand.brandName} — ${brand.productDescription}`,
    brand.offer ? `Offer: ${brand.offer}` : null,
    brand.productNotes ? `Product notes: ${brand.productNotes}` : null,
    brand.productImageUrl
      ? editAvailable
        ? "In generate mode a product photo is attached as the first reference and the product in the ad must match it exactly; render only the markings the product notes describe. In edit mode no product photo is attached: the product is preserved from the source itself, so do not describe it, restyle it, or ask for a match to the photo."
        : "A product photo is attached as the first reference on every image call; when the source image is attached it comes last. The product in the ad must match the product photo exactly, and when the source already shows the product, tell the image model to reuse the product exactly as it appears in the source rather than re-rendering it. Render only the markings the product notes describe."
      : null,
  ].filter(Boolean);
  const claims = buildClaimsConstraint({
    prohibitedClaims: brand.prohibitedClaims,
    requiredDisclaimers: brand.requiredDisclaimers,
  });

  return [
    "<brand>",
    escapeContextText(lines.join("\n")),
    claims ? escapeContextText(claims) : "",
    "</brand>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildVariationSystemPrompt(input: VariationRunInput) {
  const { library } = input;
  const editAvailable = editModeAvailable(input);

  const core = library.core.map((doc) =>
    [
      `<context kind="${doc.kind}" title="${escapeContextField(doc.title)}">`,
      escapeContextText(doc.content),
      "</context>",
    ].join("\n"),
  );

  const reference = library.reference.length
    ? [
        "<reference-index>",
        "Read on demand with readContext. Format: documentId | title | description | section count",
        ...library.reference.flatMap((doc) => [
          `${doc.id} | ${escapeContextField(doc.title)} | ${escapeContextField(doc.description)} | ${doc.sections.length} sections`,
          ...doc.sections
            .slice(0, MAX_INDEXED_SECTIONS)
            .map((section) => `  ${section.id} | ${escapeContextField(section.path)}`),
          ...(doc.sections.length > MAX_INDEXED_SECTIONS
            ? [
                `  … ${doc.sections.length - MAX_INDEXED_SECTIONS} more; call readContext({ documentId }) for the full list`,
              ]
            : []),
        ]),
        "</reference-index>",
      ].join("\n")
    : "<reference-index>None.</reference-index>";

  const images = library.images.length
    ? [
        "<image-index>",
        "Attach by id through generateImage.referenceImageIds. Format: imageId | kind | title | description",
        ...library.images.map(
          (img) =>
            `${img.id} | ${img.kind} | ${escapeContextField(img.title)} | ${escapeContextField(img.description)}`,
        ),
        "</image-index>",
      ].join("\n")
    : "<image-index>None.</image-index>";

  return [
    `<role>\n${PROCEDURE}\n</role>`,
    input.source.kind === "competitor_ad" ? `<mode>\n${REBRAND_MODE}\n</mode>` : null,
    input.useSourceLayout
      ? null
      : "<mode>\nThe source image is NOT sent to the image model on this run (the user retried without it), and keepSourceLayout has no effect. Describe the layout, composition, and every element the image needs in the prompt itself.\n</mode>",
    editAvailable && input.sourceProductRegion
      ? `<mode>\nEDIT MODE is available on request (pass mode "edit" to generateImage; the default is generate, which draws from the references). Use it only when the variation keeps the whole layout and the product's position untouched. In edit mode the source is the canvas: the box ${describeRegion(input.sourceProductRegion)} of it holds the product; after the edit the source's pixels for that box are pasted back, so the product is preserved exactly, and everything outside that box is redrawn from your prompt alone. Because that rectangle is pasted over the result, the image model must keep the box at exactly the same position and size (no reflowed grid, no resized tiles) and must not draw the product anywhere else in the image; say both of those in the prompt. The prompt is still the self-contained description step 4 asks for, minus the product: describe the whole scene outside the kept box (background, lighting, palette, mood) and re-quote every line of copy the finished ad shows, including lines you are not changing. Anything you leave out is lost. Never describe or restyle the product itself; refer to it in plain words if you must (for example "the product in the lower-right tile is kept as is"). Keep the source's composition. If the review reports a misaligned box or a collision with a neighbouring element, move or resize keepRegion so its edges fall on a flat, unbroken area of the source (a plain background band, not a card edge). If it reports a second copy of the product, keep the box and rewrite the prompt to state that the product appears only inside that box. If it reports the box covering copy, shrink the box. Once in edit mode keepSourceLayout has no effect; to leave edit mode pass mode "generate" or keepSourceLayout false, and do that only when the variation must move or replace the product.\n</mode>`
      : null,
    brandBlock(input.brand, editAvailable),
    ...core,
    reference,
    images,
    `<tools>\n${TOOLS_NOTE}\nOutput size: ${studioSizeFor(input.format)}.\n</tools>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type VariationUserContent = Array<
  { type: "text"; text: string } | { type: "image"; image: URL | Uint8Array }
>;

export function buildVariationUserContent(
  input: VariationRunInput,
): VariationUserContent {
  const { source } = input;
  const performance = source.performance;
  const lines = [
    `SOURCE: ${escapeContextText(source.name)} (${source.kind === "creative" ? "our own ad" : "competitor ad"})`,
    source.text ? `SOURCE TEXT:\n${escapeContextText(source.text)}` : null,
    performance
      ? `PERFORMANCE (last 30 days): spend ${performance.spend.toFixed(0)}, ROAS ${performance.roas == null ? "n/a" : performance.roas.toFixed(2)}, CTR ${performance.ctr == null ? "n/a" : `${performance.ctr.toFixed(2)}%`}, purchases ${performance.purchases}`
      : null,
    input.note?.trim()
      ? `CONSTRAINT FROM THE USER: ${escapeContextText(input.note.trim())}`
      : null,
    "The source image is attached. Produce one variation and finish with your plan.",
  ].filter((line): line is string => Boolean(line));

  return [
    { type: "text", text: lines.join("\n\n") },
    { type: "image", image: input.sourceImage ?? new URL(source.imageUrl) },
  ];
}

export function createVariationRun(
  input: VariationRunInput,
  deps: VariationRunDeps,
) {
  const state: VariationRunState = {
    contextReads: 0,
    imageCalls: 0,
    claimsFlags: 0,
    attempts: [],
    plan: null,
    finished: false,
    overrodeReview: false,
    moderationReason: null,
  };
  const referenceById = new Map(input.library.reference.map((doc) => [doc.id, doc]));
  const imageById = new Map(input.library.images.map((img) => [img.id, img]));
  const prohibitedClaims = input.brand?.prohibitedClaims ?? [];

  async function readContext(raw: z.infer<typeof readContextInputSchema>) {
    if (state.contextReads >= MAX_CONTEXT_READS) {
      return {
        error: `Context read budget of ${MAX_CONTEXT_READS} reached. Work with what you have read.`,
      };
    }

    const doc = referenceById.get(raw.documentId);
    if (!doc) return { error: `Unknown document id: ${raw.documentId}` };

    if (!raw.sectionId) {
      state.contextReads += 1;
      deps.onStep(`listing ${doc.title.toLowerCase()}`);
      // A listing obeys the same per-call character cap as a section read:
      // entries are added until their serialized size would exceed it.
      const sections: { sectionId: string; path: string }[] = [];
      let chars = 2;
      for (const section of doc.sections) {
        const entry = { sectionId: section.id, path: section.path };
        chars += JSON.stringify(entry).length + 1;
        if (chars > MAX_READ_CHARS) break;
        sections.push(entry);
      }
      return {
        documentId: doc.id,
        sections,
        ...(sections.length < doc.sections.length
          ? { truncated: true, totalSections: doc.sections.length }
          : {}),
      };
    }

    // An id the index never offered is a typo, not a read: it costs nothing.
    // A real id whose lookup comes back empty already hit the database.
    if (!doc.sections.some((section) => section.id === raw.sectionId)) {
      return { error: `Unknown section id: ${raw.sectionId}` };
    }

    state.contextReads += 1;
    deps.onStep(`reading ${doc.title.toLowerCase()}`);
    const section = await deps.readSection(doc.id, raw.sectionId);
    if (!section) return { error: `Unknown section id: ${raw.sectionId}` };

    const truncated = section.content.length > MAX_READ_CHARS;
    return {
      documentId: doc.id,
      sectionId: raw.sectionId,
      path: section.path,
      content: truncated ? section.content.slice(0, MAX_READ_CHARS) : section.content,
      truncated,
    };
  }

  async function generateImage(raw: z.infer<typeof generateImageInputSchema>) {
    if (state.imageCalls >= MAX_IMAGE_ATTEMPTS) {
      return {
        error: `Image attempt budget of ${MAX_IMAGE_ATTEMPTS} reached. Call finish with the best attempt.`,
      };
    }

    const violations = scanTextForClaims(raw.prompt, prohibitedClaims);
    if (violations.length > 0) {
      state.claimsFlags += 1;
      return {
        error: `The prompt states or implies a prohibited claim: ${violations
          .map((violation) => `"${violation.claim}"`)
          .join(", ")}. Rewrite it with soft, supportive wording.`,
      };
    }

    const editAvailable = editModeAvailable(input);
    // An explicit keepSourceLayout:false is the model asking not to be pinned to
    // the source; edit mode pins it hardest, so it selects generate.
    // Generate is the default. A measured batch (2026-09-04) showed the image
    // model reflows the layout under an edit mask, so a pasted product box
    // rarely lands cleanly; edit mode stays available on explicit request.
    const mode = raw.mode ?? "generate";
    if (mode === "edit" && !editAvailable) {
      return {
        error:
          'Edit mode is not available on this run (no product region, the source is not in use, or the source is a competitor ad). Use mode "generate".',
      };
    }
    const keepRegion = mode === "edit" ? (raw.keepRegion ?? input.sourceProductRegion ?? null) : null;

    // Counted before the call: a blocked attempt still spent an image-model call.
    state.imageCalls += 1;
    const attempt = state.imageCalls;
    const ignoredReferenceIds: string[] = [];
    const referenceImageUrls: string[] = [];
    if (mode === "edit") {
      // The source is the canvas being edited; the product is preserved from
      // it, so no product photo or context images are sent.
      referenceImageUrls.push(input.source.imageUrl);
      ignoredReferenceIds.push(...raw.referenceImageIds);
    } else {
      // Reference order: product photo first, chosen context images, source
      // last. The image model leans on the first reference for the product and
      // the last for layout.
      const productImageUrl = input.brand?.productImageUrl;
      if (productImageUrl) referenceImageUrls.push(productImageUrl);
      for (const id of raw.referenceImageIds) {
        const image = imageById.get(id);
        if (!image) ignoredReferenceIds.push(id);
        else if (!referenceImageUrls.includes(image.imageUrl)) referenceImageUrls.push(image.imageUrl);
      }
      if (raw.keepSourceLayout && input.useSourceLayout) {
        referenceImageUrls.push(input.source.imageUrl);
      }
    }

    deps.onStep(`${mode === "edit" ? "editing source" : "generating image"} (attempt ${attempt})`);
    let imageUrl: string;
    try {
      ({ imageUrl } = await deps.produceImage({
        prompt: raw.prompt,
        mode,
        keepRegion,
        referenceImageUrls,
        format: input.format,
        attempt,
      }));
    } catch (error) {
      const reason = moderationReasonFromError(error);
      if (reason) {
        state.moderationReason = reason;
        return {
          error: `The image model blocked this attempt (${reason}). Try again without relying on people from the source${mode === "edit" ? ', or pass mode "generate"' : ", or set keepSourceLayout to false"}.`,
        };
      }
      throw error;
    }

    deps.onStep(`reviewing attempt ${attempt}`);
    const review = await deps.reviewImage({ imageUrl, prompt: raw.prompt, mode, keepRegion });
    state.attempts.push({ attempt, imageUrl, prompt: raw.prompt, mode, keepRegion, review });
    return {
      attempt,
      imageUrl,
      mode,
      keepRegion,
      review,
      attemptsRemaining: MAX_IMAGE_ATTEMPTS - state.imageCalls,
      ...(ignoredReferenceIds.length > 0
        ? {
            ignoredReferenceIds,
            ignoredReferenceReason:
              mode === "edit"
                ? 'Edit mode sends only the source image; reference images are not attached. Do not resend them; pass mode "generate" if you need them.'
                : "Not in the image index; check the id.",
          }
        : {}),
    };
  }

  async function finish(raw: z.infer<typeof finishInputSchema>) {
    if (state.attempts.length === 0) {
      return { error: "Generate an image before finishing." };
    }
    const final = state.attempts.find((entry) => entry.attempt === raw.plan.finalAttempt);
    if (!final) {
      return {
        error: `finalAttempt ${raw.plan.finalAttempt} does not exist. Attempts so far: ${state.attempts.length}.`,
      };
    }

    // Shipping a rejected attempt is allowed, but only as a second, deliberate
    // choice: the first finish bounces so the agent spends its remaining
    // attempt or restates the call.
    if (!final.review.pass && !state.overrodeReview) {
      state.overrodeReview = true;
      return {
        error: `Attempt ${final.attempt} did not pass review (${final.review.notes.join("; ") || "no notes"}). Fix it and generate again if you have an attempt left, or call finish again with this attempt to ship it as is.`,
      };
    }

    state.plan = { ...raw.plan, keptProductRegion: final.mode === "edit" ? (final.keepRegion ?? null) : null };
    state.finished = true;
    deps.onStep("finishing");
    return { ok: true as const };
  }

  return { state, readContext, generateImage, finish };
}

export function resolveVariationOutcome(state: VariationRunState): VariationOutcome {
  const plan = state.plan;
  if (state.finished && plan) {
    const final = state.attempts.find((entry) => entry.attempt === plan.finalAttempt);
    if (final) {
      return {
        kind: "ready",
        imageUrl: final.imageUrl,
        plan,
        attempts: state.attempts,
      };
    }
  }

  const passing = [...state.attempts].reverse().find((entry) => entry.review.pass);
  if (passing) {
    return {
      kind: "ready",
      imageUrl: passing.imageUrl,
      plan: {
        summary: "The agent produced an image but did not write a plan.",
        kept: [],
        changed: [],
        rationale: "",
        evidence: [],
        inImageCopy: [],
        finalAttempt: passing.attempt,
        synthesized: true,
        keptProductRegion: passing.mode === "edit" ? (passing.keepRegion ?? null) : null,
      },
      attempts: state.attempts,
    };
  }

  // Two consecutive flagged prompts end the run: the threshold comes from the spec.
  if (state.claimsFlags >= 2 && state.attempts.length === 0) {
    return { kind: "failed", reason: "claims", attempts: state.attempts };
  }
  // A moderation block is the more specific story: when the last image call was
  // refused, say so even if an earlier attempt also failed review.
  if (state.moderationReason) {
    return { kind: "failed", reason: state.moderationReason, attempts: state.attempts };
  }
  if (state.attempts.length > 0) {
    return { kind: "failed", reason: "review", attempts: state.attempts };
  }
  return { kind: "failed", reason: "no_image", attempts: state.attempts };
}
