import { z } from "zod";
import { ANGLE_TYPES } from "@/lib/creative-taxonomy";

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

export const ANGLE_OPTIONS = ANGLE_TYPES.map((value) => ({
  value,
  label: value
    .split("_")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" "),
}));

/**
 * The edit schema. The enforced tags may be blank here and only here: a
 * creative that predates the §6.1 gate is editable without being retagged in
 * the same breath. What it may never do is clear one — `toCreativeMutationInput`
 * simply omits a blank enforced tag, so an existing value stays put.
 */
export const creativeFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  assetUrl: z.string().nullable(),
  format: z.enum(formatValues).nullable(),
  // Free-text angles predate the taxonomy, so blank is allowed, but anything
  // written now must be a vocabulary value — the update mutation rejects the
  // rest anyway.
  angle: z
    .string()
    .refine(
      (value) =>
        value === "" || ANGLE_TYPES.includes(value as (typeof ANGLE_TYPES)[number]),
      "Pick one of the seven angles",
    ),
  persona: z.string(),
  awarenessLevel: z.enum(awarenessValues).nullable(),
  hook: z.string(),
  tone: z.array(z.string()),
  cta: z.string(),

  ownership: z.enum(ownershipValues).nullable(),
  teamId: z.string().nullable(),
  notes: z.string(),
});

/**
 * The create schema (spec §6.1: "Studio and manual creatives require the four
 * enforced tags at save"). The fourth tag — funnel stage — lives on the ad, and
 * a manual creative has no ad yet, so the trio enforceable at creation is
 * persona + angle + awareness. The server holds the same line in
 * `adCreative.create`.
 */
export const creativeCreateFormSchema = creativeFormSchema.extend({
  persona: z.string().trim().min(1, "Persona is required"),
  angle: z.enum(ANGLE_TYPES, { message: "Angle is required" }),
  awarenessLevel: z.enum(awarenessValues, {
    message: "Awareness level is required",
  }),
});

export type CreativeFormValues = z.infer<typeof creativeFormSchema>;
export type CreativeCreateFormValues = z.infer<typeof creativeCreateFormSchema>;

type CreativeFormSource = {
  name: string;
  assetUrl: string | null;
  format: string | null;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  ownership: string | null;
  teamId?: string | null;
  attributes: {
    hook?: string;
    cta?: string;
  };
  tone: string[] | null;

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
    hook: creative?.attributes.hook ?? "",
    tone: creative?.tone ?? [],
    cta: creative?.attributes.cta ?? "",

    ownership: normalizeOwnership(creative?.ownership),
    teamId: creative?.teamId ?? null,
    notes: creative?.notes ?? "",
  };
}

function emptyToNull(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toCreativeMutationInput(values: CreativeFormValues) {
  const angle = emptyToNull(values.angle);
  const persona = emptyToNull(values.persona);
  return {
    name: values.name.trim() || undefined,
    assetUrl: values.assetUrl,
    format: values.format,
    // Never sent as an explicit null: clearing an enforced tag is not an edit
    // the app offers, and the server rejects it (§6.1).
    ...(angle ? { angle: angle as (typeof ANGLE_TYPES)[number] } : {}),
    ...(persona ? { persona } : {}),
    ...(values.awarenessLevel
      ? { awarenessLevel: values.awarenessLevel }
      : {}),
    attributes: {
      hook: emptyToNull(values.hook),
      cta: emptyToNull(values.cta),
    },
    tone: values.tone.length > 0 ? values.tone : null,

    ownership: values.ownership,
    teamId: values.teamId,
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
      values.attributes.hook ||
      (values.tone && values.tone.length > 0) ||
      values.attributes.cta ||

      values.notes,
  );
}
