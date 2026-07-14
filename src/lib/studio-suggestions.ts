import { z } from "zod";
import { isStudioFormat } from "@/lib/studio-prompt";

export type SuggestionElement = {
  action: "keep" | "change";
  value?: string;
};

export type SuggestionElements = {
  headline: SuggestionElement;
  heroImage: SuggestionElement;
  background: SuggestionElement;
  offer: SuggestionElement;
  cta: SuggestionElement;
};

const suggestionElementSchema = z.object({
  action: z.enum(["keep", "change"]),
  value: z.string().optional(),
});

const suggestionElementsSchema = z.object({
  headline: suggestionElementSchema,
  heroImage: suggestionElementSchema,
  background: suggestionElementSchema,
  offer: suggestionElementSchema,
  cta: suggestionElementSchema,
});

const suggestionFormatSchema = z
  .string()
  .refine(isStudioFormat, "Unsupported image dimensions");

export const studioSuggestionCardsSchema = z
  .array(
    z.object({
      kind: z.enum(["new_hooks", "new_format", "refresh"]),
      title: z.string().min(1),
      whyLine: z.string().min(1),
      variants: z
        .array(
          z.object({
            headline: z.string().min(1),
            diffSummary: z.string().min(1),
            copyLine: z.string().min(1),
            elements: suggestionElementsSchema,
            format: suggestionFormatSchema,
          }),
        )
        .length(3),
    }),
  )
  .max(3);

const ELEMENT_LABELS: Record<keyof SuggestionElements, string> = {
  headline: "headline",
  heroImage: "hero image",
  background: "background",
  offer: "offer",
  cta: "CTA",
};

export function buildSuggestionBrief(
  variant: {
    headline: string;
    diffSummary: string;
    copyLine: string;
    elements: SuggestionElements;
  },
  winnerName: string,
) {
  const entries = Object.entries(variant.elements) as Array<
    [keyof SuggestionElements, SuggestionElement]
  >;
  const kept = entries
    .filter(([, element]) => element.action === "keep")
    .map(([key]) => ELEMENT_LABELS[key]);
  const changed = entries
    .filter(([, element]) => element.action === "change")
    .map(
      ([key, element]) =>
        `${ELEMENT_LABELS[key]}: ${element.value?.trim() || "change from the winner"}`,
    );

  return [
    `Iterate on the winning ad "${winnerName}".`,
    `New headline: "${variant.headline}".`,
    variant.diffSummary,
    `Keep unchanged: ${kept.length > 0 ? kept.join(", ") : "none"}.`,
    `Change: ${changed.length > 0 ? changed.join("; ") : "none"}.`,
    `Suggested copy line: "${variant.copyLine}".`,
  ].join(" ");
}
