// Number conventions are the Meta ledger's (imported, not copied); the one
// email-specific formatter is the percent with a single decimal.
export {
  EM_DASH,
  formatCurrency,
  toNumber,
} from "@/components/blocks/manager/manager-ledger-format";
import { EM_DASH } from "@/components/blocks/manager/manager-ledger-format";

/** Rates are 0..1 ratios from the loader; null renders as a dash, never 0.0%. */
export function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  return `${(value * 100).toFixed(1)}%`;
}

export function formatCount(value: number | null): string {
  return value == null ? EM_DASH : value.toLocaleString("en-US");
}

/** "Sep 1" style, in the viewer's locale; `null` is the flow's "ongoing" (copy). */
export function formatSentDay(value: string | Date | null): string | null {
  if (value == null) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
