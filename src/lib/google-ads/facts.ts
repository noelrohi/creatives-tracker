import "server-only";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type NormalizedCampaignFact = {
  campaignId: string;
  campaignName: string;
  campaignStatus: string | null;
  channelType: string | null;
  factDate: string;
  costMicros: number;
  impressions: number;
  clicks: number;
  /** Kept as strings for numeric columns; Google reports fractional conversions. */
  conversions: string;
  conversionsValue: string;
};

export function assertDay(value: string): string {
  if (!DAY_PATTERN.test(value)) {
    throw new Error("Google Ads window day must be YYYY-MM-DD");
  }
  return value;
}

/** YYYY-MM-DD for an instant in the given IANA timezone. */
export function accountDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function addDays(day: string, delta: number): string {
  assertDay(day);
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, dayOfMonth + delta));
  return utc.toISOString().slice(0, 10);
}

export function buildCampaignFactsQuery(fromDay: string, toDay: string): string {
  assertDay(fromDay);
  assertDay(toDay);
  return (
    "SELECT campaign.id, campaign.name, campaign.status, " +
    "campaign.advertising_channel_type, segments.date, metrics.cost_micros, " +
    "metrics.impressions, metrics.clicks, metrics.conversions, " +
    "metrics.conversions_value FROM campaign " +
    `WHERE segments.date BETWEEN '${fromDay}' AND '${toDay}' ` +
    "ORDER BY segments.date"
  );
}

export function buildCustomerQuery(): string {
  return (
    "SELECT customer.id, customer.descriptive_name, customer.currency_code, " +
    "customer.time_zone, customer.manager FROM customer"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** REST returns Int64 metrics as strings and doubles as numbers; absent means zero. */
function countMetric(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  const parsed =
    typeof value === "string" && /^-?\d+$/.test(value)
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
}

/** Plain non-negative decimal, e.g. "1.5" or "0" — rejects hex/octal/binary/signed forms. */
const PLAIN_DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

function decimalMetric(value: unknown): string | null {
  if (value === undefined || value === null) return "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value === "string" && PLAIN_DECIMAL_PATTERN.test(value)) {
    return String(Number(value));
  }
  return null;
}

/** Returns null for rows this pilot cannot represent; callers count them as failures. */
export function normalizeCampaignFactRow(
  row: Record<string, unknown>,
): NormalizedCampaignFact | null {
  if (!isRecord(row)) return null;
  const campaign = isRecord(row.campaign) ? row.campaign : null;
  const segments = isRecord(row.segments) ? row.segments : null;
  const metrics = isRecord(row.metrics) ? row.metrics : {};

  const campaignId =
    campaign && (typeof campaign.id === "string" || typeof campaign.id === "number")
      ? String(campaign.id)
      : null;
  const factDate =
    segments && typeof segments.date === "string" && DAY_PATTERN.test(segments.date)
      ? segments.date
      : null;
  if (!campaignId || !factDate) return null;

  const costMicros = countMetric(metrics.costMicros);
  const impressions = countMetric(metrics.impressions);
  const clicks = countMetric(metrics.clicks);
  const conversions = decimalMetric(metrics.conversions);
  const conversionsValue = decimalMetric(metrics.conversionsValue);
  if (
    costMicros === null ||
    impressions === null ||
    clicks === null ||
    conversions === null ||
    conversionsValue === null
  ) {
    return null;
  }

  return {
    campaignId,
    campaignName:
      campaign && typeof campaign.name === "string" && campaign.name.length > 0
        ? campaign.name
        : campaignId,
    campaignStatus:
      campaign && typeof campaign.status === "string" ? campaign.status : null,
    channelType:
      campaign && typeof campaign.advertisingChannelType === "string"
        ? campaign.advertisingChannelType
        : null,
    factDate,
    costMicros,
    impressions,
    clicks,
    conversions,
    conversionsValue,
  };
}
