export type HalfOpenWindow = {
  from: Date;
  to: Date;
};

export type ShopifyEvidenceMode = "initial_90d" | "incremental_7d";

type CivilDay = { year: number; month: number; day: number };

const STORE_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseStoreDay(value: string): CivilDay {
  const match = STORE_DAY_PATTERN.exec(value);
  if (!match) throw new Error("Store day must be canonical YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new Error("Store day must be a real calendar day");
  }
  return { year, month, day };
}

function formatStoreDay(day: CivilDay): string {
  return `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

function addCalendarDays(day: CivilDay, amount: number): CivilDay {
  if (!Number.isSafeInteger(amount)) throw new Error("Invalid calendar offset");
  const result = { ...day };
  const direction = Math.sign(amount);
  for (let remaining = Math.abs(amount); remaining > 0; remaining -= 1) {
    result.day += direction;
    if (direction > 0 && result.day > daysInMonth(result.year, result.month)) {
      result.day = 1;
      result.month += 1;
      if (result.month > 12) {
        result.month = 1;
        result.year += 1;
      }
    } else if (direction < 0 && result.day < 1) {
      result.month -= 1;
      if (result.month < 1) {
        result.month = 12;
        result.year -= 1;
      }
      result.day = daysInMonth(result.year, result.month);
    }
    if (result.year < 1 || result.year > 9999) {
      throw new Error("Calendar day is outside the supported range");
    }
  }
  return result;
}

function localPartsAt(instant: Date, timeZone: string): Required<CivilDay> & {
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-hc-h23", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function civilUtcMilliseconds(input: CivilDay & {
  hour?: number;
  minute?: number;
  second?: number;
}): number {
  const value = new Date(0);
  value.setUTCFullYear(input.year, input.month - 1, input.day);
  value.setUTCHours(input.hour ?? 0, input.minute ?? 0, input.second ?? 0, 0);
  return value.getTime();
}

function compareCivilDay(
  left: Pick<Required<CivilDay>, "year" | "month" | "day">,
  right: CivilDay,
): number {
  if (left.year !== right.year) return left.year < right.year ? -1 : 1;
  if (left.month !== right.month) return left.month < right.month ? -1 : 1;
  if (left.day !== right.day) return left.day < right.day ? -1 : 1;
  return 0;
}

function localMidnightToUtc(day: CivilDay, timeZone: string): Date {
  const nominalUtc = civilUtcMilliseconds(day);
  const margin = 48 * 60 * 60 * 1_000;
  let before = nominalUtc - margin;
  let atOrAfter = nominalUtc + margin;

  if (
    compareCivilDay(localPartsAt(new Date(before), timeZone), day) >= 0 ||
    compareCivilDay(localPartsAt(new Date(atOrAfter), timeZone), day) < 0
  ) {
    throw new Error("Store-local civil day is outside the supported range");
  }

  // Find the first UTC millisecond whose rendered civil date is at least the
  // requested date. A midnight gap therefore resolves to the transition's
  // earliest representable instant; a jump over the date rejects it entirely.
  while (atOrAfter - before > 1) {
    const middle = before + Math.floor((atOrAfter - before) / 2);
    if (compareCivilDay(localPartsAt(new Date(middle), timeZone), day) < 0) {
      before = middle;
    } else {
      atOrAfter = middle;
    }
  }

  const result = new Date(atOrAfter);
  if (compareCivilDay(localPartsAt(result, timeZone), day) !== 0) {
    throw new Error("Store-local civil day cannot be represented");
  }
  return result;
}

export function assertValidStoreDay(value: string): void {
  parseStoreDay(value);
}

export function assertValidIanaTimezone(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Store timezone is invalid");
  }
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions()
      .timeZone;
  } catch {
    throw new Error("Store timezone is invalid");
  }
  if (resolved !== value) {
    throw new Error("Store timezone must be an exact IANA timezone");
  }
}

export function formatStoreDayAtInstant(
  instant: Date,
  timeZone: string,
): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new Error("Store-day instant must be a valid date");
  }
  assertValidIanaTimezone(timeZone);
  return formatStoreDay(localPartsAt(instant, timeZone));
}

export function inclusiveStoreDaysToHalfOpenUtc(input: {
  dateFrom: string;
  dateTo: string;
  timeZone: string;
}): HalfOpenWindow {
  assertValidIanaTimezone(input.timeZone);
  const fromDay = parseStoreDay(input.dateFrom);
  const toDay = parseStoreDay(input.dateTo);
  if (formatStoreDay(fromDay) > formatStoreDay(toDay)) {
    throw new Error("Store-day range must not be reversed");
  }
  return {
    from: localMidnightToUtc(fromDay, input.timeZone),
    to: localMidnightToUtc(addCalendarDays(toDay, 1), input.timeZone),
  };
}

export function deriveShopifyEvidenceWindow(input: {
  mode: ShopifyEvidenceMode;
  anchorStoreDay: string;
  timeZone: string;
}): HalfOpenWindow {
  assertValidStoreDay(input.anchorStoreDay);
  assertValidIanaTimezone(input.timeZone);
  if (input.mode !== "initial_90d" && input.mode !== "incremental_7d") {
    throw new Error("Unsupported Shopify evidence mode");
  }
  const inclusiveDays = input.mode === "initial_90d" ? 90 : 7;
  const anchor = parseStoreDay(input.anchorStoreDay);
  return inclusiveStoreDaysToHalfOpenUtc({
    dateFrom: formatStoreDay(addCalendarDays(anchor, -(inclusiveDays - 1))),
    dateTo: input.anchorStoreDay,
    timeZone: input.timeZone,
  });
}
