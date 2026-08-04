/**
 * One home for the "base rows only" filter every spend sum needs.
 *
 * `performance_log` holds a base row per ad/day plus one row per breakdown
 * (country, platform, placement, device, age, gender). The breakdown rows
 * repeat the same spend, so summing without this filter multiplies it.
 */

import { and, isNull } from "drizzle-orm";
import { performanceLogs } from "@/schema/performance-log";

/** Base Meta rows only; breakdown rows repeat the same spend. */
export function basePerformanceRowsOnly() {
  return and(
    isNull(performanceLogs.country),
    isNull(performanceLogs.platform),
    isNull(performanceLogs.placement),
    isNull(performanceLogs.device),
    isNull(performanceLogs.age),
    isNull(performanceLogs.gender),
  );
}
