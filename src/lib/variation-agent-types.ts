import type { ProductRegion } from "@/lib/image-mask";

export type VariationEvidence = {
  documentId: string;
  sectionId?: string;
  title: string;
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
  review: VariationReview;
};
