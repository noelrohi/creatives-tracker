/**
 * YYYY-MM-DD arithmetic in UTC — the day strings carry no clock, so they can be
 * shifted without ever touching the browser's timezone. Every range on this page
 * is anchored on the store's own "today", never on `new Date()`.
 */

export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid day: ${day}`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Inclusive day count, e.g. Jul 1 → Jul 7 is 7. */
export function dayCount(dateFrom: string, dateTo: string): number {
  const from = Date.parse(`${dateFrom}T00:00:00Z`);
  const to = Date.parse(`${dateTo}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.floor((to - from) / 86_400_000) + 1;
}

/** A `Date` positioned at noon UTC, safe to hand to a calendar widget. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

/** The calendar day a picker selection lands on, read in local wall time. */
export function dateToDay(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const dayOfMonth = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
}
