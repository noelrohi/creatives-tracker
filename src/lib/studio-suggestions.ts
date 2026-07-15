import { z } from "zod";

export type SuggestionElement = {
  action: "keep" | "change";
  value?: string | null;
};

export type SuggestionElements = {
  headline: SuggestionElement;
  heroImage: SuggestionElement;
  background: SuggestionElement;
  offer: SuggestionElement;
  cta: SuggestionElement;
  brandMarks?: SuggestionElement | null;
  product?: SuggestionElement | null;
  copy?: SuggestionElement | null;
  socialProof?: SuggestionElement | null;
  priceFraming?: SuggestionElement | null;
};

// These schemas are sent to OpenAI structured outputs (strict mode), which
// requires every property to be required — "may be absent" is expressed as
// .nullable(), never .optional(), and defaults are not allowed.
export const suggestionElementSchema = z.object({
  action: z.enum(["keep", "change"]),
  value: z.string().nullable(),
});

export const suggestionElementsSchema = z.object({
  headline: suggestionElementSchema,
  heroImage: suggestionElementSchema,
  background: suggestionElementSchema,
  offer: suggestionElementSchema,
  cta: suggestionElementSchema,
  brandMarks: suggestionElementSchema.nullable(),
  product: suggestionElementSchema.nullable(),
  copy: suggestionElementSchema.nullable(),
  socialProof: suggestionElementSchema.nullable(),
  priceFraming: suggestionElementSchema.nullable(),
});

const suggestionFormatSchema = z.enum([
  "square",
  "portrait",
  "landscape",
  "widescreen",
  "vertical",
]);

// Passed to generateObject with output: "array" — OpenAI strict mode rejects
// root-level array schemas, so the SDK wraps this object schema itself.
export const studioSuggestionCardSchema = z.object({
  kind: z.enum(["new_hooks", "new_format", "refresh", "rebrand_swipe"]),
  title: z.string().min(1),
  whyLine: z.string().min(1),
  hypothesis: z.string().min(1),
  brief: z.string().min(1),
  elements: suggestionElementsSchema,
  visualStyle: z.string().min(1).nullable(),
  format: suggestionFormatSchema,
  count: z.number().int().min(3).max(4),
  sourceOrder: z.number().int().min(1),
});

/** Shape used by the swipe vision pass. */
export const rebrandElementSpecSchema = suggestionElementsSchema;

export const ELEMENT_LABELS: Record<keyof SuggestionElements, string> = {
  headline: "headline",
  heroImage: "hero image",
  background: "background",
  offer: "offer",
  cta: "CTA",
  brandMarks: "brand marks",
  product: "product",
  copy: "copy",
  socialProof: "social proof",
  priceFraming: "price framing",
};

export function buildElementsBrief(elements: SuggestionElements) {
  const entries = (
    Object.entries(elements) as Array<
      [keyof SuggestionElements, SuggestionElement | null]
    >
  ).filter((entry): entry is [keyof SuggestionElements, SuggestionElement] =>
    entry[1] != null,
  );
  return entries
    .map(([key, element]) => {
      const instruction =
        element.value?.trim() ||
        (element.action === "keep" ? "keep from the reference" : "replace");
      return `${ELEMENT_LABELS[key]} — ${element.action}: ${instruction}`;
    })
    .join("; ");
}
