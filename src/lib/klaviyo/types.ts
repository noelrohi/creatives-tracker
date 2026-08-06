import {
  inclusiveStoreDaysToHalfOpenUtc,
  type HalfOpenWindow,
} from "@/lib/evidence-window";
import type {
  ErasureSuppressionDigest,
  VersionedIdentityDigest,
} from "@/lib/identity-hmac";

export { inclusiveStoreDaysToHalfOpenUtc };
export type { HalfOpenWindow };

export const KLAVIYO_ORDER_CORE_KINDS = [
  "placed_order",
  "ordered_product",
] as const;

export const KLAVIYO_ALLOWED_METRIC_KINDS = [
  ...KLAVIYO_ORDER_CORE_KINDS,
  "clicked_email",
  "clicked_sms",
  "active_on_site",
  "viewed_product",
  "added_to_cart",
  "checkout_started",
] as const;

export type KlaviyoMetricKind =
  (typeof KLAVIYO_ALLOWED_METRIC_KINDS)[number];

export const KLAVIYO_EVENT_ALIAS_FIELDS = [
  "orderId",
  "uniqueEventId",
  "productId",
  "variantId",
  "sku",
  "productName",
  "variantName",
  "quantity",
  "value",
  "currency",
  "items",
] as const;

export type KlaviyoEventAliasField =
  (typeof KLAVIYO_EVENT_ALIAS_FIELDS)[number];

export type KlaviyoEventAliasRegistry = Record<
  KlaviyoEventAliasField,
  string | null
>;

export type OrderCoreSourceContract = {
  sourceMode: "order_core";
  metricKinds: ["placed_order", "ordered_product"];
};

export function orderCoreSourceContract(): OrderCoreSourceContract {
  return {
    sourceMode: "order_core",
    metricKinds: ["placed_order", "ordered_product"],
  };
}

export function assertOrderCoreSourceContract(
  value: unknown,
): asserts value is OrderCoreSourceContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Klaviyo event run has an invalid source contract");
  }
  const candidate = value as {
    sourceMode?: unknown;
    metricKinds?: unknown;
  };
  const metricKinds = candidate.metricKinds;
  if (
    candidate.sourceMode !== "order_core" ||
    !Array.isArray(metricKinds) ||
    metricKinds.length !== 2 ||
    metricKinds[0] !== "placed_order" ||
    metricKinds[1] !== "ordered_product"
  ) {
    throw new Error("Klaviyo event run has an invalid source contract");
  }
}

export function assertExactOrderCoreRequestParameters(
  value: unknown,
): asserts value is OrderCoreSourceContract {
  assertOrderCoreSourceContract(value);
  if (
    JSON.stringify(Object.keys(value as object).sort()) !==
    JSON.stringify(["metricKinds", "sourceMode"])
  ) {
    throw new Error(
      "Klaviyo event run request parameters are not immutable order core",
    );
  }
}

export const KLAVIYO_JOURNEY_KINDS = [
  "clicked_email",
  "clicked_sms",
  "active_on_site",
  "viewed_product",
  "added_to_cart",
  "checkout_started",
] as const;

export type JourneySourceContract = {
  sourceMode: "journey";
  metricKinds: [
    "clicked_email",
    "clicked_sms",
    "active_on_site",
    "viewed_product",
    "added_to_cart",
    "checkout_started",
  ];
};

/**
 * Closed event-source union: resume can never reinterpret a journey metric
 * index as order core or vice versa, and the canonical tuple is never
 * shortened or reordered.
 */
export type KlaviyoEventSourceContract =
  | OrderCoreSourceContract
  | JourneySourceContract;

export type KlaviyoEventRunParameters = KlaviyoEventSourceContract;

export function journeySourceContract(): JourneySourceContract {
  return {
    sourceMode: "journey",
    metricKinds: [...KLAVIYO_JOURNEY_KINDS] as JourneySourceContract["metricKinds"],
  };
}

export function assertJourneySourceContract(
  value: unknown,
): asserts value is JourneySourceContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Klaviyo event run has an invalid source contract");
  }
  const candidate = value as { sourceMode?: unknown; metricKinds?: unknown };
  const metricKinds = candidate.metricKinds;
  if (
    candidate.sourceMode !== "journey" ||
    !Array.isArray(metricKinds) ||
    metricKinds.length !== KLAVIYO_JOURNEY_KINDS.length ||
    metricKinds.some((kind, index) => kind !== KLAVIYO_JOURNEY_KINDS[index])
  ) {
    throw new Error("Klaviyo event run has an invalid source contract");
  }
}

export function assertExactEventSourceContract(
  value: unknown,
): asserts value is KlaviyoEventSourceContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Klaviyo event run has an invalid source contract");
  }
  const sourceMode = (value as { sourceMode?: unknown }).sourceMode;
  if (sourceMode === "order_core") {
    assertOrderCoreSourceContract(value);
  } else if (sourceMode === "journey") {
    assertJourneySourceContract(value);
  } else {
    throw new Error("Klaviyo event run has an invalid source contract");
  }
  if (
    JSON.stringify(Object.keys(value as object).sort()) !==
    JSON.stringify(["metricKinds", "sourceMode"])
  ) {
    throw new Error(
      "Klaviyo event run request parameters are not an immutable source contract",
    );
  }
}

export type EnabledOrderCoreMetric = {
  metricRowId: string;
  externalMetricId: string;
  metricKind: (typeof KLAVIYO_ORDER_CORE_KINDS)[number];
  approvedAliases: KlaviyoEventAliasRegistry;
};

export type KlaviyoConnectionScope = {
  organizationId: string;
  storeId: string;
  connectionId: string;
};

export function assertHalfOpenWindow(window: HalfOpenWindow): void {
  if (
    Number.isNaN(window.from.getTime()) ||
    Number.isNaN(window.to.getTime())
  ) {
    throw new Error("Klaviyo window must contain valid dates");
  }
  if (window.from.getTime() >= window.to.getTime()) {
    throw new Error("Klaviyo window from must be before to");
  }
}

export type KlaviyoEventCheckpoint = KlaviyoEventSourceContract & {
  metricIndex: number;
  cursor: string | null;
  page: number;
};

export const KLAVIYO_DIMENSION_STAGES = [
  "campaigns_email",
  "campaigns_sms",
  "campaign_messages",
  "flows",
  "flow_messages",
  "tracking_account",
] as const;

export type KlaviyoDimensionStage = (typeof KLAVIYO_DIMENSION_STAGES)[number];

/**
 * Durable dimension traversal position. `parentExternalId` is the provider
 * campaign/flow currently being expanded; resume re-expands that one
 * parent idempotently rather than persisting nested provider cursors.
 */
export type KlaviyoDimensionCheckpoint = {
  operation: "dimensions";
  stage: KlaviyoDimensionStage;
  parentExternalId: string | null;
  cursor: string | null;
  page: number;
};

export function assertExactDimensionCheckpoint(
  value: unknown,
): asserts value is KlaviyoDimensionCheckpoint {
  const checkpoint = value as Record<string, unknown> | null;
  if (
    !checkpoint ||
    checkpoint.operation !== "dimensions" ||
    !KLAVIYO_DIMENSION_STAGES.includes(
      checkpoint.stage as KlaviyoDimensionStage,
    ) ||
    (checkpoint.parentExternalId !== null &&
      typeof checkpoint.parentExternalId !== "string") ||
    (checkpoint.cursor !== null && typeof checkpoint.cursor !== "string") ||
    typeof checkpoint.page !== "number" ||
    !Number.isInteger(checkpoint.page) ||
    checkpoint.page < 0 ||
    Object.keys(checkpoint).length !== 5
  ) {
    throw new Error("Klaviyo dimension checkpoint is malformed");
  }
}

export type KlaviyoReportSyncCheckpoint = {
  operation: "reports";
  kindIndex: number;
  cursor: string | null;
  page: number;
};

export function assertExactReportSyncCheckpoint(
  value: unknown,
): asserts value is KlaviyoReportSyncCheckpoint {
  const checkpoint = value as Record<string, unknown> | null;
  if (
    !checkpoint ||
    checkpoint.operation !== "reports" ||
    !Number.isInteger(checkpoint.kindIndex) ||
    (checkpoint.kindIndex as number) < 0 ||
    (checkpoint.cursor !== null && typeof checkpoint.cursor !== "string") ||
    !Number.isInteger(checkpoint.page) ||
    (checkpoint.page as number) < 0 ||
    Object.keys(checkpoint).length !== 4
  ) {
    throw new Error("Klaviyo report checkpoint is malformed");
  }
}

export type KlaviyoSyncRunCheckpoint =
  | KlaviyoEventCheckpoint
  | KlaviyoDimensionCheckpoint
  | KlaviyoReportSyncCheckpoint;

export type ProductEvidenceCompleteness =
  | "complete"
  | "incomplete"
  | "unavailable";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonType =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "null";

export type PropertyFingerprintEntry = {
  key: string;
  keyKind: "approved" | "sha256";
  type: JsonType;
};

export type RedactedProbeExample = {
  metricKind: (typeof KLAVIYO_ORDER_CORE_KINDS)[number];
  occurredOnUtc: string;
  fingerprint: PropertyFingerprintEntry[];
  warnings: string[];
};

export type RedactedEventEvidence = {
  values: Record<string, JsonValue>;
  fingerprint: PropertyFingerprintEntry[];
  warnings: string[];
  truncated: boolean;
};

export type NormalizedKlaviyoProduct = {
  sourceOrdinal: number;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  productName: string | null;
  variantName: string | null;
  quantity: number | null;
};

export type NormalizedKlaviyoEvent = {
  externalEventId: string;
  eventUuid: string | null;
  metricId: string;
  metricKind: KlaviyoMetricKind;
  occurredAt: Date;
  profileId: string | null;
  explicitOrderIdCandidate: string | null;
  providerUniqueIdCandidate: string | null;
  providerValue: string | null;
  providerCurrency: string | null;
  attributionRelationshipIds: string[];
  evidence: RedactedEventEvidence;
  products: NormalizedKlaviyoProduct[];
  productEvidenceCompleteness: ProductEvidenceCompleteness;
  sourceChecksum: string;
  apiRevision: string;
  /**
   * Versioned tenant-derived matching digests (Plan 3). Never part of the
   * identity-free sourceChecksum.
   */
  identityDigests: VersionedIdentityDigest[];
  /** Domain-separated erasure-suppression HMAC candidates (email + profile). */
  erasureSuppressionCandidates: ErasureSuppressionDigest[];
};

export function initialEventCheckpoint(): KlaviyoEventCheckpoint {
  return {
    ...orderCoreSourceContract(),
    metricIndex: 0,
    cursor: null,
    page: 0,
  };
}
