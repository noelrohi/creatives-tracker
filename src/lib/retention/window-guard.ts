/**
 * Request-time guards for the retention windows in `policy.ts`.
 *
 * Reads (breakdown detail) and writes (base rows) are both bounded: asking for
 * data outside a window can only ever return a partial answer, so we reject the
 * request instead of quietly serving a truncated one. The UI clamps first, so
 * these errors are a backstop rather than a normal path.
 */

import { TRPCError } from "@trpc/server";
import { formatDateOnly } from "@/lib/date";
import {
  BASE_RETENTION_DAYS,
  BREAKDOWN_RETENTION_DAYS,
  baseWindowStart,
  breakdownWindowStart,
} from "./policy";

/** Today as YYYY-MM-DD, evaluated per request so the window rolls forward. */
export function todayYmd() {
  return formatDateOnly(new Date());
}

/**
 * Reject a breakdown query that reaches past the retained breakdown window.
 * Dates are YYYY-MM-DD, so lexical comparison is chronological.
 */
export function assertBreakdownRange(from: string, today: string = todayYmd()) {
  const windowStart = breakdownWindowStart(today);
  if (from < windowStart) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Breakdown detail is retained for ${BREAKDOWN_RETENTION_DAYS} days (since ${windowStart}). Request a range within that window or export base rows.`,
    });
  }
}

/** The later of `from` and the breakdown window start. */
export function clampToBreakdownWindow(from: string, today: string = todayYmd()) {
  const windowStart = breakdownWindowStart(today);
  return from < windowStart ? windowStart : from;
}

/** Reject a write whose date falls outside the retained base window. */
export function assertBaseDate(date: string, today: string = todayYmd()) {
  const windowStart = baseWindowStart(today);
  if (date < windowStart) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Performance rows are retained for ${BASE_RETENTION_DAYS} days (since ${windowStart}). ${date} is outside that window.`,
    });
  }
}
