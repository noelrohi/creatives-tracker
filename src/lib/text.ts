/**
 * Case folding for values that arrive from Shopify or a UTM string: trimmed and
 * lowercased, with empty treated as absent. One helper, so the bucket rule and
 * the ingest mapper fold identically.
 */
export function normalizeLower(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
