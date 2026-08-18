"use client";

import { tierColor } from "./colors";
import { RESOLVED_FORMAT_PHRASES, daysSince } from "./display";
import type { ClusterTier, RankedSignal } from "./types";

const EM_DASH = "—";

/**
 * §8's five components, in formula order, with their point ceilings. The bar
 * still shows points/max, but the value each bar carries is written as a
 * plain-words phrase — "on air 105 days", never "25.9/35". `description` is
 * the plain-language line the score explainer shows for the component, so the
 * meters and the "how it's scored" popover can never drift apart.
 */
export const SCORE_COMPONENTS = [
  {
    key: "longevityPoints",
    label: "Staying power",
    max: 35,
    description:
      "How long the message has been on air, counted from its oldest ad still running. Ads that survive keep earning their budget.",
    phrase: (signal: RankedSignal) => {
      const days = daysSince(signal.oldestStartDate);
      return days === null ? EM_DASH : `on air ${days} days`;
    },
  },
  {
    key: "variantPoints",
    label: "Variations",
    max: 25,
    description:
      "How many creative versions carry the message, counting each ad's variants. More versions means the competitor keeps investing in it.",
    // The same count the bar is scored from: primary + variants per ad (§8).
    phrase: (signal: RankedSignal) =>
      `${signal.creativeCount} ${signal.creativeCount === 1 ? "version" : "versions"} running`,
  },
  {
    key: "strategicPoints",
    label: "Relevance",
    max: 15,
    description:
      "How directly the message competes with your positioning, assessed on each data update.",
    phrase: (signal: RankedSignal) => {
      switch (signal.verdict) {
        case "high":
          return "aims straight at your space";
        case "medium":
          return "some overlap with your space";
        case "low":
          return "little overlap with your space";
        default:
          return "not assessed";
      }
    },
  },
  {
    key: "formatPoints",
    label: "Format mix",
    max: 15,
    description:
      "How many formats the message spans — images, video, carousels. Each one in play adds points.",
    phrase: (signal: RankedSignal) => {
      if (signal.formatsObserved.length === 0) return EM_DASH;
      return signal.formatsObserved
        .map((format) => RESOLVED_FORMAT_PHRASES[format] ?? format)
        .join(" + ");
    },
  },
  {
    key: "landingPoints",
    label: "Landing focus",
    max: 10,
    description:
      "The share of the ads pointing at one landing page. Focus suggests a deliberate push, not leftovers.",
    phrase: (signal: RankedSignal) =>
      signal.landingFocusUrl
        ? `${Math.round(signal.landingFocusShare * 100)}% to one page`
        : EM_DASH,
  },
] as const satisfies ReadonlyArray<{
  key: keyof RankedSignal;
  label: string;
  max: number;
  description: string;
  phrase: (signal: RankedSignal) => string;
}>;

function Meter({
  label,
  phrase,
  value,
  max,
  accent,
}: {
  label: string;
  phrase: string;
  value: number;
  max: number;
  accent: string;
}) {
  const share = Math.max(0, Math.min(1, value / max));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{phrase}</span>
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
 * still shows Relevance, at 0 with "not assessed", rather than hiding the
 * reason it scored low.
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
      {SCORE_COMPONENTS.map((component) => (
        <Meter
          key={component.key}
          label={component.label}
          phrase={component.phrase(signal)}
          value={signal[component.key] ?? 0}
          max={component.max}
          accent={accent}
        />
      ))}
    </div>
  );
}
