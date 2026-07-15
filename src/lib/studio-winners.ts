export const WINNER_WINDOW_DAYS = 28;
export const WINNER_TREND_SPLIT_DAYS = 14;
export const WINNER_MIN_SPEND = 100;
export const WINNER_MIN_PURCHASES = 3;
export const WINNER_LIMIT = 4;
export const WINNER_MAX_PER_ANGLE = 2;

export type WinnerTrend = "rising" | "stable" | "declining" | "paused";

export type ScoredStudioWinner<T> = T & { score: number };

// Studio only produces static images, so motion formats never qualify as
// winners — not even through the relaxed fallback pool.
export const WINNER_EXCLUDED_FORMATS = new Set(["video", "ugc"]);

type StudioWinnerCandidate = {
  assetUrl: string | null;
  angle: string | null;
  format?: string | null;
  spend: number;
  purchases: number;
  roas: number;
};

export function selectStudioWinners<T extends StudioWinnerCandidate>(
  allCandidates: T[],
): Array<ScoredStudioWinner<T>> {
  const candidates = allCandidates.filter(
    (candidate) => !WINNER_EXCLUDED_FORMATS.has(candidate.format ?? ""),
  );
  const eligible = candidates.filter(
    (candidate) =>
      candidate.spend >= WINNER_MIN_SPEND &&
      candidate.purchases >= WINNER_MIN_PURCHASES &&
      Boolean(candidate.assetUrl),
  );
  const pool =
    eligible.length > 0
      ? eligible
      : candidates.filter(
          (candidate) =>
            (candidate.spend > 0 || candidate.purchases > 0) &&
            Boolean(candidate.assetUrl),
        );

  const byAssetUrl = new Map<string, T>();
  for (const candidate of pool) {
    if (!candidate.assetUrl) continue;
    const existing = byAssetUrl.get(candidate.assetUrl);
    if (!existing || candidate.spend > existing.spend) {
      byAssetUrl.set(candidate.assetUrl, candidate);
    }
  }

  const deduped = Array.from(byAssetUrl.values());
  const positiveRoas = deduped
    .map((candidate) => candidate.roas)
    .filter((roas) => roas > 0)
    .sort((a, b) => a - b);
  const middle = Math.floor(positiveRoas.length / 2);
  const medianRoas =
    positiveRoas.length === 0
      ? 1
      : positiveRoas.length % 2 === 0
        ? (positiveRoas[middle - 1] + positiveRoas[middle]) / 2
        : positiveRoas[middle];

  const scored = deduped
    .map((candidate) => ({
      ...candidate,
      score:
        (candidate.roas / Math.max(medianRoas, 0.01)) *
        Math.log1p(candidate.spend),
    }))
    .sort((a, b) => b.score - a.score);

  const angleCounts = new Map<string, number>();
  const winners: Array<ScoredStudioWinner<T>> = [];
  for (const candidate of scored) {
    const angleBucket = candidate.angle?.trim().toLowerCase() || "untagged";
    const count = angleCounts.get(angleBucket) ?? 0;
    if (count >= WINNER_MAX_PER_ANGLE) continue;

    angleCounts.set(angleBucket, count + 1);
    winners.push(candidate);
    if (winners.length === WINNER_LIMIT) break;
  }

  return winners;
}

export function classifyTrend(input: {
  recentRoas: number;
  priorRoas: number;
  recentSpend: number;
}): WinnerTrend {
  if (input.recentSpend < 1) return "paused";
  if (input.priorRoas <= 0) return input.recentRoas > 0 ? "rising" : "stable";
  if (input.recentRoas >= input.priorRoas * 1.15) return "rising";
  if (input.recentRoas <= input.priorRoas * 0.7) return "declining";
  return "stable";
}
