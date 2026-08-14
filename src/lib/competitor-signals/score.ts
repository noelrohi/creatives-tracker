/**
 * Evidence scoring for competitor copy clusters (competitor-signals v1 §8).
 *
 * Pure and DB-free on purpose: the score is recomputable in-app at any time
 * from stored inputs (dates, creative counts, formats, URLs, verdict enum), so
 * a rescore never needs the original fill payload. Scores reflect *observable
 * evidence* — longevity, variant multiplication — never measured performance.
 */

export const LONGEVITY_POINTS = 35;
export const VARIANT_POINTS = 25;
export const STRATEGIC_POINTS = 15;
export const FORMAT_POINTS = 15;
export const LANDING_POINTS = 10;

/** 18 months — the longevity curve's ceiling (§8). */
export const MAX_LONGEVITY_DAYS = 547;
/** Creative count at which variant multiplication maxes out (§8). */
export const MAX_CREATIVES = 30;

export const HIGH_TIER_MIN = 65;
export const MODERATE_TIER_MIN = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ClusterVerdict = "high" | "medium" | "low";
export type ClusterTier = "high" | "moderate" | "watch";

/** The observable evidence one member ad contributes to its cluster's score. */
export type ScoredAdInput = {
  startDate: Date;
  /** Length of `variants[]`; the primary creative is counted on top of this. */
  variantCount: number;
  displayFormat: string;
  hasVideo: boolean;
  hasImage: boolean;
  linkUrl: string | null;
};

export type ScoreClusterInput = {
  ads: ScoredAdInput[];
  verdict: ClusterVerdict | null;
};

export type ScorePoints = {
  longevity: number;
  variant: number;
  strategic: number;
  format: number;
  landing: number;
};

export type ClusterScore = {
  score: number;
  tier: ClusterTier;
  points: ScorePoints;
};

type ResolvedFormat = "image" | "video" | "carousel";

const VERDICT_POINTS: Record<ClusterVerdict, number> = {
  high: 15,
  medium: 8,
  low: 3,
};

/**
 * Log curve, not linear: on real data the oldest live ad is ~105 days, so a
 * linear-to-18-months longevity made HIGH mathematically unreachable (§8).
 */
function logShare(value: number, ceiling: number): number {
  const clamped = Math.min(Math.max(value, 0), ceiling);
  return Math.log(1 + clamped) / Math.log(1 + ceiling);
}

export function longevityDays(ads: ScoredAdInput[], now: Date): number {
  if (ads.length === 0) return 0;
  const oldest = Math.min(...ads.map((ad) => ad.startDate.getTime()));
  const days = Math.floor((now.getTime() - oldest) / DAY_MS);
  return Math.min(Math.max(days, 0), MAX_LONGEVITY_DAYS);
}

/** Total creatives in the cluster: primary + `variants[]` per member ad. */
export function creativeCount(ads: ScoredAdInput[]): number {
  return ads.reduce((total, ad) => total + 1 + Math.max(ad.variantCount, 0), 0);
}

/** DCO/DPA are containers — they resolve to whatever media the ad actually carries. */
export function resolveFormat(ad: ScoredAdInput): ResolvedFormat | null {
  switch (ad.displayFormat.trim().toUpperCase()) {
    case "IMAGE":
      return "image";
    case "VIDEO":
      return "video";
    case "CAROUSEL":
      return "carousel";
    default:
      if (ad.hasVideo) return "video";
      if (ad.hasImage) return "image";
      return null;
  }
}

/** Query strings and fragments are tracking noise — the path is the destination. */
export function stripQuery(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed.split("#")[0].split("?")[0];
  }
}

/** Share of member ads pointing at the cluster's most common landing page. */
export function landingFocusShare(ads: ScoredAdInput[]): number {
  if (ads.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const ad of ads) {
    const url = stripQuery(ad.linkUrl);
    if (!url) continue;
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }

  let modalCount = 0;
  for (const value of counts.values()) {
    if (value > modalCount) modalCount = value;
  }

  return modalCount / ads.length;
}

export function tierForScore(score: number): ClusterTier {
  if (score >= HIGH_TIER_MIN) return "high";
  if (score >= MODERATE_TIER_MIN) return "moderate";
  return "watch";
}

/** Score one cluster's evidence, 0–100 (§8). */
export function scoreCluster(
  input: ScoreClusterInput,
  now: Date,
): ClusterScore {
  const { ads, verdict } = input;

  const longevity =
    logShare(longevityDays(ads, now), MAX_LONGEVITY_DAYS) * LONGEVITY_POINTS;
  const variant =
    logShare(creativeCount(ads), MAX_CREATIVES) * VARIANT_POINTS;
  const strategic = verdict ? VERDICT_POINTS[verdict] : 0;

  const formats = new Set<ResolvedFormat>();
  for (const ad of ads) {
    const format = resolveFormat(ad);
    if (format) formats.add(format);
  }
  const format = formats.size * (FORMAT_POINTS / 3);

  const landing = landingFocusShare(ads) * LANDING_POINTS;

  const score = longevity + variant + strategic + format + landing;

  return {
    score,
    tier: tierForScore(score),
    points: { longevity, variant, strategic, format, landing },
  };
}

/**
 * Row shapes the DB-backed callers already have. Declared structurally rather
 * than imported from the schema so this module stays DB-free.
 */
export type ScorableClusterRow = {
  id: string;
  verdict: ClusterVerdict | null;
};

export type ScorableAdRow = {
  copyClusterId: string | null;
  startDate: Date;
  displayFormat: string;
  linkUrl: string | null;
  variants: unknown[] | null;
  mirroredImageUrl: string | null;
  mirroredVideoUrl: string | null;
};

/** One cluster's scored columns, keyed to match `copy_cluster`. */
export type ClusterScoreUpdate = {
  clusterId: string;
  score: number;
  tier: ClusterTier;
  longevityPoints: number;
  variantPoints: number;
  strategicPoints: number;
  formatPoints: number;
  landingPoints: number;
};

export function toScoredAdInput(ad: ScorableAdRow): ScoredAdInput {
  return {
    startDate: ad.startDate,
    variantCount: ad.variants?.length ?? 0,
    displayFormat: ad.displayFormat,
    hasVideo: Boolean(ad.mirroredVideoUrl),
    hasImage: Boolean(ad.mirroredImageUrl),
    linkUrl: ad.linkUrl,
  };
}

/**
 * Score every cluster from its member ads. Shared by the post-ingest pipeline
 * and any later rescore so the row→input mapping lives in exactly one place.
 */
export function scoreCompetitorClusters(input: {
  clusters: ScorableClusterRow[];
  ads: ScorableAdRow[];
  now: Date;
}): ClusterScoreUpdate[] {
  const adsByCluster = new Map<string, ScoredAdInput[]>();
  for (const ad of input.ads) {
    if (!ad.copyClusterId) continue;
    const bucket = adsByCluster.get(ad.copyClusterId) ?? [];
    bucket.push(toScoredAdInput(ad));
    adsByCluster.set(ad.copyClusterId, bucket);
  }

  return input.clusters.map((cluster) => {
    const { score, tier, points } = scoreCluster(
      { ads: adsByCluster.get(cluster.id) ?? [], verdict: cluster.verdict },
      input.now,
    );

    return {
      clusterId: cluster.id,
      score,
      tier,
      longevityPoints: points.longevity,
      variantPoints: points.variant,
      strategicPoints: points.strategic,
      formatPoints: points.format,
      landingPoints: points.landing,
    };
  });
}
