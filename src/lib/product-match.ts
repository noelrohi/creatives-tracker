// Picks the brand product photo that shows the same product as the source
// ad's crop, so the transplant can matte a clean photo when the source will
// not matte. Pure: the vision call lives in the trigger.
import { z } from "zod";

export const PRODUCT_MATCH_MIN_CONFIDENCE = 0.7;

export type ProductMatchCandidate = { imageUrl: string; label: string };

export const productMatchSchema = z.object({
  /** 1-based index of the matching candidate (image 2 is candidate 1), or null. */
  match: z.number().int().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  note: z.string(),
});

export type ProductMatch = z.infer<typeof productMatchSchema>;

export function buildProductMatchPrompt(brandName: string | null, candidates: ProductMatchCandidate[]) {
  return [
    `Image 1 is a crop of the product from the source ad${brandName ? ` for ${brandName}` : ""}. The images after it are candidate product photos.`,
    ...candidates.map((candidate, index) => `Image ${index + 2}: ${candidate.label}`),
    "Answer which candidate shows the same product as image 1: the same model, colour, and markings, not merely the same category. Return match as the candidate number (image 2 is candidate 1), or null when none matches. Confidence is how sure you are of that answer.",
  ].join("\n");
}

export function pickProductMatch(result: ProductMatch, candidates: ProductMatchCandidate[]) {
  if (result.match == null || result.confidence < PRODUCT_MATCH_MIN_CONFIDENCE) return null;
  return candidates[result.match - 1] ?? null;
}
