import { format, parse } from "date-fns";

const DATE_ONLY_PATTERN = "yyyy-MM-dd";
const DATE_ONLY_PREFIX = /^\d{4}-\d{2}-\d{2}/;

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

