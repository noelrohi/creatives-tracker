import { z } from "zod";
import { KlaviyoReadError, type KlaviyoReadRequester } from "./read-transport";
import {
  klaviyoCampaignValueRecordSchema as rowSchema,
} from "./record-contracts";

// Revision 2026-07-15: request statistics/groupings, ignored timeframe offsets,
// one-year maximum, and page_cursor input (but no documented next cursor):
// https://developers.klaviyo.com/en/v2026-07-15/reference/query_campaign_values
// End rounds through the current local hour; these are send-date reports, not
// event-time revenue. Subtracting a second at whole-second exclusive boundaries
// follows the guide's recommendation to send the last second of the desired hour:
// https://developers.klaviyo.com/en/reference/reporting_api_overview
// No live-account pagination or DST-fold semantics have been certified.
const MAX_ROWS = 10_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const instant = z.string().max(64).datetime({ offset: true });
const identifier = z.string().min(1).max(256);
const wallTime = z.string().max(64);

const statistics = {
  recipients: "recipients",
  delivered: "delivered",
  deliveryRate: "delivery_rate",
  opensUnique: "opens_unique",
  openRate: "open_rate",
  clicksUnique: "clicks_unique",
  clickRate: "click_rate",
  conversions: "conversions",
  conversionRate: "conversion_rate",
  conversionValue: "conversion_value",
  revenuePerRecipient: "revenue_per_recipient",
  bounced: "bounced",
  bounceRate: "bounce_rate",
  unsubscribes: "unsubscribes",
  unsubscribeRate: "unsubscribe_rate",
  spamComplaints: "spam_complaints",
  spamComplaintRate: "spam_complaint_rate",
} as const;

// Deliberately no continuation until the provider documents how to obtain one.
// Strict input prevents silently ignoring a caller's attempted continuation.
export const campaignValuesInputSchema = z.object({
  conversionMetricId: z.string().min(1).max(256).regex(/^[A-Za-z0-9]+$/),
  since: instant,
  until: instant,
}).strict().refine(({ since, until }) => {
  const span = Date.parse(until) - Date.parse(since);
  return span > 0 && span <= YEAR_MS;
}, { message: "Window must be positive and at most 365 days" });

export const campaignValuesOutputSchema = z.object({
  rows: z.array(rowSchema).max(MAX_ROWS),
  nextContinuation: z.string().max(8192).nullable(),
  requestedWindow: z.object({ since: instant, until: instant }).strict(),
  providerWindow: z.object({ start: wallTime, end: wallTime }).strict(),
  accountTimezone: z.string().min(1).max(128),
  completeness: z.enum(["unverified", "more_available", "complete"]),
  warnings: z.array(z.string().max(512)).max(16),
  providerTimeSemantics: z.literal("account_local_offset_ignored"),
  effectiveWindowPrecision: z.literal("unverified"),
  providerRoundedEnd: wallTime,
}).strict();

const responseSchema = z.object({
  data: z.object({
    type: z.literal("campaign-values-report"),
    attributes: z.object({ results: z.array(z.unknown()) }),
  }),
  links: z.object({ next: z.unknown().optional() }).optional(),
  meta: z.object({
    next_cursor: z.unknown().optional(),
    page_cursor: z.unknown().optional(),
  }).optional(),
});
const resultSchema = z.object({
  groupings: z.object({
    campaign_id: identifier,
    campaign_message_id: identifier,
    send_channel: identifier,
  }),
  // ecomconn uses object(result.statistics) ?? {}, including for null or
  // non-object containers. Invalid individual measures still fail validation.
  statistics: z.preprocess(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {},
    z.record(z.string(), z.unknown()),
  ),
});

function localFormatter(timeZone: string) {
  try {
    if (!timeZone || timeZone.length > 128 || /^[+-]/.test(timeZone)) {
      throw new Error();
    }
    return new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
  } catch {
    throw new KlaviyoReadError("invalid_input");
  }
}

function localTime(formatter: Intl.DateTimeFormat, ms: number): string {
  const parts = formatter.formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  const fraction = ms % 1000 ? `.${String(ms % 1000).padStart(3, "0")}` : "";
  // The Z is required date-time syntax, NOT UTC: provider ignores the offset.
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${fraction}Z`;
}

export async function readCampaignValues(
  client: KlaviyoReadRequester,
  scope: { organizationId: string; connectionId: string; accountTimezone: string },
  input: z.infer<typeof campaignValuesInputSchema>,
  now: Date = new Date(),
): Promise<z.infer<typeof campaignValuesOutputSchema>> {
  const parsed = campaignValuesInputSchema.safeParse(input);
  if (!parsed.success) throw new KlaviyoReadError("invalid_input");
  const { since, until, conversionMetricId } = parsed.data;
  const startMs = Date.parse(since);
  const endMs = Date.parse(until);
  if (!Number.isFinite(now.getTime()) || endMs > now.getTime() || startMs < now.getTime() - YEAR_MS) {
    throw new KlaviyoReadError("invalid_input");
  }
  const formatter = localFormatter(scope.accountTimezone);
  // For fractional edges use the preceding whole second, not blindly -1s:
  // 01:00:00.500 must still include the 01:00 hour. For subsecond windows
  // clamp to start so the submitted local timeframe does not reverse.
  const reportEndMs = Math.max(startMs, Math.ceil(endMs / 1000) * 1000 - 1000);
  const providerWindow = {
    start: localTime(formatter, startMs),
    end: localTime(formatter, reportEndMs),
  };
  // A fall-back fold can reverse local wall times despite a positive instant
  // window. The provider ignores offsets, so it cannot express that request.
  if (Date.parse(providerWindow.end) < Date.parse(providerWindow.start)) {
    throw new KlaviyoReadError("invalid_input");
  }
  const warnings = [
    "Pagination is unverified: page_cursor is accepted but no next-cursor response field is documented; null continuation does not establish completeness.",
    "Provider times are account-local wall clocks; their Z suffix is not UTC. End rounds through its local hour; exact instant filtering and DST-fold interpretation are unverified.",
    "Statistics are send-date campaign performance, not event-time or Shopify revenue.",
  ];
  if (startMs % 1000 || endMs % 1000 || /\.\d{4,}/.test(since + until)) {
    warnings.push("Subsecond boundaries cannot be represented exactly by the provider's hourly end rounding; fractional instants are interpreted at JavaScript millisecond precision.");
  }
  let raw: unknown;
  try {
    // One requester call: this reader never retries, partitions or paginates.
    // Requester owns bounded transport retries, revision pinning, byte limits,
    // timeout and credential scope.
    raw = await client.request({
      resource: "campaignValues",
      body: { data: { type: "campaign-values-report", attributes: {
        statistics: Object.values(statistics),
        timeframe: providerWindow,
        conversion_metric_id: conversionMetricId,
        group_by: ["campaign_id", "campaign_message_id", "send_channel"],
      } } },
    });
  } catch (error) {
    if (error instanceof KlaviyoReadError) throw error;
    throw new KlaviyoReadError("unavailable");
  }
  const response = responseSchema.safeParse(raw);
  if (!response.success) throw new KlaviyoReadError("invalid_response");
  const results = response.data.data.attributes.results;
  if (results.length > MAX_ROWS) throw new KlaviyoReadError("limit_exceeded");
  const hasNext = [response.data.links?.next, response.data.meta?.next_cursor, response.data.meta?.page_cursor]
    .some((value) => value !== undefined && value !== null && value !== "");
  if (hasNext) warnings.push("Provider indicated possible additional data using undocumented pagination metadata; it cannot be followed safely by this reader.");
  if (results.length === MAX_ROWS) warnings.push("Response reached the 10000-row safety limit; additional rows may exist. No rows were discarded.");
  let missingStatistics = false;
  const rows = results.map((result) => {
    const parsedResult = resultSchema.safeParse(result);
    if (!parsedResult.success) throw new KlaviyoReadError("invalid_response");
    const { groupings, statistics: values } = parsedResult.data;
    const projected = Object.fromEntries(Object.entries(statistics).map(([name, providerName]) => {
      if (values[providerName] === undefined) missingStatistics = true;
      return [name, values[providerName] ?? null];
    }));
    const row = rowSchema.safeParse({
      ...projected,
      campaignId: groupings.campaign_id,
      campaignMessageId: groupings.campaign_message_id,
      sendChannel: groupings.send_channel,
      conversionMetricId,
      timeframeStart: providerWindow.start,
      timeframeEnd: providerWindow.end,
    });
    if (!row.success) throw new KlaviyoReadError("invalid_response");
    return row.data;
  });
  if (missingStatistics) warnings.push("Some requested statistics were absent and are represented as null, not zero.");
  return campaignValuesOutputSchema.parse({
    rows, nextContinuation: null, requestedWindow: { since, until }, providerWindow,
    accountTimezone: scope.accountTimezone,
    completeness: hasNext ? "more_available" : "unverified",
    warnings,
    providerTimeSemantics: "account_local_offset_ignored",
    effectiveWindowPrecision: "unverified",
    providerRoundedEnd: providerWindow.end.replace(/:\d{2}:\d{2}(?:\.\d+)?Z$/, ":59:59Z"),
  });
}
