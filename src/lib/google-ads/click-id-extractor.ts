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

/**
 * Extract query param KEYS from a raw query string (no leading "?"), values
 * discarded. Only tokens containing "=" are accepted — a bare token like
 * "Cj0KCQjw_RAW_VALUE" (no "=") is value-shaped, not a key, and must be
 * dropped rather than surfaced via URLSearchParams (which would otherwise
 * treat it as a key with an empty value, leaking raw values into paramKeys).
 */
function keysFromQueryString(query: string): string[] {
  const keys: string[] = [];
  for (const token of query.split("&")) {
    if (!token) continue;
    const eqIndex = token.indexOf("=");
    if (eqIndex < 0) continue;
    const rawKey = token.slice(0, eqIndex);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      // Keep the raw (undecoded) key on malformed percent-encoding.
    }
    keys.push(key.toLowerCase());
  }
  return keys;
}

/** Extract query param keys from an absolute or relative URL, values discarded. */
function queryKeys(url: string): string[] | null {
  try {
    const search = new URL(url).search;
    return keysFromQueryString(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    // Relative or otherwise non-absolute: fall back to the raw query string.
    const queryStart = url.indexOf("?");
    if (queryStart < 0) return [];
    try {
      return keysFromQueryString(url.slice(queryStart + 1));
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
