/**
 * Every colour this screen paints, one record per concept. The values themselves
 * live in `globals.css` — a component never writes a hex literal, and a status
 * never picks its colour with an if-cascade of its own.
 */

import type { AttributionBucket } from "@/lib/attribution-bucket";
import type { CheckStatus, FindingType } from "@/lib/findings";
import { severityByType, type Severity } from "./copy";

const BUCKET_COLOR_VARS: Record<AttributionBucket, string> = {
  meta: "--attr-bucket-meta",
  google: "--attr-bucket-google",
  klaviyo: "--attr-bucket-klaviyo",
  tiktok: "--attr-bucket-tiktok",
  organic_direct: "--attr-bucket-organic",
  unattributed: "--attr-bucket-unknown",
  untracked: "--attr-bucket-none",
};

const SEVERITY_COLOR_VARS: Record<Severity, string> = {
  critical: "--attr-critical",
  warning: "--attr-warning",
};

/** "Needs a look" borrows the rule's own severity; the rest are fixed. */
const CHECK_STATUS_COLOR_VARS: Record<Exclude<CheckStatus, "needs_look">, string> =
  {
    ok: "--attr-good",
    waiting_for_data: "--muted-foreground",
  };

export function bucketColor(bucket: AttributionBucket): string {
  return `var(${BUCKET_COLOR_VARS[bucket]})`;
}

/**
 * Green is for clearing the goal. Under it, the figure reads as a warning.
 * One rule, so the header figure and every campaign row agree on what a
 * payback is worth — undefined when there is nothing to judge.
 */
export function paybackColor(
  back: number | null | undefined,
  goal: number | null | undefined,
): string | undefined {
  if (back == null || goal == null) return undefined;
  return back >= goal ? "var(--attr-good)" : "var(--attr-warning)";
}

export function severityColor(severity: Severity): string {
  return `var(${SEVERITY_COLOR_VARS[severity]})`;
}

export function checkStatusColor(
  status: CheckStatus,
  type: FindingType,
): string {
  if (status === "needs_look") return severityColor(severityByType[type]);
  return `var(${CHECK_STATUS_COLOR_VARS[status]})`;
}
