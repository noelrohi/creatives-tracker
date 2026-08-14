/** The honesty guardrail (§10): every score or tier badge repeats it. */
export const EVIDENCE_NOTE =
  "Scores reflect observable evidence — longevity, variants — not measured ad performance.";

/** Collection runs device-side, so an empty card points at the operator. */
export const NO_FILLS_NOTE =
  "No fills yet — data arrives when the operator runs a fill from their device";

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
