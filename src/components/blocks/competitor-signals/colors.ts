/**
 * Tier colour, one record per tier — the attribution status palette reused so a
 * cluster tier reads the same as a check status. Values live in `globals.css`;
 * nothing here writes a hex literal, and the tier is always carried by its
 * label as well as its colour.
 */

import type { ClusterTier } from "./types";

const TIER_COLOR_VARS: Record<ClusterTier, string> = {
  high: "--attr-good",
  moderate: "--attr-warning",
  watch: "--attr-neutral",
};

export const tierLabels: Record<ClusterTier, string> = {
  high: "Strong signal",
  moderate: "Promising",
  watch: "Early",
};

export function tierColor(tier: ClusterTier): string {
  return `var(${TIER_COLOR_VARS[tier]})`;
}

export function tierSoftColor(tier: ClusterTier): string {
  return `color-mix(in oklab, var(${TIER_COLOR_VARS[tier]}) 12%, var(--card))`;
}
