// Metric formatting conventions copied from creative-list-columns.tsx so the
// two tables read identically: $ with the 100-threshold dp rule, ROAS 2dp + x,
// CTR 2dp + %, integer conversions, null -> em-dash.

export const EM_DASH = "—";

function toNumber(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatCurrency(value: string | null): string {
  const amount = toNumber(value);
  if (amount == null) return EM_DASH;
  return `$${amount >= 100 ? amount.toFixed(0) : amount.toFixed(2)}`;
}

export function formatRoas(value: string | null): string {
  const roas = toNumber(value);
  if (roas == null) return EM_DASH;
  return `${roas.toFixed(2)}x`;
}

// The router returns ctr as a 0-1 ratio of sums; display is a percent.
export function formatCtr(value: string | null): string {
  const ratio = toNumber(value);
  if (ratio == null) return EM_DASH;
  return `${(ratio * 100).toFixed(2)}%`;
}

export function formatConversions(value: number | null): string {
  return value == null ? EM_DASH : String(value);
}

// Heat cell (§5): soft tint only, no bars. Green >= 1.5x, red < 1.0x.
export function roasTintClassName(value: string | null): string {
  const roas = toNumber(value);
  if (roas == null) return "";
  if (roas >= 1.5) return "bg-emerald-500/10 dark:bg-emerald-400/10";
  if (roas < 1) return "bg-red-500/10 dark:bg-red-400/10";
  return "";
}
