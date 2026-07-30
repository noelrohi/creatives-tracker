/**
 * `YYYY-MM-DD` day strings — the unit every attribution read is keyed on. The
 * arithmetic runs in UTC because the strings carry no clock; the store timezone
 * is applied once, at ingest, when a timestamp becomes a day.
 */

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: string): boolean {
  return DAY_PATTERN.test(value);
}

export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid day: ${day}`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
