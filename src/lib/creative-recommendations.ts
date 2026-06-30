import { generateText, Output } from "ai";
import { z } from "zod";
import { openrouter } from "@/lib/ai";
import type {
  CreativeVariantCopy,
  CreativeVariantPerformanceSnapshot,
  CreativeVariantSourceSnapshot,
} from "@/schema/creative-recommendation";
import {
  STATIC_CREATIVE_FORMAT,
  isStaticCreativeFormat,
  isWinnerCandidate,
} from "@/lib/creative-recommendation-policy";

export { STATIC_CREATIVE_FORMAT, isStaticCreativeFormat, isWinnerCandidate };

export const CREATIVE_VARIANT_PROMPT_VERSION = "static-winner-variant-v1";
export const DEFAULT_CREATIVE_VARIANT_MODEL = "openai/gpt-4.1-mini";

const nonEmptyString = z.string().trim().min(1);

const nonStaticCreativeLanguage =
  /\b(video|ugc|carousel|voiceover|b-?roll|shot list|camera|timestamp|script)\b|\bcut to\b|\bedit notes?\b|\bslide\s+\d+\b|\bframe\s+\d+\b|\b\d+\s*seconds?\b|\b\d+\s*-\s*\d+\s*s\b/i;

const staticVisualDirection = nonEmptyString.refine(
  (value) => !nonStaticCreativeLanguage.test(value),
  "visualDirection must describe a static image or layout, not a video, UGC, or carousel concept.",
);

export const creativeVariantCopySchema = z.object({
  variantName: nonEmptyString,
  primaryText: nonEmptyString,
  headline: nonEmptyString,
  hook: nonEmptyString,
  cta: nonEmptyString,
  visualDirection: staticVisualDirection.describe("A static image or layout direction, not a video shot list."),
  changeSummary: nonEmptyString,
  rationale: nonEmptyString,
  riskNotes: z.string().trim().nullable().optional(),
}) satisfies z.ZodType<CreativeVariantCopy>;

export const generatedVariantBatchSchema = z.object({
  variants: z.array(creativeVariantCopySchema).min(3).max(4),
});

export function getCreativeVariantModel() {
  return process.env.CREATIVE_VARIANT_MODEL ?? DEFAULT_CREATIVE_VARIANT_MODEL;
}

export function hasCreativeVariantAiConfig() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export function normalizeGeneratedVariants(input: unknown): CreativeVariantCopy[] {
  return generatedVariantBatchSchema.parse(input).variants.map((variant) => ({
    ...variant,
    riskNotes: variant.riskNotes?.trim() || null,
  }));
}

function compactList(items: Array<[string, unknown]>) {
  return items
    .filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return value != null && value !== "";
    })
    .map(([label, value]) => {
      const rendered = Array.isArray(value) ? value.join(", ") : String(value);
      return `- ${label}: ${rendered}`;
    })
    .join("\n");
}

export function buildVariantGenerationPrompt(input: {
  source: CreativeVariantSourceSnapshot;
  performance: CreativeVariantPerformanceSnapshot;
}) {
  const source = compactList([
    ["Creative name", input.source.creativeName],
    ["Ad name", input.source.adName],
    ["Existing caption / primary text", input.source.caption],
    ["Format", input.source.format],
    ["Angle", input.source.angle],
    ["Persona", input.source.persona],
    ["Awareness level", input.source.awarenessLevel],
    ["Hook", input.source.hook],
    ["Tone", input.source.tone],
    ["CTA", input.source.cta],
    ["Asset URL", input.source.assetUrl],
  ]);

  const perf = compactList([
    ["Window", `${input.performance.from} to ${input.performance.to}`],
    ["Spend", `$${input.performance.spend.toFixed(2)}`],
    ["Revenue", `$${input.performance.revenue.toFixed(2)}`],
    ["ROAS", `${input.performance.roas.toFixed(2)}x`],
    ["Conversions", input.performance.conversions],
    ["CPA", input.performance.cpa == null ? null : `$${input.performance.cpa.toFixed(2)}`],
    ["CTR", input.performance.ctr == null ? null : `${input.performance.ctr.toFixed(2)}%`],
  ]);

  return `Create exactly 4 production-ready static paid social ad variants inspired by this winning static ad.

Each variant must be meaningfully distinct:
1. Hook shift
2. Angle or framing shift
3. Persona or emotion shift
4. Direct-response clarity shift

Source static winner:
${source || "- No structured source context available"}

Performance snapshot:
${perf}

Rules:
- Generate static ad variants only: a single image, layout, or graphic concept with matching copy.
- Preserve the same product/category context.
- Keep the copy specific enough for a creative producer to make.
- visualDirection must describe one static creative direction: composition, focal point, product treatment, text overlay, colors, props, or layout.
- Do not write video concepts, UGC scripts, carousel frames, scenes, timestamps, camera moves, shot lists, voiceover, B-roll, or edit notes.
- Avoid medical, disease-treatment, permanent-outcome, or unsupported guarantee claims.
- Do not invent discounts, studies, certifications, inventory claims, testimonials, or legal claims.
- Avoid copying the source caption verbatim; build variants that are close cousins, not duplicates.
- Prefer concise direct-response copy over long brand prose.
- If a variant carries any compliance or production concern, include it in riskNotes.`;
}

export async function generateCreativeVariants(input: {
  source: CreativeVariantSourceSnapshot;
  performance: CreativeVariantPerformanceSnapshot;
}) {
  const model = getCreativeVariantModel();
  const { output } = await generateText({
    model: openrouter(model),
    output: Output.object({
      schema: generatedVariantBatchSchema,
      name: "winner_variants",
      description: "Four static ad copy and visual direction variants generated from a winning source ad.",
    }),
    system:
      "You are a senior direct-response static ad strategist for ecommerce paid social. Return only valid structured output matching the schema.",
    prompt: buildVariantGenerationPrompt(input),
    temperature: 0.7,
  });

  return {
    model,
    variants: normalizeGeneratedVariants(output),
  };
}
