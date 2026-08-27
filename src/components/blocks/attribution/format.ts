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

/** Descending: the first unit a figure clears is the one it prints in. */
const compactUnits = [
  { limit: 1_000_000_000, suffix: "B" },
  { limit: 1_000_000, suffix: "M" },
  { limit: 1_000, suffix: "K" },
] as const;

/**
 * Short money for axis ticks: `$18K`, `$13.5K`, `$1.2M`. A chart axis has a
 * few characters of room, and the figure only has to say roughly how high the
 * line is — the tooltip carries the exact number. Under $1,000 it prints whole
 * dollars, since "$0.9K" reads worse than "$900".
 *
 * The scaling is done here rather than with `Intl`'s compact notation, which
 * disagrees with itself across ICU versions — the same call returns "$18K" on
 * one machine and "$18.0K" on another, which is a test that passes locally and
 * fails in CI. Scaling by hand and formatting the small number in standard
 * notation is the same reading everywhere.
 */
export function formatMoneyCompact(
  value: string | number | null | undefined,
  currency: string,
): string | null {
  const amount = toNumber(value);
  if (amount === null) return null;

  const magnitude = Math.abs(amount);
  // Descending, so the first match is the largest unit that fits, and each
  // step toward index 0 is a bigger one.
  let index = compactUnits.findIndex((candidate) => magnitude >= candidate.limit);
  if (index === -1) return moneyFormatter(currency, 0).format(amount);

  /**
   * The rounding can carry into the next unit: $999,999 scales to 999.999K,
   * which rounds to 1,000.0 and would print "$1,000K" — not compact, and not
   * what a reader expects beside "$1M". Promote until the rounded figure fits
   * under a thousand, or until there is no larger unit left.
   */
  while (index > 0 && Math.abs(roundToTenth(amount / compactUnits[index].limit)) >= 1000) {
    index -= 1;
  }

  const unit = compactUnits[index];
  const scaled = amount / unit.limit;
  // One decimal, but never a trailing ".0": "$18K", not "$18.0K".
  const digits = Number.isInteger(roundToTenth(scaled)) ? 0 : 1;
  return `${moneyFormatter(currency, digits).format(scaled)}${unit.suffix}`;
}

function roundToTenth(value: number): number {
  return Number(value.toFixed(1));
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

/** A share that is small but real reads "<1%" — never a flat 0% beside money. */
export function formatPercent(share: number | null | undefined): string | null {
  if (share == null || !Number.isFinite(share)) return null;
  const percent = Math.round(share * 100);
  if (percent === 0 && share > 0) return "<1%";
  return `${percent}%`;
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
