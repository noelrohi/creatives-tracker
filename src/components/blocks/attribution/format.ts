/**
 * Display formatting only. Money arrives from the API as decimal strings (or, in
 * frozen finding payloads, as integer cents); it is parsed here at the last
 * moment to be printed and nowhere else — no client-side money arithmetic.
 */

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, fractionDigits: number) {
  const key = `${currency}:${fractionDigits}`;
  const cached = moneyFormatters.get(key);
  if (cached) return cached;

  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  moneyFormatters.set(key, formatter);
  return formatter;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whole units above $1,000, cents below — the same reading as the rest of the
 * app. Returns null when there is no number, so callers can reach for the
 * "no data yet" chip instead of printing a zero.
 */
export function formatMoney(
  value: string | number | null | undefined,
  currency: string,
): string | null {
  const amount = toNumber(value);
  if (amount === null) return null;
  const digits = Math.abs(amount) >= 1000 ? 0 : 2;
  return moneyFormatter(currency, digits).format(amount);
}

/** Always two decimals — used for the "$1.63 back" and goal figures. */
export function formatMoneyExact(
  value: string | number | null | undefined,
  currency: string,
): string | null {
  const amount = toNumber(value);
  if (amount === null) return null;
  return moneyFormatter(currency, 2).format(amount);
}

export function formatCentsMoney(
  cents: number | null | undefined,
  currency: string,
): string | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  return formatMoney(cents / 100, currency);
}

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

export function formatPercent(share: number | null | undefined): string | null {
  if (share == null || !Number.isFinite(share)) return null;
  return `${Math.round(share * 100)}%`;
}

/* ------------------------------------------------------------------ */
/* Clock + calendar, always in the store's timezone                    */
/* ------------------------------------------------------------------ */

/** "8:00" in store wall time — the stamp every freeze caption carries. */
export function formatClock(
  value: Date | string | null | undefined,
  timeZone: string,
): string | null {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/^0/, "");
}

/**
 * "Jul 28" for a YYYY-MM-DD day string. The day is already store-local, so it is
 * read as a bare calendar date in UTC; the store timezone is named separately in
 * the kicker rather than re-applied here.
 */
export function formatDay(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(`${day}T12:00:00Z`));
}

export function formatDayRange(dateFrom: string, dateTo: string): string {
  if (dateFrom === dateTo) return formatDay(dateFrom);
  return `${formatDay(dateFrom)} – ${formatDay(dateTo)}`;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Aug 6" for a timestamp, read in store wall time. */
export function formatDateInZone(
  value: Date | string | null | undefined,
  timeZone: string,
): string | null {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(date);
}

/** "12 min ago" · "3 hrs ago" · "2 days ago". */
export function formatAge(
  value: Date | string | null | undefined,
  now: Date = new Date(),
): string | null {
  const date = toDate(value);
  if (!date) return null;

  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hr" : "hrs"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
