import { pgEnum } from "drizzle-orm/pg-core";

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

export const funnelPositionEnum = pgEnum("funnel_position", [
  "cold_traffic_entry",
  "retarget",
  "upsell",
]);

export const objectiveEnum = pgEnum("objective", [
  "conversions",
  "traffic",
  "engagement",
  "awareness",
  "leads",
  "app_installs",
]);
