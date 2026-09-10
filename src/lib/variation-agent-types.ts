import type { ProductRegion } from "@/lib/image-mask";

export type VariationEvidence = {
  documentId: string;
  sectionId?: string;
  title: string;
};

export type VariationTransplant = {
  /** Where the product was cut from: a region of the source ad, or of the product photo when `patchSource` is "asset". */
  from: ProductRegion;
  /** The output box the product was pasted into. */
  to: ProductRegion;
  /** Whether `to` was the product the model drew (covered) or the empty landing area it left. */
  target: "product" | "landing";
  /** Where the patch came from: the source ad, or a matched brand product photo. */
  patchSource: "source" | "asset";
  /** The product photo the patch was cut from, when `patchSource` is "asset". */
  assetImageUrl?: string | null;
  /** True: a generate-mode transplant is only recorded when the matte held. */
  matted: boolean;
  /** The blend applied when pasting: brightness gain, per-channel gains, shadow opacity. */
  blend?: { lightGain: number; channelGains: [number, number, number]; shadowOpacity: number } | null;
};

export const VARIATION_AXES = [
  "hook",
  "angle",
  "funnel",
  "offer",
  "proof",
  "scene",
  "layout",
  "colour",
  "copy",
] as const;
export type VariationAxis = (typeof VARIATION_AXES)[number];

export const VARIATION_FUNNELS = ["tof", "mof", "bof"] as const;
export type VariationFunnel = (typeof VARIATION_FUNNELS)[number];

/** The agent's classification of the source and the one test this variation runs. */
export type VariationBrief = {
  funnel: VariationFunnel;
  /** Format lane: product-led routine, testimonial card, before/after, offer badge, mechanism explainer, comparison, lifestyle, ugc. */
  lane: string;
  /** One sentence: what creates stopping power, comprehension, and purchase intent in the source. */
  mechanics: string;
  /** Elements that must not change. */
  locked: string[];
  axis: VariationAxis;
  /** "By changing X while keeping Y and Z, we expect A because B." */
  hypothesis: string;
};

/** An earlier variation of the same creative, shown to the agent so it rotates axes. */
export type EarlierVariation = {
  axis: VariationAxis | null;
  hypothesis: string | null;
  summary: string | null;
  mark: "good" | "bad" | null;
  status: "ready" | "failed" | "generating";
};

export type VariationPlan = {
  summary: string;
  kept: string[];
  changed: string[];
  rationale: string;
  evidence: VariationEvidence[];
  inImageCopy: string[];
  finalAttempt: number;
  /** True when the loop ended without the agent calling finish. */
  synthesized?: boolean;
  /** Set by the core on finish: the source region protected in the shipped edit, if any. */
  keptProductRegion?: ProductRegion | null;
  /** Set by the core on finish: the product transplanted into the shipped generate, if any. */
  transplantedProduct?: VariationTransplant | null;
  /** Copied from the brief at finish. */
  funnel?: VariationFunnel | null;
  /** Copied from the brief at finish. */
  lane?: string | null;
  /** Copied from the brief at finish. */
  axis?: VariationAxis | null;
  /** Copied from the brief at finish. */
  hypothesis?: string | null;
};

export type VariationReview = {
  pass: boolean;
  notes: string[];
};

export type VariationAttempt = {
  attempt: number;
  imageUrl: string;
  prompt: string;
  mode: "edit" | "generate";
  /** The protected source region for an edit attempt. */
  keepRegion?: ProductRegion | null;
  /** The product transplant applied to a generate attempt, if any. */
  transplant?: VariationTransplant | null;
  review: VariationReview;
};
