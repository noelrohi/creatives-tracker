/**
 * Every word the Creative insights screen says, in one file — the same contract
 * the attribution copy module keeps: no internal vocabulary reaches the screen,
 * figures are cited exactly, and a missing number reads "no data yet" rather
 * than a fake zero.
 *
 * The object *keys* below are wire identifiers (tag vocabularies from
 * `creative-taxonomy.ts`); only their values are ever printed.
 */

import {
  NO_TAGS_KEY,
  UNMATCHED_KEY,
  type EnforcedTag,
  type SliceDimension,
} from "@/lib/creative-insights-shared";
import { formatCount, formatPercent } from "@/components/blocks/attribution/format";
import {
  funnelStageHelp,
  funnelStageLabels,
  isFunnelStage,
} from "@/components/blocks/funnel-stage-copy";

export {
  funnelStageHelp,
  funnelStageLabels,
  funnelStageWords,
} from "@/components/blocks/funnel-stage-copy";

export const page = {
  navLabel: "Creative insights",
  title: "What your ads said, and what it earned",
  storeMissing:
    "Connect your Shopify store to see what your ads earned.",
  noDataYet: "no data yet",
  veiled: "—",
};

/* ------------------------------------------------------------------ */
/* Dimensions and tag vocabularies                                     */
/* ------------------------------------------------------------------ */

export const dimensionLabels: Record<SliceDimension, string> = {
  angle: "Angle",
  persona: "Persona",
  awareness: "Awareness",
  funnelStage: "Funnel stage",
};

/**
 * The seven angles from `ANGLE_TYPES`, in the words a person writes them in.
 * Exported because the manual-creative form offers the same seven, and the two
 * must not name them differently.
 */
export const angleLabels: Record<string, string> = {
  problem_solution: "Problem–solution",
  social_proof: "Social proof",
  comparison: "Comparison",
  transformation: "Transformation",
  skepticism: "Skepticism",
  offer_promo: "Offer / promo",
  education: "Education",
};

const awarenessLabels: Record<string, string> = {
  unaware: "Unaware",
  problem_aware: "Problem-aware",
  solution_aware: "Solution-aware",
  product_aware: "Product-aware",
  most_aware: "Most-aware",
};

export const explicitRowLabels: Record<string, string> = {
  [NO_TAGS_KEY]: "No tags yet",
  [UNMATCHED_KEY]: "Unmatched ad",
};

export const explicitRowHelp: Record<string, string> = {
  [NO_TAGS_KEY]:
    "We matched the order to one of your ads, but that ad carries no tag on this breakdown yet. It is shown, never dropped.",
  [UNMATCHED_KEY]:
    "The order's link didn't name an ad we have synced, so we can't place it on any breakdown. It still counts in your Meta total.",
};

/** Human label for one slice-row key on one dimension. */
export function sliceValueLabel(
  dimension: SliceDimension,
  key: string,
): string {
  const explicit = explicitRowLabels[key];
  if (explicit) return explicit;

  switch (dimension) {
    case "angle":
      return angleLabels[key] ?? key;
    case "awareness":
      return awarenessLabels[key] ?? key;
    case "funnelStage":
      return isFunnelStage(key) ? funnelStageLabels[key] : key;
    case "persona":
      // Personas are free text written by whoever tagged the creative.
      return key;
  }
}

/** The tooltip a row carries, when it has one to give. */
export function sliceValueHelp(
  dimension: SliceDimension,
  key: string,
): string | null {
  const explicit = explicitRowHelp[key];
  if (explicit) return explicit;
  if (dimension === "funnelStage") {
    return isFunnelStage(key) ? funnelStageHelp[key] : null;
  }
  return null;
}

export const tagLabels: Record<EnforcedTag, string> = {
  funnelStage: "Funnel stage",
  persona: "Persona",
  angle: "Angle",
  awareness: "Awareness",
};

/* ------------------------------------------------------------------ */
/* Insight cards                                                       */
/* ------------------------------------------------------------------ */

/** How each dimension names the ads inside one of its values. */
function adsThat(dimension: SliceDimension, label: string): string {
  return dimension === "angle"
    ? `Ads with a ${label.toLowerCase()} angle`
    : `Ads written for ${label.toLowerCase()} readers`;
}

export const cards = {
  claim: (dimension: SliceDimension, label: string, back: string) =>
    `${adsThat(dimension, label)} brought back ${back} per $1.`,
  why: (spend: string, runnerUpLabel: string | null, runnerUpBack: string | null) =>
    runnerUpLabel && runnerUpBack
      ? `Across ${spend} of spend. The next best, ${runnerUpLabel.toLowerCase()}, brought back ${runnerUpBack}.`
      : `Across ${spend} of spend. Nothing else on this breakdown carries enough spend to compare against yet.`,
  whyVeiled: (minSpend: string) =>
    `Worked out over the slices carrying at least ${minSpend} of spend. The figures fill in once enough of your spend is tagged.`,
  see: (dimension: SliceDimension) =>
    dimension === "angle" ? "See every angle →" : "See every awareness level →",
  none: "Not enough tagged spend behind any one angle or awareness level to say something worth acting on yet.",
};

export const alarm = {
  title: (untaggedShare: string) =>
    `${untaggedShare} of your Meta spend is invisible to us.`,
  body: (params: {
    untaggedSpend: string;
    totalSpend: string;
    adCount: number;
    windowDays: number;
  }) =>
    `${params.untaggedSpend} of ${params.totalSpend} over the last ${formatCount(
      params.windowDays,
    )} days went out on ${formatCount(params.adCount)} ${
      params.adCount === 1 ? "ad" : "ads"
    } we can't place by funnel stage, persona, angle or awareness — so every breakdown below is reading less than your real total.`,
  action: "Open the tagging queue →",
};

/* ------------------------------------------------------------------ */
/* The ledger                                                          */
/* ------------------------------------------------------------------ */

export const ledger = {
  title: "The full picture",
  caption: "Tap a row to see the ads behind it",
  backPerDollar: (back: string) => `${back} / $1`,
  orders: (orderCount: number) =>
    `${formatCount(orderCount)} ${orderCount === 1 ? "order" : "orders"}`,
  noSpend: "no spend",
  empty: "No Meta orders landed on these days.",
  queueLink: "Tagging queue →",
  /** The veil note names the exact ads that unlock the figures (§9). */
  veilTitle: (share: string) =>
    `These breakdowns are reading only ${share} of your spend.`,
  veilBody: (minShare: string) =>
    `The money figures come back once ${minShare} of active Meta spend is tagged. The per-ad alerts keep running either way. Start with:`,
  veilAdSpend: (spend: string) => `${spend} this week`,
  footnote:
    "Revenue here is confirmed orders only — each one traced to a specific ad through its link. Ads with no tags are always shown, never dropped.",
};

export const drill = {
  title: (label: string) => `Inside ${label.toLowerCase()}`,
  subtitle: (adCount: number) =>
    `${formatCount(adCount)} ${adCount === 1 ? "ad" : "ads"} · biggest earners first`,
  columns: {
    ad: "Ad",
    spend: "Spend",
    back: "Back / $1",
    funnel: "Click → land → cart",
  },
  empty:
    "No ad-level spend on these days for this row — the orders behind it came through ads we haven't synced.",
  emptyUnmatched:
    "These orders arrived with a link that names no ad we have synced, so there is nothing to open. A later sync can still claim them.",
  ratios: (params: { land: string; cart: string }) =>
    `${params.land} reach the page · ${params.cart} of those add to cart`,
  /** §7's caveat, standing in the card — visible, not buried. */
  caption:
    "Land = of the people who clicked, how many reached the page. Add to cart = of those, how many put it in the cart. These are Meta's modelled counts, so compare ads against each other here — not against Shopify.",
};

export const findings = {
  title: "Needs your attention",
  subtitle: (openCount: number) =>
    `${formatCount(openCount)} open · about your ads and their pages`,
  allClear: "Nothing about your ads needs you today.",
  allClearBody:
    "The ad-and-page fit, tagging coverage and link-tag checks all passed.",
};

/* ------------------------------------------------------------------ */
/* Tagging queue                                                       */
/* ------------------------------------------------------------------ */

export const queue = {
  navLabel: "Tagging queue",
  title: "Tag these ads first",
  subtitle: (params: {
    adCount: number;
    spend: string;
    windowDays: number;
  }) =>
    `${formatCount(params.adCount)} active ${
      params.adCount === 1 ? "ad" : "ads"
    } carry ${params.spend} of the last ${formatCount(
      params.windowDays,
    )} days' spend with a tag missing. Biggest spender first — that ordering is the priority.`,
  covered: (share: string) =>
    `${share} of your active Meta spend is fully tagged.`,
  columns: {
    ad: "Ad",
    where: "Campaign · ad set",
    spend: "Spend",
    missing: "Missing",
  },
  tagAction: "Tag the creative →",
  adAction: "See the ad",
  empty: "Every active ad carries all four tags. Nothing to do here.",
  back: "← Back to creative insights",
};

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

export function sharePercent(share: number | null | undefined): string | null {
  return formatPercent(share);
}
