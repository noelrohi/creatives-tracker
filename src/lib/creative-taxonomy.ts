import { awarenessLevelEnum } from "@/schema/enums";

export const CREATIVE_TAXONOMY_VERSION = 1;

export const ANGLE_TYPES = [
  "problem_solution",
  "social_proof",
  "comparison",
  "transformation",
  "skepticism",
  "offer_promo",
  "education",
] as const;
export type AngleType = (typeof ANGLE_TYPES)[number];

export const FUNNEL_STAGES = ["tof", "mof", "bof"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const VISUAL_STYLES = [
  "realistic",
  "cartoon",
  "ugc_photo",
  "3d_render",
  "illustration",
  "screenshot",
] as const;
export type VisualStyle = (typeof VISUAL_STYLES)[number];

export const MODES = ["light", "dark", "neutral", "coloured"] as const;
export type CreativeMode = (typeof MODES)[number];

export const AWARENESS_LEVELS = awarenessLevelEnum.enumValues;
export type AwarenessLevel = (typeof AWARENESS_LEVELS)[number];
