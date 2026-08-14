"use client";

import { tierColor } from "./colors";
import type { ClusterTier } from "./types";

const EM_DASH = "—";

/**
 * The 0–100 score as a tier-coloured ring — a CSS conic-gradient, no chart
 * library. An unscored cluster keeps the ring (so the panel doesn't jump) but
 * renders it neutral and empty.
 */
export function ScoreDial({
  score,
  tier,
}: {
  score: number | null;
  tier: ClusterTier | null;
}) {
  const rounded = score === null ? null : Math.round(score);
  const filled = rounded === null ? 0 : Math.max(0, Math.min(100, rounded));
  const color = tier ? tierColor(tier) : "var(--muted-foreground)";

  return (
    <div
      className="relative size-28 shrink-0 rounded-full"
      style={{
        background: `conic-gradient(${color} ${filled * 3.6}deg, color-mix(in oklab, var(--muted-foreground) 18%, transparent) 0deg)`,
      }}
    >
      <div className="absolute inset-[10px] flex flex-col items-center justify-center rounded-full bg-card">
        <span
          className="text-2xl font-semibold tabular-nums"
          style={{ color: tier ? color : undefined }}
        >
          {rounded ?? EM_DASH}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Score
        </span>
      </div>
    </div>
  );
}
