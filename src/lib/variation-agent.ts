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
import {
  VARIATION_AXES,
  VARIATION_FUNNELS,
  type EarlierVariation,
  type VariationAttempt,
  type VariationAxis,
  type VariationBrief,
  type VariationPlan,
  type VariationReview,
  type VariationTransplant,
} from "@/lib/variation-agent-types";

// Six reads, a brief, two images, two finishes, and a spare.
export const MAX_STEPS = 13;
export const MAX_CONTEXT_READS = 6;
export const MAX_IMAGE_ATTEMPTS = 2;
export const MAX_READ_CHARS = 8_000;
/** Flagged prompts in a row that end the run with reason "claims". */
export const MAX_CLAIMS_FLAGS = 2;

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
  /**
   * Set when the trigger already holds a matted cut of the real product
   * (from the source ad or a matched product photo) that it will paste into
   * every generate attempt. Null when no cut exists: the model then draws the
   * product itself from the product photo.
   */
  productPatch?: { source: "source" | "asset" } | null;
  note: string | null;
  brand: StudioBrandProfile | null;
  library: StudioContextLibrary;
  format: StudioFormat;
  /** False on "retry without image": the source is never sent as a layout reference. */
  useSourceLayout: boolean;
  /** Earlier variations of the same creative, newest first, so the agent rotates axes. */
  earlierVariations?: EarlierVariation[];
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
  }) => Promise<{ imageUrl: string; transplant?: VariationTransplant | null }>;
  reviewImage: (input: {
    imageUrl: string;
    prompt: string;
    mode: "edit" | "generate";
    keepRegion: ProductRegion | null;
    /** The product transplanted into a generate result, if any. */
    transplant: VariationTransplant | null;
    /** The brief this variation declared, so the review can check the axis. */
    brief: VariationBrief | null;
  }) => Promise<VariationReview>;
  onStep: (label: string) => void;
};

export type VariationRunState = {
  contextReads: number;
  /** Image-model calls made, including ones the model blocked: each one cost a call. */
  imageCalls: number;
  /** Prompts flagged for a prohibited claim in a row; a clean prompt resets it. */
  claimsFlags: number;
  attempts: VariationAttempt[];
  /** The classification and the one test, set by setBrief before the first image. */
  brief: VariationBrief | null;
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
  /** edit: masked edit of the source keeping the product; generate: draw from the references. Defaults to generate. */
  mode: z.enum(["edit", "generate"]).optional(),
  /** Override the protected region in edit mode (normalized 0-1 box). */
  keepRegion: productRegionSchema.optional(),
});

export const setBriefInputSchema = z.object({
  funnel: z
    .enum(VARIATION_FUNNELS)
    .describe(
      "tof: problem recognition or curiosity; mof: mechanism, education, comparison, objection handling; bof: price, offer, urgency, guarantee, strong proof.",
    ),
  lane: z
    .string()
    .min(1)
    .describe(
      "Format lane, e.g. product-led routine, testimonial card, before/after, offer badge, mechanism explainer, comparison, lifestyle, ugc.",
    ),
  mechanics: z
    .string()
    .min(1)
    .describe(
      "One sentence: what creates stopping power, comprehension, and purchase intent in the source.",
    ),
  locked: z
    .array(z.string())
    .describe(
      "Elements that must not change: the product, a verified offer, the disclaimer, the logo, any user constraint.",
    ),
  axis: z.enum(VARIATION_AXES).describe("The one thing this variation tests."),
  hypothesis: z
    .string()
    .min(1)
    .describe('"By changing X while keeping Y and Z, we expect A because B."'),
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

/** Collapses a stored string to one line: an EARLIER VARIATIONS row is one line. */
function flat(text: string) {
  return escapeContextText(text).replace(/\s+/g, " ").trim();
}

function describeRegion(region: ProductRegion) {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return `${pct(region.x)} to ${pct(region.x + region.w)} across and ${pct(region.y)} to ${pct(region.y + region.h)} down`;
}

/** Axes whose whole point is a new composition: the source is not attached as a layout reference. */
const SOURCE_FREE_AXES: VariationAxis[] = ["scene", "layout", "angle", "funnel"];

function editModeAvailable(input: VariationRunInput) {
  return Boolean(input.sourceProductRegion) && input.useSourceLayout && input.source.kind === "creative";
}

const PROCEDURE = [
  "You are the variation agent for a paid-social creative team. You receive one existing static ad (the source) and produce exactly one new variation of it as a finished image, then a plan explaining what you did. A variation is a test: one deliberate change with a stated hypothesis, not a restyle and not a rewording.",
  "",
  "Procedure:",
  "1. Read the source image and its text. Inventory what is visible: logo, headline, subhead, labels, CTA, offer, price, disclaimer, the product and its count and placement, people, scene, palette, typography, hierarchy.",
  "2. Classify it: the format lane (product-led routine, testimonial card, before/after, offer badge, mechanism explainer, comparison, lifestyle, ugc); the funnel stage (tof: problem recognition or curiosity; mof: mechanism, education, comparison, objection handling; bof: price, offer, urgency, guarantee, strong proof); the message sequence (hook, explanation or proof, product, CTA); and its mechanics: what creates stopping power, what creates comprehension, what creates purchase intent. Separate the locked elements (product, verified offer, disclaimer, logo, any user constraint) from what may change. Flag factual risk: claims, prices, testimonials.",
  "3. Check the core context, especially the resolution log and playbook, for what worked and did not work in that lane. Read reference sections only when they add something specific (a testimonial to quote, a customer phrase to reuse).",
  "4. Choose ONE axis and write the hypothesis, then call setBrief. Axes: hook (the opening line or visual hook), angle (the argument: problem, mechanism, benefit, identity), funnel (move the ad to another stage), offer (how the offer is framed), proof (testimonial, numbers, comparison), scene (setting, props, lighting, the world the product sits in), layout (grid, hierarchy, where things sit), colour (palette and mood), copy (wording only). The hypothesis reads: By changing X while keeping Y and Z, we expect A because B.",
  "5. Write a finished image prompt and call generateImage. The prompt is self-contained and under 180 words, in this order: the deliverable and format; the funnel objective in one line; hierarchy and composition (what reads first, second, third, and where); the product rule from the mode block; palette, lighting, and mood; every word that appears in the image quoted exactly in double quotes, kept short; the logo, CTA, and any disclaimer; exclusions. End with: No other text. No watermarks, platform UI, or third-party logos. On the scene, layout, angle, and funnel axes the source is not sent to the image model, so describe the whole composition yourself.",
  "6. Read the review. If it failed, fix the specific problems and try once more: for 'only the words changed', redesign the scene or layout in the prompt rather than rewording. Then call finish with the attempt you are shipping. Finishing on an attempt the review rejected is allowed but bounces once; call finish again to confirm.",
  "",
  "Choosing the axis, in priority order:",
  "- A CONSTRAINT FROM THE USER that names a change sets the axis.",
  "- Edit distance follows performance. High ROAS or many purchases: the source is a control; keep its funnel, offer, and mechanics and test one entrance to them (hook, proof, colour). High CTR with low ROAS: attention without intent; repair message match or proof. Low CTR and low ROAS: a larger change is justified (scene, layout, angle). Few purchases: a signal, not a winner.",
  "- Rotate. EARLIER VARIATIONS lists what this creative already tested. Do not repeat an axis until every other sensible axis has been used; prefer axes whose earlier attempts were marked good; avoid a hypothesis that was marked bad.",
  "- copy is allowed only when the constraint asks for it or when scene and layout have both been used already. A synonym swap, a palette swap, or a reworded CTA is not a variation unless that is the deliberate test.",
  "- funnel keeps the source's stage unless the constraint asks to move it. Moving to tof removes price, urgency, and hard CTA language; moving to bof needs a verified offer from the brand profile.",
  "",
  "Rules:",
  "- Any CONSTRAINT FROM THE USER is a hard constraint, not a suggestion.",
  "- Cite in evidence at least one document you actually used (core documents count; use their documentId), and only documents and sections you actually read.",
  "- Never quote a testimonial verbatim if it states a definitive medical outcome; soften it while keeping it authentic.",
  "- Prefer moves the playbook supports: plain-language benefits, product-led minimal composition, soft claims (may / designed to support), ad-to-landing-page continuity.",
].join("\n");

const REBRAND_MODE = [
  "REBRAND MODE: the source is a competitor's ad. Keep its layout, composition, and visual hierarchy. In the prompt, state that you replace all source branding, logos, products, recognizable people, and copy with ours, and write short exact replacement copy in quotes for every text block the source shows. Never reuse the source's words or marks. In this mode the rebrand is the one change; still call setBrief in step 4 (axis \"layout\" with the rebrand as the hypothesis), but the single-change rule does not apply and the source stays attached as the layout reference whatever the axis.",
].join("\n");

const TOOLS_NOTE = [
  `Budgets: at most ${MAX_CONTEXT_READS} readContext calls, ${MAX_IMAGE_ATTEMPTS} generateImage calls, ${MAX_STEPS} steps in total. setBrief is called once before the first image and costs a step. Tool errors tell you what to change; adapt instead of repeating the call.`,
].join("\n");

function brandBlock(brand: StudioBrandProfile | null, { patchReady }: { patchReady: boolean }) {
  if (!brand) return "<brand>No brand profile is configured.</brand>";

  const lines = [
    `${brand.brandName} — ${brand.productDescription}`,
    brand.offer ? `Offer: ${brand.offer}` : null,
    brand.productNotes ? `Product notes: ${brand.productNotes}` : null,
    brand.productImageUrl
      ? patchReady
        ? "No product photo is attached in generate mode: the real product is pasted in afterwards (see TRANSPLANT), so do not describe its shape, colour, or markings. In edit mode no product photo is attached either: the product is preserved from the source itself, so do not describe it, restyle it, or ask for a match to the photo."
        : "A product photo is attached as the first reference on every image call; when the source image is attached it comes last. The product in the ad must match the product photo exactly; render only the markings the product notes describe."
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
    input.productPatch
      ? "<mode>\nTRANSPLANT: the real product is pasted into your image afterwards, cut out of " +
        (input.productPatch.source === "asset" ? "the brand's product photo" : "the source ad") +
        ". Do not draw the product, and do not draw anything that looks like it (no product-shaped object, no packaging, no logo) anywhere in the image. Instead leave an empty landing area for it on a surface that already belongs to the scene (a nightstand, a tray, a counter, a shelf, the surface the source ad uses), with a visible edge or footprint, described explicitly in the prompt so it can be located afterwards; a bare empty region of background is not enough. Do not add a stand, pedestal, or platform unless the source ad has one. Place it at about the position and size the product has in the source ad image when the source is attached as a layout reference (possible on the hook, offer, proof, colour, and copy axes), or wherever your composition places the product, sized to read at a glance, on the scene, layout, angle, and funnel axes, with nothing overlapping it and no text inside it. Name the product in the prompt only to say where its landing area is. Everything else in the prompt is yours to design. This staging is a constraint on how you draw the scene, not your one change.\n</mode>"
      : null,
    editAvailable && input.sourceProductRegion
      ? `<mode>\nEDIT MODE is available on request (pass mode "edit" to generateImage; the default is generate, which draws from the references and then transplants the source's real product, so a copy-only or CTA-only change, when the axis rules allow one, still belongs in generate mode with the source kept as the layout reference). Edit mode is a last resort: measured runs show the image model reflows the layout under an edit mask, so the pasted box misaligns and the review rejects most edit attempts. Use it only when the CONSTRAINT FROM THE USER demands the source's exact pixels outside one region, never merely because the change is small. In edit mode the source is the canvas: the box ${describeRegion(input.sourceProductRegion)} of it holds the product; after the edit the source's pixels for that box are pasted back, so the product is preserved exactly, and everything outside that box is redrawn from your prompt alone. Because that rectangle is pasted over the result, the image model must keep the box at exactly the same position and size (no reflowed grid, no resized tiles) and must not draw the product anywhere else in the image; say both of those in the prompt. The prompt is still the self-contained description step 5 asks for, minus the product: describe the whole scene outside the kept box (background, lighting, palette, mood) and re-quote every line of copy the finished ad shows, including lines you are not changing. Anything you leave out is lost. Never describe or restyle the product itself; refer to it in plain words if you must (for example "the product in the lower-right tile is kept as is"). Keep the source's composition. If the review reports a misaligned box or a collision with a neighbouring element, move or resize keepRegion so its edges fall on a flat, unbroken area of the source (a plain background band, not a card edge). If it reports a second copy of the product, keep the box and rewrite the prompt to state that the product appears only inside that box. If it reports the box covering copy, shrink the box. Once in edit mode keepSourceLayout has no effect; to leave edit mode pass mode "generate", and do that only when the variation must move or replace the product.\n</mode>`
      : null,
    brandBlock(input.brand, { patchReady: Boolean(input.productPatch) }),
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
    `FORMAT: ${input.format} (${studioSizeFor(input.format)}). Describe the deliverable in this format; do not assume another aspect ratio.`,
    input.note?.trim()
      ? `CONSTRAINT FROM THE USER: ${escapeContextText(input.note.trim())}`
      : null,
    input.earlierVariations?.length
      ? `EARLIER VARIATIONS (newest first):\n${input.earlierVariations
          .map((variation) => {
            // One stored plan is one line: a newline in a hypothesis or a
            // summary would otherwise forge a top-level instruction line.
            const detail = variation.hypothesis
              ? `"${flat(variation.hypothesis)}"`
              : flat(variation.summary ?? "no plan");
            // The axis comes back from stored JSON, unvalidated.
            const axis =
              variation.axis && VARIATION_AXES.includes(variation.axis)
                ? variation.axis
                : "unclassified";
            return `- ${axis} — ${detail} — ${variation.mark ? `marked ${variation.mark}` : "no mark"} — ${variation.status}`;
          })
          .join("\n")}`
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
    brief: null,
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
      // A listing obeys the same per-call character cap as a section read,
      // measured on the whole serialized reply (envelope included): entries
      // are added while the reply would still fit.
      const sections: { sectionId: string; path: string }[] = [];
      const envelope = (list: unknown[], truncated: boolean) =>
        JSON.stringify({
          documentId: doc.id,
          sections: list,
          ...(truncated ? { truncated: true, totalSections: doc.sections.length } : {}),
        });
      let chars = envelope([], true).length;
      for (const section of doc.sections) {
        const entry = { sectionId: section.id, path: section.path };
        chars += JSON.stringify(entry).length + 1;
        if (chars > MAX_READ_CHARS) break;
        sections.push(entry);
      }
      const truncated = sections.length < doc.sections.length;
      return {
        documentId: doc.id,
        sections,
        ...(truncated ? { truncated: true, totalSections: doc.sections.length } : {}),
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

  async function setBrief(raw: z.infer<typeof setBriefInputSchema>) {
    // The brief drives the reference list and is stamped on the plan, so it is
    // fixed once an image exists: a later swap would misdescribe that image.
    if (state.attempts.length > 0) {
      return {
        error:
          "The brief cannot change after an image was already generated; finish with what you have or generate again under the same brief.",
      };
    }
    state.brief = raw;
    deps.onStep("writing the brief");
    return { ok: true as const };
  }

  async function generateImage(raw: z.infer<typeof generateImageInputSchema>) {
    if (state.imageCalls >= MAX_IMAGE_ATTEMPTS) {
      return {
        error: `Image attempt budget of ${MAX_IMAGE_ATTEMPTS} reached. Call finish with the best attempt.`,
      };
    }

    if (!state.brief) {
      return {
        error:
          "Set the brief first (setBrief): classify the source, choose the axis, and state the hypothesis before generating.",
      };
    }

    if (state.claimsFlags >= MAX_CLAIMS_FLAGS) {
      return {
        error: `Two prompts in a row stated a prohibited claim, so this run makes no more images. Call finish with a passing attempt if you have one.`,
      };
    }
    const violations = scanTextForClaims(raw.prompt, prohibitedClaims);
    if (violations.length > 0) {
      state.claimsFlags += 1;
      return {
        error: `The prompt states or implies a prohibited claim: ${violations
          .map((violation) => `"${violation.claim}"`)
          .join(", ")}. Rewrite it with soft, supportive wording.${state.claimsFlags >= MAX_CLAIMS_FLAGS ? " That was the second flagged prompt in a row: no more images this run." : ""}`,
      };
    }
    // A clean prompt breaks the streak: only consecutive flags end the run.
    state.claimsFlags = 0;

    // A retry has to change something: the same prompt after a rejected
    // review produced the same problems on the live batch.
    const previous = state.attempts[state.attempts.length - 1];
    if (previous && !previous.review.pass && previous.prompt.trim() === raw.prompt.trim()) {
      return {
        error: `This prompt is identical to attempt ${previous.attempt}, which the review rejected (${previous.review.notes.join("; ") || "no notes"}). Rewrite the prompt to fix those notes before generating again.`,
      };
    }

    const editAvailable = editModeAvailable(input);
    // Generate is the default and only an explicit mode "edit" leaves it:
    // keepSourceLayout says whether the source is attached as a layout
    // reference, not which mode runs. A measured batch (2026-09-04) showed the
    // image model reflows the layout under an edit mask, so a pasted product
    // box rarely lands cleanly; edit mode stays available on explicit request.
    const mode = raw.mode ?? "generate";
    if (mode === "edit" && !editAvailable) {
      return {
        error:
          'Edit mode is not available on this run (no product region, the source is not in use, or the source is a competitor ad). Use mode "generate".',
      };
    }
    const keepRegion = mode === "edit" ? (raw.keepRegion ?? input.sourceProductRegion ?? null) : null;

    // On the axes whose point is a new composition the source is withheld
    // whatever the model asked for: attaching it makes the model copy it. A
    // rebrand is the exception: its whole job is to reuse the competitor's
    // composition, so the source stays attached on every axis.
    const sourceFree =
      input.source.kind !== "competitor_ad" && SOURCE_FREE_AXES.includes(state.brief.axis);

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
      // the last for layout. With a product patch ready the product photo is
      // left out entirely: the model is asked for an empty landing area, and
      // attaching the photo invites it to draw the product anyway.
      const productImageUrl = input.productPatch ? null : input.brand?.productImageUrl;
      if (productImageUrl) referenceImageUrls.push(productImageUrl);
      for (const id of raw.referenceImageIds) {
        const image = imageById.get(id);
        if (!image) ignoredReferenceIds.push(id);
        else if (!referenceImageUrls.includes(image.imageUrl)) referenceImageUrls.push(image.imageUrl);
      }
      if (raw.keepSourceLayout && input.useSourceLayout && !sourceFree) {
        referenceImageUrls.push(input.source.imageUrl);
      }
    }

    deps.onStep(`${mode === "edit" ? "editing source" : "generating image"} (attempt ${attempt})`);
    let produced: { imageUrl: string; transplant?: VariationTransplant | null };
    try {
      produced = await deps.produceImage({
        prompt: raw.prompt,
        mode,
        keepRegion,
        referenceImageUrls,
        format: input.format,
        attempt,
      });
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
    const imageUrl = produced.imageUrl;
    const transplant = produced.transplant ?? null;

    deps.onStep(`reviewing attempt ${attempt}`);
    const review = await deps.reviewImage({ imageUrl, prompt: raw.prompt, mode, keepRegion, transplant, brief: state.brief });
    state.attempts.push({ attempt, imageUrl, prompt: raw.prompt, mode, keepRegion, transplant, review });
    return {
      attempt,
      imageUrl,
      mode,
      keepRegion,
      transplant,
      review,
      attemptsRemaining: MAX_IMAGE_ATTEMPTS - state.imageCalls,
      ...(sourceFree && raw.keepSourceLayout
        ? {
            sourceLayoutIgnored: true,
            sourceLayoutIgnoredReason:
              "On the scene, layout, angle, and funnel axes the source is not sent as a layout reference: the composition comes from your prompt.",
          }
        : {}),
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

    state.plan = {
      ...raw.plan,
      keptProductRegion: final.mode === "edit" ? (final.keepRegion ?? null) : null,
      transplantedProduct: final.mode === "generate" ? (final.transplant ?? null) : null,
      funnel: state.brief?.funnel ?? null,
      lane: state.brief?.lane ?? null,
      axis: state.brief?.axis ?? null,
      hypothesis: state.brief?.hypothesis ?? null,
    };
    state.finished = true;
    deps.onStep("finishing");
    return { ok: true as const };
  }

  return { state, readContext, setBrief, generateImage, finish };
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
        transplantedProduct: passing.mode === "generate" ? (passing.transplant ?? null) : null,
        funnel: state.brief?.funnel ?? null,
        lane: state.brief?.lane ?? null,
        axis: state.brief?.axis ?? null,
        hypothesis: state.brief?.hypothesis ?? null,
      },
      attempts: state.attempts,
    };
  }

  // Two consecutive flagged prompts end the run with reason "claims", whatever
  // came before them: the threshold comes from the spec. A passing attempt
  // still ships (checked above); a rejected one does not rescue the run.
  if (state.claimsFlags >= MAX_CLAIMS_FLAGS) {
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
