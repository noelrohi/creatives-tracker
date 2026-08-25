import { format, parse } from "date-fns";

const DATE_ONLY_PATTERN = "yyyy-MM-dd";
const DATE_ONLY_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * The YYYY-MM-DD a moment falls on in a given IANA timezone — what "today"
 * means where the data lives, not where the browser sits. Falls back to the
 * local-clock date when the zone name is invalid.
 */
export function formatDateOnlyInTimeZone(date: Date, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return formatDateOnly(date);
  }
}

export function formatDateOnly(date: Date) {
  return format(date, DATE_ONLY_PATTERN);
}

export function parseDateOnly(value: string) {
  return parse(value, DATE_ONLY_PATTERN, new Date());
}

export function isDateOnlyString(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function normalizeDateOnly(value: string) {
  if (DATE_ONLY_PREFIX.test(value)) {
    return value.slice(0, 10);
  }

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return formatDateOnly(date);
  }

  return value;
}

