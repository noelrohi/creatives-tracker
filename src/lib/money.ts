/**
 * Money as integer cents. Amounts arrive from Shopify and from Postgres
 * `numeric` columns as decimal strings; they are parsed once here and never
 * become floats, so bucket sums can hit the Shopify total exactly.
 */

const DECIMAL_PATTERN = /^(-?)(\d*)(?:\.(\d+))?$/;

/** Parses a money string into integer cents without float drift. */
export function toCents(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined) return 0;
  const raw = String(amount).trim();
  if (raw.length === 0) return 0;

  const match = DECIMAL_PATTERN.exec(raw);
  if (!match) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }

  const [, sign, whole, fraction = ""] = match;
  const padded = `${fraction}00`;
  const cents =
    Number(whole || "0") * 100 +
    Number(padded.slice(0, 2)) +
    (Number(fraction[2] ?? "0") >= 5 ? 1 : 0);

  return sign === "-" ? -cents : cents;
}

/** Renders integer cents back into a numeric-column-safe decimal string. */
export function centsToAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
