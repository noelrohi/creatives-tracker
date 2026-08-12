import type { AwarenessLevel } from "@/lib/awareness";
import {
  buildClaimsConstraint,
  scanTextForClaims,
} from "@/lib/studio-claims";
import {
  buildElementsBrief,
  type SuggestionElements,
} from "@/lib/studio-suggestions";

export const STUDIO_FORMATS = {
  portrait: "1024x1536",
  square: "1024x1024",
  landscape: "1536x1024",
  widescreen: "1536x864",
  vertical: "864x1536",
} as const;

export type StudioPreset = keyof typeof STUDIO_FORMATS;
export type StudioSize = `${number}x${number}`;
export type StudioFormat = StudioPreset | StudioSize;

const STUDIO_SIZE_PATTERN = /^(\d+)x(\d+)$/;
const MIN_STUDIO_PIXELS = 655_360;
const MAX_STUDIO_PIXELS = 8_294_400;
const MAX_STUDIO_EDGE = 3_840;

export function isSupportedStudioSize(value: string): value is StudioSize {
  const match = STUDIO_SIZE_PATTERN.exec(value);
  if (!match) return false;

  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  return (
    width > 0 &&
    height > 0 &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    width <= MAX_STUDIO_EDGE &&
    height <= MAX_STUDIO_EDGE &&
    Math.max(width, height) / Math.min(width, height) <= 3 &&
    pixels >= MIN_STUDIO_PIXELS &&
    pixels <= MAX_STUDIO_PIXELS
  );
}

export function isStudioFormat(value: string): value is StudioFormat {
  return value in STUDIO_FORMATS || isSupportedStudioSize(value);
}

export function studioSizeFor(format: StudioFormat): StudioSize {
  return format in STUDIO_FORMATS
    ? STUDIO_FORMATS[format as StudioPreset]
    : (format as StudioSize);
}

export function studioDimensions(format: StudioFormat) {
  const [width, height] = studioSizeFor(format).split("x").map(Number);
  return { width, height };
}

export function studioAspectRatio(format: StudioFormat) {
  const { width, height } = studioDimensions(format);
  return `${width} / ${height}`;
}

// Rotated per variant index so a single brief yields visually distinct takes.
export const ART_DIRECTIONS = [
  "Hero product close-up on a clean seamless background with dramatic studio lighting.",
  "Lifestyle scene showing the product in real-world use, natural light, candid energy.",
  "Bold typographic layout where the headline dominates and the product supports it.",
  "Flat-lay composition with complementary props on a textured surface, top-down view.",
  "High-contrast editorial look with a strong single accent color and generous negative space.",
  "Before/after or comparison-style split composition with clear visual storytelling.",
];

/**
 * Layout-level art directions contradict "keep the reference composition", so
 * they only rotate when the generation has no reference images.
 */
export function artDirectionFor(
  index: number,
  count: number,
  hasReferenceImages: boolean,
) {
  if (count <= 1 || hasReferenceImages) return null;
  return ART_DIRECTIONS[index % ART_DIRECTIONS.length];
}

export type StudioBrandContext = {
  brandName: string;
  productDescription: string;
  offer?: string | null;
  /** Product details the photo can't carry, e.g. a blind-debossed wordmark. */
  productNotes?: string | null;
  prohibitedClaims?: string[];
  requiredDisclaimers?: string[];
};

export function buildPrompt(payload: {
  brief: string;
  angle?: string | null;
  persona?: string | null;
  awarenessLevel?: AwarenessLevel | null;
  format?: StudioFormat;
  brand?: StudioBrandContext | null;
}) {
  const details = [
    `Brief: ${payload.brief}`,
    payload.brand
      ? `Brand: ${payload.brand.brandName} — ${payload.brand.productDescription}`
      : null,
    payload.brand?.offer ? `Offer: ${payload.brand.offer}` : null,
    payload.brand?.productNotes
      ? `Product notes: ${payload.brand.productNotes}`
      : null,
    payload.angle ? `Angle: ${payload.angle}` : null,
    payload.persona ? `Persona: ${payload.persona}` : null,
    payload.awarenessLevel
      ? `Awareness level: ${payload.awarenessLevel.replace(/_/g, " ")}`
      : null,
  ].filter(Boolean);

  return [
    "Create a static ad image for paid social.",
    "One clear focal point and a headline that reads at a glance in a scrolling feed.",
    "Do not include platform UI, watermarks, or unrelated brand logos.",
    ...details,
  ].join("\n");
}

export function variantPromptFor(basePrompt: string, artDirection: string | null) {
  return artDirection ? `${basePrompt}\nArt direction: ${artDirection}` : basePrompt;
}

export type PromptRewriteInput = {
  brief: string;
  angle?: string | null;
  persona?: string | null;
  awarenessLevel?: AwarenessLevel | null;
  count: number;
  format?: StudioFormat;
  /** Layout references (swipe/winning creative) — not the product photo. */
  hasReferenceImages: boolean;
  brand?: StudioBrandContext | null;
  hasProductImage?: boolean;
};

/**
 * The rewrite stage: an LLM turns the layered brief (rebrand instructions,
 * element spec, copy package, angle/persona metadata) into per-variant image
 * prompts, so the image model receives one short concrete description instead
 * of concatenated instructions.
 */
export function buildPromptRewrite(input: PromptRewriteInput) {
  const variantRules = input.hasReferenceImages
    ? [
        "- The layout reference image is attached. Every prompt keeps the reference's layout, composition, and visual hierarchy: describe its actual arrangement of product, text blocks, and negative space. Do not invent people, scenes, or props the reference does not show.",
        "- State that all source branding, logos, products, recognizable people, and copy are replaced with the advertiser's own.",
        "- For every text block visible in the reference (headline, bullets, badge, CTA), write short exact replacement copy in quotes for the advertiser — never reuse the source's words.",
        "- Vary palette, lighting, materials, and background texture between variants — never the layout.",
      ]
    : [
        "- No reference images. Make each variant a distinct concept: e.g. product close-up, lifestyle in context, headline-led typographic layout, split comparison, editorial negative space.",
      ];

  const claimsConstraint = input.brand
    ? buildClaimsConstraint({
        prohibitedClaims: input.brand.prohibitedClaims ?? [],
        requiredDisclaimers: input.brand.requiredDisclaimers ?? [],
      })
    : "";
  const system = [
    "You write finished prompts for an image model that generates static paid-social ads.",
    "",
    "Every prompt must:",
    "- Be self-contained and under 120 words: one plain-language visual description covering subject, composition, lighting, palette, and mood.",
    "- Quote exactly, in double quotes, any words that should appear in the image (headline, offer, CTA) and keep them short. Never leave in-image text unspecified and never quote long paragraphs.",
    '- End with: No other text. No watermarks, platform UI, or third-party logos.',
    '- Avoid vague style words like "premium", "polished", or "high quality"; describe the look concretely instead.',
    "- Contain no JSON, labels, or meta-instructions — only the description the image model should render.",
    ...(input.brand
      ? [
          '- The BRAND section describes the advertiser. Wherever the brief says "ours" or "our brand", it means this brand; name it and its product concretely in the prompt.',
        ]
      : []),
    ...(input.hasProductImage
      ? [
          "- The last attached image is the advertiser's own product photo. State that the product in the ad matches it exactly. Render any markings from the product notes precisely (embossed, debossed, or printed branding); beyond those, add no markings, logos, or text to the product. It is product guidance, not layout guidance.",
        ]
      : []),
    "",
    "Variant rules:",
    `- Return exactly ${input.count} prompts, one per variant.`,
    ...variantRules,
    "- Use the awareness level to set how direct the headline is: unaware → curiosity hook; problem aware → call out the problem; solution aware → why this approach wins; product aware → lead with proof; most aware → lead with the offer.",
    ...(claimsConstraint ? ["", claimsConstraint] : []),
  ].join("\n");

  const prompt = [
    "BRIEF",
    input.brief,
    "",
    ...(input.brand
      ? [
          "BRAND",
          `${input.brand.brandName} — ${input.brand.productDescription}`,
          input.brand.offer ? `Offer: ${input.brand.offer}` : null,
          input.brand.productNotes
            ? `Product notes: ${input.brand.productNotes}`
            : null,
          "",
        ]
      : []),
    input.angle ? `ANGLE: ${input.angle}` : null,
    input.persona ? `PERSONA: ${input.persona}` : null,
    input.awarenessLevel
      ? `AWARENESS LEVEL: ${input.awarenessLevel.replace(/_/g, " ")}`
      : null,
    `FORMAT: ${studioSizeFor(input.format ?? "square")}`,
    `VARIANTS: ${input.count}`,
    `REFERENCE IMAGES PROVIDED: ${input.hasReferenceImages ? "yes" : "no"}`,
    `PRODUCT PHOTO PROVIDED: ${input.hasProductImage ? "yes" : "no"}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { system, prompt };
}

export type WeeklyPromptInput = {
  winners: Array<{
    name: string;
    angle?: string | null;
    roas?: string | number | null;
    purchases?: string | number | null;
    spend?: string | number | null;
    trend?: string | null;
    format?: string | null;
  }>;
  skips: Array<{ title: string; angle?: string | null; whyLine?: string | null }>;
  tallies: Array<{
    angle?: string | null;
    style?: string | null;
    hook?: string | null;
    good: number;
    bad: number;
  }>;
  untriedSwipes: Array<{
    id: string;
    brandName?: string | null;
    whyItWorks?: string | null;
    angle?: string | null;
    style?: string | null;
  }>;
  copyPackages: Array<{
    angle: string;
    name: string;
    primaryText: string;
    headline: string;
    description: string;
  }>;
  visualStyles?: string[];
  hookTypes?: string[];
  brand?: {
    brandName: string;
    productDescription: string;
    offer?: string | null;
    prohibitedClaims?: string[];
    requiredDisclaimers?: string[];
  } | null;
  recentMade?: Array<{
    angle?: string | null;
    style?: string | null;
    hook?: string | null;
  }>;
  notTriedLately?: Array<{
    kind: "message" | "concept" | "hook_type";
    name: string;
  }>;
  watchList?: Array<{
    sourceCreativeId: string;
    title: string;
    purchases: number;
  }>;
  /** Live performance of ads that started as published studio images. */
  marketResults?: Array<{
    angle: string | null;
    shipped: number;
    avgRoas: number | null;
    spend: number | null;
  }>;
  topVariants?: Array<{
    creativeName: string;
    roas: number | null;
    purchases: number | null;
    trend: string;
  }>;
};

export function buildWeeklySuggestionPrompt(input: WeeklyPromptInput) {
  const claimsConstraint = input.brand
    ? buildClaimsConstraint({
        prohibitedClaims: input.brand.prohibitedClaims ?? [],
        requiredDisclaimers: input.brand.requiredDisclaimers ?? [],
      })
    : "";
  return [
    "Build this week's short Studio production queue.",
    "Use plain-language titles and reasons. Recommend 3–4 image variants per card.",
    "Avoid repeating skipped ideas and learn from Good/Bad decisions by angle, visual style, and hook type.",
    "Winner trend compares the recent 14 days with the prior 14: rising is improving, stable is holding, declining is fading, and paused has no meaningful recent spend.",
    "MARKET RESULTS are live ads that started as Studio images; when their real ROAS disagrees with Good/Bad taste marks, trust the market results.",
    "When TOP PROVEN VARIANTS identifies a specific image worth extending, you may propose an extend_winner card for it; keep what works and vary one element per variant.",
    "Propose useful saved swipes that have never been tried as rebrand_swipe cards.",
    "When an angle has a copy package, quote it only as a tone reference; do not copy it word-for-word.",
    ...(input.brand
      ? [
          "\nBRAND\n" +
            `${input.brand.brandName} — ${input.brand.productDescription}` +
            (input.brand.offer ? `\nOffer: ${input.brand.offer}` : ""),
        ]
      : []),
    "\nWINNERS\n" + JSON.stringify(input.winners, null, 2),
    ...(input.marketResults && input.marketResults.length > 0
      ? [
          "\nMARKET RESULTS (SHIPPED STUDIO IMAGES)\n" +
            JSON.stringify(input.marketResults, null, 2),
        ]
      : []),
    ...(input.topVariants && input.topVariants.length > 0
      ? [
          "\nTOP PROVEN VARIANTS — extend specific proven images, not diluted angle averages\n" +
            JSON.stringify(input.topVariants, null, 2),
        ]
      : []),
    "\nSKIP HISTORY\n" + JSON.stringify(input.skips, null, 2),
    "\nGOOD/BAD TALLIES\n" + JSON.stringify(input.tallies, null, 2),
    ...(input.watchList && input.watchList.length > 0
      ? [
          "\nWORTH WATCHING — do not duplicate these thin-evidence cards\n" +
            JSON.stringify(input.watchList, null, 2),
        ]
      : []),
    "\nRECENTLY MADE — do not re-propose near-duplicates unless MARKET RESULTS justify a refresh\n" +
      JSON.stringify(input.recentMade ?? [], null, 2),
    "\nNOT TRIED LATELY — include about one exploration card per week drawn from these values\n" +
      JSON.stringify(input.notTriedLately ?? [], null, 2),
    "\nUNTRIED SWIPES (2 newest + 2 oldest)\n" +
      JSON.stringify(input.untriedSwipes, null, 2),
    ...(input.visualStyles
      ? [
          "\nAVAILABLE VISUAL STYLES\n" +
            JSON.stringify(input.visualStyles, null, 2),
        ]
      : []),
    ...(input.hookTypes
      ? [
          "\nAVAILABLE HOOK TYPES\n" +
            JSON.stringify(input.hookTypes, null, 2),
        ]
      : []),
    "\nANGLE COPY PACKAGES (TONE REFERENCE)\n" +
      JSON.stringify(input.copyPackages, null, 2),
    ...(claimsConstraint ? ["\n" + claimsConstraint] : []),
  ].join("\n");
}

// Kept short: buildRebrandPrompt always wraps this and carries the
// replace-all-branding instructions, so repeating them here just pads the
// final image prompt. brandName is the advertiser (us); sourceBrandName is
// the brand whose ad was swiped.
export function buildRebrandBrief(input?: {
  brandName?: string | null;
  sourceBrandName?: string | null;
}) {
  const ours = input?.brandName?.trim() || "our brand";
  const source = input?.sourceBrandName?.trim();
  return `Recreate this ${source ? `${source} ` : ""}ad for ${ours} using our own product, offer, and customer imagery.`;
}

export function buildRebrandPrompt(input: {
  brief: string;
  elements?: SuggestionElements | null;
  brand?: Pick<
    StudioBrandContext,
    "prohibitedClaims" | "requiredDisclaimers"
  > | null;
}) {
  const claimsConstraint = input.brand
    ? buildClaimsConstraint({
        prohibitedClaims: input.brand.prohibitedClaims ?? [],
        requiredDisclaimers: input.brand.requiredDisclaimers ?? [],
      })
    : "";
  return [
    input.brief,
    "The reference is composition guidance only.",
    "Keep its layout and composition, but replace ALL branding, logos, products, recognizable likenesses, offers, and copy with ours.",
    "Never preserve or redraw the competitor's name, trademark, packaging, product, person, or words.",
    input.elements ? `Element spec: ${buildElementsBrief(input.elements)}` : null,
    claimsConstraint || null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function classifyPromptClaims(input: {
  prompts: string[];
  prohibitedClaims: string[];
  retried: boolean;
}) {
  const violations = Array.from(
    new Set(
      input.prompts.flatMap((prompt) =>
        scanTextForClaims(prompt, input.prohibitedClaims).map((match) => match.claim),
      ),
    ),
  );
  if (violations.length === 0) {
    return { action: "ok" as const, violations, retryInstruction: null };
  }
  if (input.retried) {
    return { action: "claims" as const, violations, retryInstruction: null };
  }
  return {
    action: "retry" as const,
    violations,
    retryInstruction:
      "Rewrite every prompt again. Remove or reframe these prohibited phrases and any equivalent implication: " +
      violations.map((claim) => `\"${claim}\"`).join(", ") +
      ". Preserve the concept while obeying the CLAIMS GUARDRAIL exactly.",
  };
}
