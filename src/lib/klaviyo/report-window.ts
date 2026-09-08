import { addDays } from "@/lib/day";
import {
  inclusiveStoreDaysToHalfOpenUtc,
  type HalfOpenWindow,
} from "@/lib/evidence-window";
import { deriveDayInTimezone } from "@/lib/shopify-ingest";

/** The ledger's default range: 30 inclusive account-timezone days ending today. */
export const NIGHTLY_REPORT_INCLUSIVE_DAYS = 30;

/**
 * The window the nightly report generation must request so it lands on the
 * exact slot the ledger reads.
 *
 * Both day strings are derived IN THE ACCOUNT TIMEZONE, the same way the lab
 * derives its range from `todayInAccountTz`. Deriving them from UTC days
 * instead put the nightly `requested_from`/`requested_to` a day ahead of the
 * ledger's for every account east of UTC, and `loadLedgerRows` matches those
 * columns by exact equality — so the ledger read "No report for this range
 * yet" forever.
 */
export function nightlyReportWindow(
  now: Date,
  accountTimezone: string,
): HalfOpenWindow {
  const today = deriveDayInTimezone(now, accountTimezone);
  return inclusiveStoreDaysToHalfOpenUtc({
    dateFrom: addDays(today, -(NIGHTLY_REPORT_INCLUSIVE_DAYS - 1)),
    dateTo: today,
    timeZone: accountTimezone,
  });
}
