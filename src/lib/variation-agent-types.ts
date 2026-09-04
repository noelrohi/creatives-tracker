import type { ProductRegion } from "@/lib/image-mask";

export type VariationEvidence = {
  documentId: string;
  sectionId?: string;
  title: string;
};

export type VariationTransplant = {
  /** Where the product was cut from in the source. */
  from: ProductRegion;
  /** Where the model drew its product in the output, now covered by the source's. */
  to: ProductRegion;
  /** False when the cut fell back to a rectangle instead of a matte; a generate-mode transplant is only recorded when the matte held, so it is true there. */
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
