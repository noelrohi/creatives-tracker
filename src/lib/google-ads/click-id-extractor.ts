import type { ClickIdKind } from "@/lib/google-ads/types";

export type ClickIdObservation = {
  /** Sorted, deduplicated kinds observed across landing page + referrer. */
  kinds: ClickIdKind[];
  /** customerJourney null / lastVisit absent — nothing to inspect. */
  journeyMissing: boolean;
  /** At least one URL string present but unparseable even via fallback. */
  parseFailed: boolean;
  /** Query parameter KEYS observed (never values), for shape fingerprinting. */
  paramKeys: string[];
};

const CLICK_ID_KINDS: readonly ClickIdKind[] = ["gclid", "wbraid", "gbraid"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract query param keys from an absolute or relative URL, values discarded. */
function queryKeys(url: string): string[] | null {
  try {
    return [...new URL(url).searchParams.keys()];
  } catch {
    // Relative or otherwise non-absolute: fall back to the raw query string.
    const queryStart = url.indexOf("?");
    if (queryStart < 0) return [];
    try {
      return [...new URLSearchParams(url.slice(queryStart + 1)).keys()];
    } catch {
      return null;
    }
  }
}

/**
 * Inspects the stored Shopify journey (customerJourneySummary shape: last
 * visit only) entirely in memory. Returns key presence only — click-ID
 * values never leave this function.
 */
export function extractClickIdObservation(
  customerJourney: Record<string, unknown> | null,
): ClickIdObservation {
  const lastVisit =
    customerJourney && isRecord(customerJourney.lastVisit)
      ? customerJourney.lastVisit
      : null;
  if (!lastVisit) {
    return { kinds: [], journeyMissing: true, parseFailed: false, paramKeys: [] };
  }

  const urls = [lastVisit.landingPage, lastVisit.referrerUrl].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const keys = new Set<string>();
  let parseFailed = false;
  for (const url of urls) {
    const extracted = queryKeys(url);
    if (extracted === null) {
      parseFailed = true;
      continue;
    }
    for (const key of extracted) keys.add(key.toLowerCase());
  }

  const kinds = CLICK_ID_KINDS.filter((kind) => keys.has(kind)).sort();
  return {
    kinds,
    journeyMissing: false,
    parseFailed,
    paramKeys: [...keys].sort(),
  };
}
