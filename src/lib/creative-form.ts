import { z } from "zod";

const formatValues = ["static", "video", "ugc", "carousel"] as const;
const awarenessValues = [
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
] as const;
const ownershipValues = ["ours", "theirs"] as const;

export const FORMAT_OPTIONS = [
  { label: "Static", value: "static" },
  { label: "Video", value: "video" },
  { label: "UGC", value: "ugc" },
  { label: "Carousel", value: "carousel" },
];

export const AWARENESS_OPTIONS = [
  { label: "Unaware", value: "unaware" },
  { label: "Problem Aware", value: "problem_aware" },
  { label: "Solution Aware", value: "solution_aware" },
  { label: "Product Aware", value: "product_aware" },
  { label: "Most Aware", value: "most_aware" },
];

export const OWNERSHIP_OPTIONS = [
  { label: "Ours", value: "ours" },
  { label: "Theirs", value: "theirs" },
];

export const TONE_OPTIONS = [
  { label: "Clinical", value: "clinical" },
  { label: "Casual", value: "casual" },
  { label: "Fear-based", value: "fear_based" },
  { label: "Aspirational", value: "aspirational" },
  { label: "Urgent", value: "urgent" },
  { label: "Humorous", value: "humorous" },
];

export const creativeFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  assetUrl: z.string().nullable(),
  format: z.enum(formatValues).nullable(),
  angle: z.string(),
  persona: z.string(),
  awarenessLevel: z.enum(awarenessValues).nullable(),
  hook: z.string(),
  tone: z.array(z.string()),
  cta: z.string(),

  ownership: z.enum(ownershipValues).nullable(),
  notes: z.string(),
});

export type CreativeFormValues = z.infer<typeof creativeFormSchema>;

type CreativeFormSource = {
  name: string;
  assetUrl: string | null;
  format: string | null;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  ownership: string | null;
  hook: string | null;
  tone: string[] | null;
  cta: string | null;

  notes: string | null;
};

function normalizeFormat(
  value: string | null | undefined,
): (typeof formatValues)[number] | null {
  return value && formatValues.includes(value as (typeof formatValues)[number])
    ? (value as (typeof formatValues)[number])
    : null;
}

function normalizeOwnership(
  value: string | null | undefined,
): (typeof ownershipValues)[number] | null {
  return value && ownershipValues.includes(value as (typeof ownershipValues)[number])
    ? (value as (typeof ownershipValues)[number])
    : null;
}

function normalizeAwareness(
  value: string | null | undefined,
): (typeof awarenessValues)[number] | null {
  return value &&
    awarenessValues.includes(value as (typeof awarenessValues)[number])
    ? (value as (typeof awarenessValues)[number])
    : null;
}

export function getCreativeFormValues(
  creative?: CreativeFormSource | null,
): CreativeFormValues {
  return {
    name: creative?.name ?? "",
    assetUrl: creative?.assetUrl ?? null,
    format: normalizeFormat(creative?.format),
    angle: creative?.angle ?? "",
    persona: creative?.persona ?? "",
    awarenessLevel: normalizeAwareness(creative?.awarenessLevel),
    hook: creative?.hook ?? "",
    tone: creative?.tone ?? [],
    cta: creative?.cta ?? "",

    ownership: normalizeOwnership(creative?.ownership),
    notes: creative?.notes ?? "",
  };
}

function emptyToNull(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toCreativeMutationInput(values: CreativeFormValues) {
  return {
    name: values.name.trim() || undefined,
    assetUrl: values.assetUrl,
    format: values.format,
    angle: emptyToNull(values.angle),
    persona: emptyToNull(values.persona),
    awarenessLevel: values.awarenessLevel,
    hook: emptyToNull(values.hook),
    tone: values.tone.length > 0 ? values.tone : null,
    cta: emptyToNull(values.cta),

    ownership: values.ownership,
    notes: emptyToNull(values.notes),
  };
}

export function hasCreativeExtraValues(
  values: ReturnType<typeof toCreativeMutationInput>,
) {
  return Boolean(
    values.assetUrl ||
      values.format ||
      values.angle ||
      values.persona ||
      values.awarenessLevel ||
      values.hook ||
      (values.tone && values.tone.length > 0) ||
      values.cta ||

      values.notes,
  );
}
