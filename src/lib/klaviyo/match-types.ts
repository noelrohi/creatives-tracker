/**
 * Fixed Plan 3 advisory-matching contracts. Schema, matcher, repository,
 * queries, and later plans import these unions from here; they are never
 * redeclared as inline string unions elsewhere.
 */

export type OrderMatchStatus =
  | "confirmed"
  | "candidate"
  | "ambiguous"
  | "no_klaviyo_event"
  | "duplicate_conversion_events";

// API/read-model only. `not_evaluated` is never stored in a match-result row.
export type OrderEvidenceStatus = OrderMatchStatus | "not_evaluated";

export type EventMatchStatus =
  | "confirmed"
  | "candidate"
  | "ambiguous"
  | "unmatched";

// API/read-model only. Missing current event result after incident-edge closure.
export type EventEvidenceStatus = EventMatchStatus | "not_evaluated";

export type ProductMatchStatus =
  | "exact"
  | "partial"
  | "contradictory"
  | "unavailable";

export const MATCHER_VERSION = "klaviyo-v1" as const;
export const DIAGNOSTIC_MIN_SCORE = 5;
export const DIAGNOSTIC_MAX_SCORE = 11;
export const DIAGNOSTIC_MAX_DISTANCE_MS = 24 * 60 * 60 * 1000;

export const ORDER_MATCH_STATUSES = [
  "confirmed",
  "candidate",
  "ambiguous",
  "no_klaviyo_event",
  "duplicate_conversion_events",
] as const satisfies readonly OrderMatchStatus[];

export const EVENT_MATCH_STATUSES = [
  "confirmed",
  "candidate",
  "ambiguous",
  "unmatched",
] as const satisfies readonly EventMatchStatus[];

export const PRODUCT_MATCH_STATUSES = [
  "exact",
  "partial",
  "contradictory",
  "unavailable",
] as const satisfies readonly ProductMatchStatus[];

export type MatchCandidateClass = "deterministic" | "diagnostic";

export type MatchRunStatus = "published" | "failed";

export type ResultSupersessionReason =
  | "entity_replaced"
  | "incident_edge_boundary"
  | "rotation_key_retired"
  | "privacy_erasure";

export const RESULT_SUPERSESSION_REASONS = [
  "entity_replaced",
  "incident_edge_boundary",
  "rotation_key_retired",
  "privacy_erasure",
] as const satisfies readonly ResultSupersessionReason[];

export type IdentityRotationState =
  | "preparing"
  | "dual_write"
  | "republishing"
  | "pruning"
  | "complete"
  | "failed"
  | "aborted";

export type IdentityRotationSourceStatus =
  | "pending"
  | "complete"
  | "unavailable"
  | "suppressed"
  | "released";

export type IdentityRotationAttemptStage =
  | "refreshing_shopify_evidence"
  | "refreshing_order_core"
  | "matching"
  | "published"
  | "stale";

export type IdentityWriteMode = "current_only" | "dual";
