import {
  buildElementsBrief,
  type SuggestionElements,
} from "@/lib/studio-suggestions";

export const STUDIO_ANGLE_SEEDS = [
  "vs. the expensive fix",
  "creams don't work",
  "week-by-week timeline",
  "nobody talks about this",
  "clothing freedom",
  "feel like yourself again",
  "offer/bundle",
] as const;

export const STUDIO_STYLE_SEEDS = [
  "before/after",
  "us vs. them",
  "testimonial",
  "facts & stats",
  "features & benefits",
  "native/screenshot",
] as const;

export function studioSlug(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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
  brand?: {
    brandName: string;
    productDescription: string;
    offer?: string | null;
  } | null;
  /** Live performance of ads that started as published studio images. */
  marketResults?: Array<{
    angle: string | null;
    shipped: number;
    avgRoas: number | null;
    spend: number | null;
  }>;
};

export function buildWeeklySuggestionPrompt(input: WeeklyPromptInput) {
  return [
    "Build this week's short Studio production queue.",
    "Use plain-language titles and reasons. Recommend 3–4 image variants per card.",
    "Avoid repeating skipped ideas and learn from Good/Bad decisions by angle and visual style.",
    "Winner trend compares the recent 14 days with the prior 14: rising is improving, stable is holding, declining is fading, and paused has no meaningful recent spend.",
    "MARKET RESULTS are live ads that started as Studio images; when their real ROAS disagrees with Good/Bad taste marks, trust the market results.",
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
    "\nSKIP HISTORY\n" + JSON.stringify(input.skips, null, 2),
    "\nGOOD/BAD TALLIES\n" + JSON.stringify(input.tallies, null, 2),
    "\nUNTRIED SWIPES\n" + JSON.stringify(input.untriedSwipes, null, 2),
    ...(input.visualStyles
      ? [
          "\nAVAILABLE VISUAL STYLES\n" +
            JSON.stringify(input.visualStyles, null, 2),
        ]
      : []),
    "\nANGLE COPY PACKAGES (TONE REFERENCE)\n" +
      JSON.stringify(input.copyPackages, null, 2),
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
}) {
  return [
    input.brief,
    "The reference is composition guidance only.",
    "Keep its layout and composition, but replace ALL branding, logos, products, recognizable likenesses, offers, and copy with ours.",
    "Never preserve or redraw the competitor's name, trademark, packaging, product, person, or words.",
    input.elements ? `Element spec: ${buildElementsBrief(input.elements)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function moderationReasonFromError(error: unknown) {
  const values: unknown[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || value == null) return;
    if (typeof value === "string") {
      values.push(value);
      return;
    }
    if (typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(error, 0);
  const message = values.join(" ").toLowerCase();
  if (!message.includes("moderation_blocked") && !message.includes("moderation")) {
    return null;
  }
  if (/likeness|face|person|identity/.test(message)) return "likeness" as const;
  if (/logo|trademark|brand|copyright|character/.test(message)) return "logo" as const;
  return "moderation" as const;
}
