import { createHash } from "node:crypto";
import type { JsonValue } from "@/lib/klaviyo/types";

export const KLAVIYO_REPORT_FRESHNESS_MS = 24 * 60 * 60 * 1000;
export const KLAVIYO_REPORT_MIN_INTERVAL_MS = 1_100;

export const KLAVIYO_REPORT_KINDS = ["campaign", "flow"] as const;
export type KlaviyoReportKind = (typeof KLAVIYO_REPORT_KINDS)[number];

// Wire names pinned to the 2026-07-15 reporting revision: the provider
// uses suffix form (clicks_unique), verified against the live endpoint.
export const KLAVIYO_REPORT_STATISTICS = [
  "conversions",
  "conversion_value",
  "recipients",
  "clicks_unique",
  "opens_unique",
] as const;
export type KlaviyoReportStatistic = (typeof KLAVIYO_REPORT_STATISTICS)[number];

/**
 * Closed grouping union supported by the pinned campaign/flow endpoints and
 * approved probe. Arbitrary browser or provider strings are rejected.
 */
export const KLAVIYO_REPORT_GROUPINGS = [
  "send_date",
  "campaign_id",
  "flow_id",
  "send_channel",
] as const;
export type KlaviyoReportGrouping = (typeof KLAVIYO_REPORT_GROUPINGS)[number];

export type KlaviyoReportRequest = {
  connectionId: string;
  kind: KlaviyoReportKind;
  conversionMetricRowId: string;
  conversionExternalMetricId: string;
  timeframe: { from: string; to: string };
  statistics: KlaviyoReportStatistic[];
  grouping: KlaviyoReportGrouping[];
  apiRevision: string;
  asOf: string;
};

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function assertExactReportRequest(
  value: unknown,
): asserts value is KlaviyoReportRequest {
  const request = value as Partial<KlaviyoReportRequest> | null;
  if (
    !request ||
    typeof request.connectionId !== "string" ||
    !KLAVIYO_REPORT_KINDS.includes(request.kind as KlaviyoReportKind) ||
    typeof request.conversionMetricRowId !== "string" ||
    typeof request.conversionExternalMetricId !== "string" ||
    request.conversionMetricRowId.length === 0 ||
    request.conversionExternalMetricId.length === 0 ||
    !request.timeframe ||
    !isIsoInstant(request.timeframe.from) ||
    !isIsoInstant(request.timeframe.to) ||
    Date.parse(request.timeframe.from) >= Date.parse(request.timeframe.to) ||
    !Array.isArray(request.statistics) ||
    request.statistics.length === 0 ||
    request.statistics.some(
      (statistic) =>
        !KLAVIYO_REPORT_STATISTICS.includes(statistic as KlaviyoReportStatistic),
    ) ||
    !Array.isArray(request.grouping) ||
    request.grouping.some(
      (grouping) =>
        !KLAVIYO_REPORT_GROUPINGS.includes(grouping as KlaviyoReportGrouping),
    ) ||
    typeof request.apiRevision !== "string" ||
    !isIsoInstant(request.asOf)
  ) {
    throw new Error("Klaviyo report request is invalid");
  }
}

function stableHash(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return input ?? null;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

/**
 * The logical current-slot identity: kind, range, provider conversion
 * metric, statistics, grouping, revision, and account timezone — but never
 * the refresh `asOf` or any internal row ID, and never the internal metric
 * row ID substituted for the external one.
 */
export function publicationScopeFingerprint(
  request: KlaviyoReportRequest,
  accountTimezone: string,
): string {
  return stableHash({
    kind: request.kind,
    timeframe: request.timeframe,
    conversionExternalMetricId: request.conversionExternalMetricId,
    statistics: [...request.statistics].sort(),
    grouping: [...request.grouping].sort(),
    apiRevision: request.apiRevision,
    accountTimezone,
  });
}

export function refreshFingerprint(
  request: KlaviyoReportRequest,
  accountTimezone: string,
): string {
  return stableHash({
    scope: publicationScopeFingerprint(request, accountTimezone),
    asOf: request.asOf,
  });
}

export function refreshSetFingerprint(
  refreshFingerprints: readonly string[],
): string {
  return stableHash([...refreshFingerprints].sort());
}

export type NormalizedReportFact = {
  reportKind: KlaviyoReportKind;
  campaignExternalId: string | null;
  flowExternalId: string | null;
  messageExternalId: string | null;
  grouping: Record<string, JsonValue>;
  statistics: {
    conversions: string | null;
    conversionValue: string | null;
    recipients: string | null;
    uniqueClicks: string | null;
    uniqueOpens: string | null;
  };
  additionalStatistics: Record<string, JsonValue>;
  factFingerprint: string;
};

const STATISTIC_COLUMN_BY_KEY: Record<
  KlaviyoReportStatistic,
  keyof NormalizedReportFact["statistics"]
> = {
  conversions: "conversions",
  conversion_value: "conversionValue",
  recipients: "recipients",
  clicks_unique: "uniqueClicks",
  opens_unique: "uniqueOpens",
};

const MAX_ADDITIONAL_STATISTICS = 16;

function numericString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    !Number.isNaN(Number(value))
  ) {
    return value.trim();
  }
  return null;
}

/**
 * Normalize one report result row fail-closed: typed core statistics,
 * bounded allowlisted extras, and unknown statistics dropped but recorded
 * in the fact fingerprint so replay stays deterministic. Klaviyo's account
 * timezone and send-date semantics are preserved verbatim in the grouping
 * — report code never looks up a Shopify order or event.
 */
export function normalizeReportRows(input: {
  kind: KlaviyoReportKind;
  requestFingerprint: string;
  rows: Array<Record<string, unknown>>;
}): { facts: NormalizedReportFact[]; warnings: string[] } {
  const warnings: string[] = [];
  const facts: NormalizedReportFact[] = [];
  for (const row of input.rows) {
    const groupings =
      row.groupings && typeof row.groupings === "object"
        ? (row.groupings as Record<string, unknown>)
        : {};
    const statisticsSource =
      row.statistics && typeof row.statistics === "object"
        ? (row.statistics as Record<string, unknown>)
        : {};

    const statistics: NormalizedReportFact["statistics"] = {
      conversions: null,
      conversionValue: null,
      recipients: null,
      uniqueClicks: null,
      uniqueOpens: null,
    };
    const additionalStatistics: Record<string, JsonValue> = {};
    for (const [key, rawValue] of Object.entries(statisticsSource)) {
      const numeric = numericString(rawValue);
      if (
        KLAVIYO_REPORT_STATISTICS.includes(key as KlaviyoReportStatistic)
      ) {
        if (numeric === null && rawValue !== null && rawValue !== undefined) {
          warnings.push("report_statistic_malformed");
          continue;
        }
        statistics[STATISTIC_COLUMN_BY_KEY[key as KlaviyoReportStatistic]] =
          numeric;
        continue;
      }
      if (numeric !== null) {
        if (Object.keys(additionalStatistics).length < MAX_ADDITIONAL_STATISTICS) {
          additionalStatistics[key] = numeric;
        } else {
          warnings.push("report_statistic_overflow");
        }
        continue;
      }
      warnings.push("report_statistic_dropped");
    }

    const campaignId =
      typeof groupings.campaign_id === "string" ? groupings.campaign_id : null;
    const flowId =
      typeof groupings.flow_id === "string" ? groupings.flow_id : null;
    const messageId =
      typeof groupings.campaign_message_id === "string"
        ? groupings.campaign_message_id
        : typeof groupings.flow_message_id === "string"
          ? groupings.flow_message_id
          : null;
    const grouping: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(groupings)) {
      if (typeof value === "string" || typeof value === "number") {
        grouping[key] = value;
      }
    }

    const fact: NormalizedReportFact = {
      reportKind: input.kind,
      campaignExternalId: input.kind === "campaign" ? campaignId : null,
      flowExternalId: input.kind === "flow" ? flowId : null,
      messageExternalId: messageId,
      grouping,
      statistics,
      additionalStatistics,
      factFingerprint: "",
    };
    fact.factFingerprint = stableHash({
      requestFingerprint: input.requestFingerprint,
      kind: input.kind,
      grouping,
      statistics,
      additionalStatistics,
    });
    facts.push(fact);
  }
  return { facts, warnings };
}
