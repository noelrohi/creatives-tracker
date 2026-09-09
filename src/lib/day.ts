/**
 * `YYYY-MM-DD` day strings — the unit every attribution read is keyed on. The
 * arithmetic runs in UTC because the strings carry no clock; the store timezone
 * is applied once, at ingest, when a timestamp becomes a day.
 */

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A well-formed AND real calendar day. The pattern alone accepts
 * "2026-02-31", which `Date` silently normalizes to March 3 — so a URL
 * carrying an impossible day must fall back rather than shift.
 */
export function isDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid day: ${day}`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
