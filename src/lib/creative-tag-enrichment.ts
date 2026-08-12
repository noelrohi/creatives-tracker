/**
 * Pure write-time rules for AI creative tag enrichment (spec §2, §3, §6.2).
 *
 * The model proposes; this module decides what is actually stored. Two rules
 * are absolute: a field marked `human` in `attributesMeta` is never overwritten,
 * and a value outside a closed vocabulary is never stored — it is dropped and
 * reported so the run log shows what the model tried to say.
 */
import type { CreativeAttributes } from "@/schema/ad-creative";
import {
  ANGLE_TYPES,
  AWARENESS_LEVELS,
  FUNNEL_STAGES,
  MODES,
  VISUAL_STYLES,
  type AngleType,
  type AwarenessLevel,
  type CreativeMode,
  type FunnelStage,
  type VisualStyle,
} from "./creative-taxonomy";

export type AttributeProvenance = { source: "ai" | "human"; confidence?: number };
export type AttributesMeta = Record<string, AttributeProvenance>;

/** The three enforced fields that live as typed columns on `ad_creative`. */
export const ENFORCED_CREATIVE_FIELDS = [
  "persona",
  "angle",
  "awarenessLevel",
] as const;
export type EnforcedCreativeField = (typeof ENFORCED_CREATIVE_FIELDS)[number];

/** The eight captured attributes that live in the `attributes` jsonb blob. */
export const CAPTURED_ATTRIBUTE_FIELDS = [
  "visualElements",
  "visualStyle",
  "mode",
  "hook",
  "supportingTexts",
  "cta",
  "promos",
  "disclaimer",
] as const;

export type CreativeTagModelOutput = {
  persona: string | null;
  angle: string | null;
  awarenessLevel: string | null;
  confidence: {
    persona: number | null;
    angle: number | null;
    awarenessLevel: number | null;
  };
  attributes: {
    visualElements: string[] | null;
    visualStyle: string | null;
    mode: string | null;
    hook: string | null;
    supportingTexts: string[] | null;
    cta: string | null;
    promos: string | null;
    disclaimer: string | null;
  };
};

export type RejectedTag = {
  field: string;
  value: string;
  confidence: number | null;
};

export type CreativeTagUpdate = {
  /** True when at least one column or attribute value actually changes. */
  changed: boolean;
  persona?: string;
  angle?: AngleType;
  awarenessLevel?: AwarenessLevel;
  /** Merged blob — existing values plus whatever the model was allowed to add. */
  attributes: CreativeAttributes;
  /** Merged provenance map, always covering every field written this pass. */
  attributesMeta: AttributesMeta;
  /** Fields left alone because a human owns them. */
  skippedHuman: string[];
  /** Model values dropped for being outside a closed vocabulary. */
  rejected: RejectedTag[];
};

/** Lowercase + collapse separators so "Problem Solution" matches `problem_solution`. */
function normalizeVocabularyValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/_+/g, "_");
}

function matchVocabulary<T extends string>(
  value: string | null | undefined,
  vocabulary: readonly T[],
): T | null {
  if (!value) return null;
  const normalized = normalizeVocabularyValue(value);
  return vocabulary.find((entry) => entry === normalized) ?? null;
}

export function normalizeAngle(value: string | null | undefined): AngleType | null {
  return matchVocabulary(value, ANGLE_TYPES);
}

export function normalizeAwarenessLevel(
  value: string | null | undefined,
): AwarenessLevel | null {
  return matchVocabulary(value, AWARENESS_LEVELS);
}

export function normalizeVisualStyle(
  value: string | null | undefined,
): VisualStyle | null {
  return matchVocabulary(value, VISUAL_STYLES);
}

export function normalizeMode(value: string | null | undefined): CreativeMode | null {
  return matchVocabulary(value, MODES);
}

export function normalizeFunnelStage(
  value: string | null | undefined,
): FunnelStage | null {
  return matchVocabulary(value, FUNNEL_STAGES);
}

/** Confidences are stored 0–1; anything else is treated as "not reported". */
export function clampConfidence(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function cleanTextArray(value: string[] | null | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  const cleaned = value
    .map((entry) => cleanText(entry))
    .filter((entry): entry is string => entry !== null);
  return cleaned.length > 0 ? cleaned : null;
}

function isHumanOwned(meta: AttributesMeta, field: string): boolean {
  return meta[field]?.source === "human";
}

function provenance(confidence: number | null): AttributeProvenance {
  return confidence === null
    ? { source: "ai" }
    : { source: "ai", confidence };
}

/**
 * Decide the exact write for one creative. Callers pass the row as stored and
 * the raw model output; everything else — human stickiness, vocabulary checks,
 * blob merging, provenance stamping — happens here.
 */
export function buildCreativeTagUpdate(params: {
  existing: {
    persona: string | null;
    angle: string | null;
    awarenessLevel: string | null;
    attributes: CreativeAttributes | null;
    attributesMeta: AttributesMeta | null;
  };
  output: CreativeTagModelOutput;
}): CreativeTagUpdate {
  const { existing, output } = params;
  const attributes: CreativeAttributes = { ...(existing.attributes ?? {}) };
  const attributesMeta: AttributesMeta = { ...(existing.attributesMeta ?? {}) };
  const skippedHuman: string[] = [];
  const rejected: RejectedTag[] = [];
  const update: CreativeTagUpdate = {
    changed: false,
    attributes,
    attributesMeta,
    skippedHuman,
    rejected,
  };

  const confidences = output.confidence ?? {
    persona: null,
    angle: null,
    awarenessLevel: null,
  };

  // --- Enforced trio (typed columns, provenance in the same meta map) ---
  // A valid null still records that AI inspected the field. Without that marker,
  // null verdicts stay eligible forever and consume another paid call next run.
  const markAttempted = (field: EnforcedCreativeField, confidence: number | null) => {
    const next = provenance(confidence);
    update.changed =
      update.changed || JSON.stringify(attributesMeta[field]) !== JSON.stringify(next);
    attributesMeta[field] = next;
  };

  const persona = cleanText(output.persona);
  if (isHumanOwned(attributesMeta, "persona")) {
    skippedHuman.push("persona");
  } else {
    markAttempted("persona", clampConfidence(confidences.persona));
    if (persona) {
      update.persona = persona;
      update.changed = update.changed || persona !== existing.persona;
    }
  }

  const rawAngle = cleanText(output.angle);
  if (isHumanOwned(attributesMeta, "angle")) {
    skippedHuman.push("angle");
  } else if (!rawAngle) {
    markAttempted("angle", clampConfidence(confidences.angle));
  } else {
    const angle = normalizeAngle(rawAngle);
    const confidence = clampConfidence(confidences.angle);
    if (angle === null) {
      rejected.push({ field: "angle", value: rawAngle, confidence });
    } else {
      markAttempted("angle", confidence);
      update.angle = angle;
      update.changed = update.changed || angle !== existing.angle;
    }
  }

  const rawAwareness = cleanText(output.awarenessLevel);
  if (isHumanOwned(attributesMeta, "awarenessLevel")) {
    skippedHuman.push("awarenessLevel");
  } else if (!rawAwareness) {
    markAttempted(
      "awarenessLevel",
      clampConfidence(confidences.awarenessLevel),
    );
  } else {
    const awarenessLevel = normalizeAwarenessLevel(rawAwareness);
    const confidence = clampConfidence(confidences.awarenessLevel);
    if (awarenessLevel === null) {
      rejected.push({ field: "awarenessLevel", value: rawAwareness, confidence });
    } else {
      markAttempted("awarenessLevel", confidence);
      update.awarenessLevel = awarenessLevel;
      update.changed =
        update.changed || awarenessLevel !== existing.awarenessLevel;
    }
  }

  // --- Eight captured attributes (jsonb blob, no confidence — never sliced) ---
  const proposed = output.attributes ?? ({} as CreativeTagModelOutput["attributes"]);
  const writeAttribute = (
    field: (typeof CAPTURED_ATTRIBUTE_FIELDS)[number],
    value: string | string[] | null,
  ) => {
    if (isHumanOwned(attributesMeta, field)) {
      skippedHuman.push(field);
      return;
    }
    if (value === null) return;
    const previous = attributes[field];
    (attributes as Record<string, unknown>)[field] = value;
    attributesMeta[field] = { source: "ai" };
    update.changed =
      update.changed || JSON.stringify(previous) !== JSON.stringify(value);
  };

  writeAttribute("visualElements", cleanTextArray(proposed.visualElements));

  const rawVisualStyle = cleanText(proposed.visualStyle);
  if (rawVisualStyle) {
    const visualStyle = normalizeVisualStyle(rawVisualStyle);
    if (visualStyle === null) {
      rejected.push({ field: "visualStyle", value: rawVisualStyle, confidence: null });
    } else {
      writeAttribute("visualStyle", visualStyle);
    }
  } else if (isHumanOwned(attributesMeta, "visualStyle")) {
    skippedHuman.push("visualStyle");
  }

  const rawMode = cleanText(proposed.mode);
  if (rawMode) {
    const mode = normalizeMode(rawMode);
    if (mode === null) {
      rejected.push({ field: "mode", value: rawMode, confidence: null });
    } else {
      writeAttribute("mode", mode);
    }
  } else if (isHumanOwned(attributesMeta, "mode")) {
    skippedHuman.push("mode");
  }

  writeAttribute("hook", cleanText(proposed.hook));
  writeAttribute("supportingTexts", cleanTextArray(proposed.supportingTexts));
  writeAttribute("cta", cleanText(proposed.cta));
  writeAttribute("promos", cleanText(proposed.promos));
  writeAttribute("disclaimer", cleanText(proposed.disclaimer));

  return update;
}

export type FunnelStageVerdict = {
  adSetId: string;
  funnelStage: FunnelStage | null;
  confidence: number | null;
};

/**
 * Keep verdicts naming a known ad set. A null stage is a valid attempted
 * classification; an unknown vocabulary value is rejected rather than stored.
 */
export function resolveFunnelStageVerdicts(params: {
  knownAdSetIds: readonly string[];
  verdicts: Array<{
    adSetId?: string | null;
    funnelStage?: string | null;
    confidence?: number | null;
  }>;
}): { accepted: FunnelStageVerdict[]; rejected: RejectedTag[] } {
  const known = new Set(params.knownAdSetIds);
  const accepted: FunnelStageVerdict[] = [];
  const rejected: RejectedTag[] = [];
  const seen = new Set<string>();

  for (const verdict of params.verdicts) {
    const adSetId = cleanText(verdict.adSetId);
    if (!adSetId || !known.has(adSetId) || seen.has(adSetId)) continue;
    const rawStage = cleanText(verdict.funnelStage);
    const confidence = clampConfidence(verdict.confidence);
    if (!rawStage) {
      seen.add(adSetId);
      accepted.push({ adSetId, funnelStage: null, confidence });
      continue;
    }
    const funnelStage = normalizeFunnelStage(rawStage);
    if (funnelStage === null) {
      rejected.push({ field: `funnelStage:${adSetId}`, value: rawStage, confidence });
      continue;
    }
    seen.add(adSetId);
    accepted.push({ adSetId, funnelStage, confidence });
  }

  return { accepted, rejected };
}
