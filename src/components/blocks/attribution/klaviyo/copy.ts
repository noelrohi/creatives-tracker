export const LAB_VIEWS = ["orders", "unmatched", "reports", "probe"] as const;
export const LAB_RANGES = ["last7", "last30", "last90", "custom"] as const;
export const ORDER_STATUS_FILTERS = [
  "all",
  "confirmed",
  "candidate",
  "ambiguous",
  "no_klaviyo_event",
  "duplicate_conversion_events",
  "not_evaluated",
] as const;
export const PRODUCT_STATUS_FILTERS = [
  "all",
  "exact",
  "partial",
  "contradictory",
  "unavailable",
] as const;
export const CLAIM_TYPE_FILTERS = [
  "all",
  "campaign",
  "flow",
  "message",
  "interaction",
  "none",
] as const;
export const CHANNEL_FILTERS = ["all", "email", "sms", "onsite", "unknown"] as const;
export const DETAIL_TABS = [
  "explanation",
  "products",
  "journey",
  "claims",
  "inspector",
] as const;
export const JOURNEY_LOOKBACKS = [7, 30, 90] as const;
export const REPORT_KINDS = ["campaign", "flow"] as const;

export type LabView = (typeof LAB_VIEWS)[number];
export type LabRange = (typeof LAB_RANGES)[number];
export type OrderStatusFilter = (typeof ORDER_STATUS_FILTERS)[number];
export type ProductStatusFilter = (typeof PRODUCT_STATUS_FILTERS)[number];
export type ClaimTypeFilter = (typeof CLAIM_TYPE_FILTERS)[number];
export type ChannelFilter = (typeof CHANNEL_FILTERS)[number];
export type DetailTab = (typeof DETAIL_TABS)[number];
export type JourneyLookback = (typeof JOURNEY_LOOKBACKS)[number];
export type ReportKind = (typeof REPORT_KINDS)[number];

export const ADVISORY_BANNER =
  "Advisory evidence only — production attribution stays unchanged.";

export const ORDER_STATUS_LABELS: Record<OrderStatusFilter, string> = {
  all: "All orders",
  confirmed: "Confirmed",
  candidate: "Candidate",
  ambiguous: "Ambiguous",
  no_klaviyo_event: "No Klaviyo event",
  duplicate_conversion_events: "Duplicate conversions",
  not_evaluated: "Not evaluated",
};

export const EVENT_STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  candidate: "Candidate",
  ambiguous: "Ambiguous",
  unmatched: "Unmatched",
  not_evaluated: "Not evaluated",
};
