// Pure core of the variation agent: prompt construction, the three tool
// handlers over injected IO, and the rules that turn a finished run into an
// outcome. Everything with a rule or a budget lives here so the Trigger.dev
// task that drives the tool-calling loop stays thin IO wiring.

import { z } from "zod";
import type { StudioBrandProfile } from "@/lib/studio-brand";
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
const MAX_LISTED_SECTIONS = 200;

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
    referenceImageUrls: string[];
    format: StudioFormat;
    attempt: number;
  }) => Promise<{ imageUrl: string }>;
  reviewImage: (input: {
    imageUrl: string;
    prompt: string;
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
  evidence: z.array(
    z.object({
      documentId: z.string(),
      sectionId: z.string().optional(),
      title: z.string(),
    }),
  ),
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

const PROCEDURE = [
  "You are the variation agent for a paid-social creative team. You receive one existing static ad (the source) and produce exactly one new variation of it as a finished image, then a plan explaining what you did.",
  "",
  "Procedure:",
  "1. Read the source image and its text. Identify its format lane (e.g. product-led routine, testimonial card, before/after, offer badge) and its angle.",
  "2. Check the core context, especially the resolution log and playbook, for what worked and did not work in that lane. Read reference sections only when they add something specific (a testimonial to quote, a customer phrase to reuse).",
  "3. Choose ONE primary change and keep everything else. Prefer moves the playbook supports: plain-language benefits, product-led minimal composition, soft claims (may / designed to support), ad-to-landing-page continuity.",
  "4. Write a finished image prompt and call generateImage. The prompt must be self-contained and under 120 words: one plain-language description of subject, composition, lighting, palette, and mood. Quote exactly, in double quotes, every word that appears in the image (headline, offer, CTA) and keep it short. End with: No other text. No watermarks, platform UI, or third-party logos.",
  "5. Read the review. If it failed, fix the specific problems and try once more. Then call finish with the attempt you are shipping.",
  "",
  "Rules:",
  "- Any CONSTRAINT FROM THE USER is a hard constraint, not a suggestion.",
  "- Cite in evidence only documents and sections you actually read.",
  "- Never quote a testimonial verbatim if it states a definitive medical outcome; soften it while keeping it authentic.",
].join("\n");

const REBRAND_MODE = [
  "REBRAND MODE: the source is a competitor's ad. Keep its layout, composition, and visual hierarchy. In the prompt, state that you replace all source branding, logos, products, recognizable people, and copy with ours, and write short exact replacement copy in quotes for every text block the source shows. Never reuse the source's words or marks. In this mode the rebrand is the one change; the single-change rule in step 3 does not apply.",
].join("\n");

const TOOLS_NOTE = [
  `Budgets: at most ${MAX_CONTEXT_READS} readContext calls, ${MAX_IMAGE_ATTEMPTS} generateImage calls, ${MAX_STEPS} steps in total. Tool errors tell you what to change; adapt instead of repeating the call.`,
].join("\n");

function brandBlock(brand: StudioBrandProfile | null) {
  if (!brand) return "<brand>No brand profile is configured.</brand>";

  const lines = [
    `${brand.brandName} — ${brand.productDescription}`,
    brand.offer ? `Offer: ${brand.offer}` : null,
    brand.productNotes ? `Product notes: ${brand.productNotes}` : null,
    brand.productImageUrl
      ? "A product photo is attached as the last reference on every image call. The product in the image must match it exactly; render only the markings the product notes describe."
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
    brandBlock(input.brand),
    ...core,
    reference,
    images,
    `<tools>\n${TOOLS_NOTE}\nOutput size: ${studioSizeFor(input.format)}.\n</tools>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type VariationUserContent = Array<
  { type: "text"; text: string } | { type: "image"; image: URL }
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
    { type: "image", image: new URL(source.imageUrl) },
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
      const listed = doc.sections.slice(0, MAX_LISTED_SECTIONS);
      return {
        documentId: doc.id,
        sections: listed.map((section) => ({
          sectionId: section.id,
          path: section.path,
        })),
        ...(doc.sections.length > MAX_LISTED_SECTIONS
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

    // Counted before the call: a blocked attempt still spent an image-model call.
    state.imageCalls += 1;
    const attempt = state.imageCalls;
    const referenceImageUrls: string[] = [];
    if (raw.keepSourceLayout && input.useSourceLayout) {
      referenceImageUrls.push(input.source.imageUrl);
    }
    const ignoredReferenceIds: string[] = [];
    for (const id of raw.referenceImageIds) {
      const image = imageById.get(id);
      if (image) referenceImageUrls.push(image.imageUrl);
      else ignoredReferenceIds.push(id);
    }
    const productImageUrl = input.brand?.productImageUrl;
    if (productImageUrl && !referenceImageUrls.includes(productImageUrl)) {
      referenceImageUrls.push(productImageUrl);
    }

    deps.onStep(`generating image (attempt ${attempt})`);
    let imageUrl: string;
    try {
      ({ imageUrl } = await deps.produceImage({
        prompt: raw.prompt,
        referenceImageUrls,
        format: input.format,
        attempt,
      }));
    } catch (error) {
      const reason = moderationReasonFromError(error);
      if (reason) {
        state.moderationReason = reason;
        return {
          error: `The image model blocked this attempt (${reason}). Try again without relying on people from the source, or set keepSourceLayout to false.`,
        };
      }
      throw error;
    }

    deps.onStep(`reviewing attempt ${attempt}`);
    const review = await deps.reviewImage({ imageUrl, prompt: raw.prompt });
    state.attempts.push({ attempt, imageUrl, prompt: raw.prompt, review });
    return {
      attempt,
      imageUrl,
      review,
      attemptsRemaining: MAX_IMAGE_ATTEMPTS - state.imageCalls,
      ...(ignoredReferenceIds.length > 0 ? { ignoredReferenceIds } : {}),
    };
  }

  async function finish(raw: z.infer<typeof finishInputSchema>) {
    if (state.attempts.length === 0) {
      return { error: "Generate an image before finishing." };
    }
    if (!state.attempts.some((entry) => entry.attempt === raw.plan.finalAttempt)) {
      return {
        error: `finalAttempt ${raw.plan.finalAttempt} does not exist. Attempts so far: ${state.attempts.length}.`,
      };
    }

    state.plan = raw.plan;
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
