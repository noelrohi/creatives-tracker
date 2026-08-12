/**
 * Retention windows for the storage-retention system
 * (docs/superpowers/specs/2026-08-12-storage-retention-design.md).
 *
 * Everything takes an explicit `today` so callers and tests share one clock.
 * Cutoffs are exclusive: a row expires when its date_end (or business
 * timestamp) is strictly before the cutoff.
 */

import { formatDateOnly } from "@/lib/date";

/** Daily base/overall Meta rows (all six breakdown columns null). */
export const BASE_RETENTION_DAYS = 180;
/** Country/platform/placement/device/age/gender breakdown rows. */
export const BREAKDOWN_RETENTION_DAYS = 14;
/** Shopify/Klaviyo attribution evidence. */
export const EVIDENCE_RETENTION_DAYS = 90;

function subDaysYmd(todayYmd: string, days: number) {
  const date = new Date(`${todayYmd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return formatDateOnly(date);
}

/** First date (YYYY-MM-DD) still retained for base rows. */
export function baseWindowStart(todayYmd: string) {
  return subDaysYmd(todayYmd, BASE_RETENTION_DAYS);
}

/** First date (YYYY-MM-DD) still retained for breakdown rows. */
export function breakdownWindowStart(todayYmd: string) {
  return subDaysYmd(todayYmd, BREAKDOWN_RETENTION_DAYS);
}

/** First calendar date still retained for evidence tables. */
export function evidenceWindowStart(todayYmd: string) {
  return subDaysYmd(todayYmd, EVIDENCE_RETENTION_DAYS);
}

export type PerformanceRowGrain = "base" | "breakdown";

/**
 * A performance_log row is a breakdown row when any of the six dimension
 * columns is set; matches src/lib/performance-rows.ts.
 */
export function performanceRowGrain(row: {
  country?: string | null;
  platform?: string | null;
  placement?: string | null;
  device?: string | null;
  age?: string | null;
  gender?: string | null;
}): PerformanceRowGrain {
  return row.country ||
    row.platform ||
    row.placement ||
    row.device ||
    row.age ||
    row.gender
    ? "breakdown"
    : "base";
}

/** Retention window start for a row of the given grain. */
export function retentionWindowStart(
  grain: PerformanceRowGrain,
  todayYmd: string,
) {
  return grain === "base"
    ? baseWindowStart(todayYmd)
    : breakdownWindowStart(todayYmd);
}

/** Six characters is enough to recognize an org without exposing the id. */
export function redactOrganizationId(organizationId: string) {
  return `${organizationId.slice(0, 6)}…`;
}

/**
 * Clamp a report range to the breakdown window. `isClamped` drives the
 * "detail covers …" captions; `hasWindow` is false when the whole range
 * predates the window and there is nothing to chart.
 */
export function clampBreakdownRange(input: {
  from: string;
  to: string;
  today: string;
}) {
  const windowStart = breakdownWindowStart(input.today);
  const from = input.from < windowStart ? windowStart : input.from;
  return {
    from,
    isClamped: from !== input.from,
    hasWindow: from <= input.to,
  };
}

/**
 * Organizations allowed to actually delete. Unset or empty means every
 * retention run is a dry-run everywhere — production stays in this state
 * until cleanup is separately approved.
 */
export function retentionEnforcedOrganizationIds(
  env: NodeJS.ProcessEnv = process.env,
) {
  return new Set(
    (env.ADSOLUTE_RETENTION_ENFORCE_ORGANIZATION_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
