/**
 * The creative-insights wire vocabulary: the constants and row shapes the API
 * and the screen both speak.
 *
 * It exists for one reason — `creative-insights-queries.ts` imports `@/db`, and
 * a client component that reaches for a slice key must not drag `pg` into the
 * browser bundle. Same split, same reason, as `attribution.shared.ts`.
 *
 * Nothing here may import a database, a schema table, or anything server-only.
 */

/* ------------------------------------------------------------------ */
/* Constants and vocabulary                                            */
/* ------------------------------------------------------------------ */

/** A slice needs this much spend behind it before a claim is written about it. */
export const INSIGHT_MIN_SPEND = 250;

/** §6.4: aggregate slices unveil at 80% of active Meta spend fully tagged. */
export const TAGGED_SPEND_MIN_SHARE = 0.8;

/** The trailing window coverage and the tagging queue are measured over. */
export const COVERAGE_WINDOW_DAYS = 7;

export const SLICE_DIMENSIONS = [
  "angle",
  "persona",
  "awareness",
  "funnelStage",
] as const;
export type SliceDimension = (typeof SLICE_DIMENSIONS)[number];

/** The two rows that are always present, whatever the data says. */
export const NO_TAGS_KEY = "no_tags_yet";
export const UNMATCHED_KEY = "unmatched_ad";
export const EXPLICIT_SLICE_KEYS = [NO_TAGS_KEY, UNMATCHED_KEY] as const;

export const ENFORCED_TAGS = [
  "funnelStage",
  "persona",
  "angle",
  "awareness",
] as const;
export type EnforcedTag = (typeof ENFORCED_TAGS)[number];

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type InsightsScope = {
  organizationId: string;
  storeId: string;
  dateFrom: string;
  dateTo: string;
};

export type SliceRow = {
  key: string;
  revenueCents: number;
  orderCount: number;
  /** Null for `unmatched_ad`: spend is an ad-side figure and there is no ad. */
  spendCents: number | null;
  /** Revenue per $1 of spend. Null when there is no spend to divide by. */
  backPer1: number | null;
};

export type CoverageAdRow = {
  adId: string;
  adName: string;
  creativeId: string | null;
  funnelStage: string | null;
  persona: string | null;
  angle: string | null;
  awarenessLevel: string | null;
  spendCents: number;
};

export type CoverageSummary = {
  totalActiveSpendCents: number;
  taggedSpendCents: number;
  untaggedSpendCents: number;
  /** Null when nothing was spent — a share of nothing is not zero. */
  share: number | null;
  gated: boolean;
  activeAdCount: number;
  untaggedAdCount: number;
  topUntaggedAds: Array<{
    adId: string;
    adName: string;
    creativeId: string | null;
    spendCents: number;
    missing: EnforcedTag[];
  }>;
};

export type InsightCard = {
  dimension: SliceDimension;
  value: string;
  backPer1: number;
  spendCents: number;
  revenueCents: number;
  runnerUp: { value: string; backPer1: number } | null;
  /** The proof bars printed inside the card, best first. */
  bars: Array<{ value: string; backPer1: number }>;
};

export type DrillInAdRow = {
  adId: string;
  adName: string;
  spendCents: number;
  revenueCents: number;
  backPer1: number | null;
  clicks: number;
  landingPageViews: number;
  addToCart: number;
};

export type TaggingQueueRow = {
  adId: string;
  adName: string;
  creativeId: string | null;
  adSetName: string | null;
  campaignName: string | null;
  spendCents: number;
  missing: EnforcedTag[];
};
