import { pgEnum } from "drizzle-orm/pg-core";

export const statusEnum = pgEnum("status", [
  "active",
  "paused",
  "archived",
]);

export const formatEnum = pgEnum("format", [
  "static",
  "video",
  "ugc",
  "carousel",
]);

export const awarenessLevelEnum = pgEnum("awareness_level", [
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
]);

export const pageTypeEnum = pgEnum("page_type", [
  "product_page",
  "advertorial",
  "listicle",
  "quiz",
  "other",
]);

export const funnelStageEnum = pgEnum("funnel_stage", ["tof", "mof", "bof"]);

export const metaAdMatchMethodEnum = pgEnum("meta_ad_match_method", [
  "id",
  "name",
  "unmatched",
]);

export const lpClassificationStatusEnum = pgEnum("lp_classification_status", [
  "suggested",
  "confirmed",
  "stale",
]);

export const ownershipEnum = pgEnum("ownership", [
  "ours",
  "theirs",
]);

export const objectiveEnum = pgEnum("objective", [
  "conversions",
  "traffic",
  "engagement",
  "awareness",
  "leads",
  "app_installs",
]);
