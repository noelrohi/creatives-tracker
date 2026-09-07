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
