/** The honesty guardrail (§10): every score or tier badge repeats it. */
export const EVIDENCE_NOTE =
  "Scores reflect observable evidence — longevity, variants — not measured ad performance.";

/** Collection runs device-side, so an empty card points at the operator. */
export const NO_FILLS_NOTE =
  "No fills yet — data arrives when the operator runs a fill from their device";

/** A cluster whose verdict never validated (§8): strategic scores 0, flagged. */
export const NO_VERDICT_NOTE =
  "The fill's strategic verdict didn't validate — strategic contributes 0 until the next fill.";

/** Ledger empty state — clusters only ever arrive with a fill. */
export const NO_CLUSTERS_NOTE =
  "No signals yet — clusters arrive with the next fill that carries them";

/** Zero-competitor empty state — before fills are even in the picture. */
export const NO_COMPETITORS_NOTE =
  "Track a competitor's Meta page to start collecting their public ads";

const SOURCE_LABELS: Record<string, string> = {
  meta_ads_collector: "MetaAdsCollector",
  scrapecreators: "ScrapeCreators",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}
