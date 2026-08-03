import {
  inclusiveStoreDaysToHalfOpenUtc,
  type HalfOpenWindow,
} from "@/lib/evidence-window";

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
  const candidate = value as Partial<OrderCoreSourceContract> | null;
  if (
    candidate?.sourceMode !== "order_core" ||
    JSON.stringify(candidate.metricKinds) !==
      JSON.stringify(KLAVIYO_ORDER_CORE_KINDS)
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

export type KlaviyoEventCheckpoint = OrderCoreSourceContract & {
  metricIndex: number;
  cursor: string | null;
  page: number;
};

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
};

export function initialEventCheckpoint(): KlaviyoEventCheckpoint {
  return {
    ...orderCoreSourceContract(),
    metricIndex: 0,
    cursor: null,
    page: 0,
  };
}
