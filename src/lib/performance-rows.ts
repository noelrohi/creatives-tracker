/**
 * One home for the "base rows only" filter every spend sum needs.
 *
 * `performance_log` holds a base row per ad/day plus one row per breakdown
 * (country, platform, placement, device, age, gender). The breakdown rows
 * repeat the same spend, so summing without this filter multiplies it.
 */

import { sql } from "drizzle-orm";
import { performanceLogs } from "@/schema/performance-log";

/**
 * Base Meta rows only; breakdown rows repeat the same spend.
 *
 * A dimension counts as unset when it is NULL or '' — the same contract as
 * `basePerformanceLogFilter` (raw SQL) and the retention grain rules. Some
 * legacy imports wrote '' instead of NULL, and every reader must classify
 * those rows the same way.
 */
export function basePerformanceRowsOnly() {
  return sql`(
    coalesce(${performanceLogs.country}, '') = ''
    and coalesce(${performanceLogs.platform}, '') = ''
    and coalesce(${performanceLogs.placement}, '') = ''
    and coalesce(${performanceLogs.device}, '') = ''
    and coalesce(${performanceLogs.age}, '') = ''
    and coalesce(${performanceLogs.gender}, '') = ''
  )`;
}
