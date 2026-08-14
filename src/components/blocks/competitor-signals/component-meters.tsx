"use client";

import { tierColor } from "./colors";
import type { ClusterTier, RankedSignal } from "./types";

/** §8's five components, in formula order, with their point ceilings. */
const COMPONENTS = [
  { key: "longevityPoints", label: "Longevity", max: 35 },
  { key: "variantPoints", label: "Variants", max: 25 },
  { key: "strategicPoints", label: "Strategic", max: 15 },
  { key: "formatPoints", label: "Formats", max: 15 },
  { key: "landingPoints", label: "Landing", max: 10 },
] as const satisfies ReadonlyArray<{
  key: keyof RankedSignal;
  label: string;
  max: number;
}>;

function Meter({
  label,
  value,
  max,
  accent,
}: {
  label: string;
  value: number;
  max: number;
  accent: string;
}) {
  const share = Math.max(0, Math.min(1, value / max));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground/70">
          {value.toFixed(1)}/{max}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{ width: `${share * 100}%`, backgroundColor: accent }}
        />
      </div>
    </div>
  );
}

/**
 * The five component meters always render — a cluster with a broken verdict
 * still shows Strategic, at 0, rather than hiding the reason it scored low.
 */
export function ComponentMeters({
  signal,
  tier,
}: {
  signal: RankedSignal;
  tier: ClusterTier | null;
}) {
  const accent = tier
    ? `color-mix(in oklab, ${tierColor(tier)} 55%, transparent)`
    : "color-mix(in oklab, var(--muted-foreground) 45%, transparent)";

  return (
    <div className="flex flex-col gap-2.5">
      {COMPONENTS.map((component) => (
        <Meter
          key={component.key}
          label={component.label}
          value={signal[component.key] ?? 0}
          max={component.max}
          accent={accent}
        />
      ))}
    </div>
  );
}
