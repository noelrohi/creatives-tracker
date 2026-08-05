import { createHash } from "node:crypto";
import {
  computeErasureSuppressionDigests,
  computeIdentityDigests,
  type ErasureSuppressionDigest,
  type ErasureSuppressionKey,
  type IdentityHmacKeyring,
  type IdentityScope,
  type VersionedIdentityDigest,
} from "@/lib/identity-hmac";
import type { KlaviyoCompoundPage, KlaviyoResource } from "@/lib/klaviyo/client";
import {
  KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES,
  REDACTED_PROPERTY_MAX_RAW_KEYS,
  isKlaviyoProviderOpaqueId,
  isKlaviyoRawStringWithinBounds,
  redactEventProperties,
  sanitizeKlaviyoSensitiveString,
} from "@/lib/klaviyo/redaction";
import {
  KLAVIYO_ALLOWED_METRIC_KINDS,
  KLAVIYO_EVENT_ALIAS_FIELDS,
  type KlaviyoEventAliasRegistry,
  type KlaviyoMetricKind,
  type NormalizedKlaviyoEvent,
  type NormalizedKlaviyoProduct,
  type ProductEvidenceCompleteness,
} from "@/lib/klaviyo/types";

export type EventAliasRegistry = KlaviyoEventAliasRegistry;

export const NORMALIZED_PRODUCT_MAX_ITEMS = 100;
export const NORMALIZED_ATTRIBUTION_MAX_IDS = 100;
export const KLAVIYO_PRODUCT_ITEM_MAX_RAW_KEYS = 64;
export const KLAVIYO_EVENT_PAGE_MAX_EVENTS = 200;
export const KLAVIYO_EVENT_MAX_NORMALIZED_BYTES = 64 * 1024;
export const KLAVIYO_EVENT_PAGE_MAX_NORMALIZED_BYTES = 256 * 1024;

const ATTRIBUTION_SCAN_MAX_ITEMS = 1_000;
const SOURCE_CHECKSUM_SERIALIZED_OVERHEAD_BYTES = 80;
const MAX_IDENTIFIER_CODE_POINTS = 4_096;
const MAX_SCALAR_CODE_POINTS = 2_048;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const EXACT_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const PRODUCT_FIELDS = [
  "productId",
  "variantId",
  "sku",
  "productName",
  "variantName",
] as const;

function invalidPage(): never {
  throw new Error("Klaviyo event page is invalid");
}

function invalidInput(): never {
  throw new Error("Klaviyo event normalizer input is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePointLength(value: string): number {
  let length = 0;
  for (const character of value) {
    if (character.length > 0) length += 1;
  }
  return length;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseOccurredAt(value: unknown): Date {
  if (typeof value !== "string") invalidPage();
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) invalidPage();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const monthDays = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    invalidPage();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalidPage();
  return new Date(timestamp);
}

function requiredIdentifier(
  value: unknown,
  error: () => never,
  providerOpaque = false,
): string {
  const sanitized =
    typeof value === "string"
      ? sanitizeKlaviyoSensitiveString(value, "identifier")
      : null;
  if (
    sanitized === null ||
    sanitized.trim() === "" ||
    codePointLength(sanitized) > MAX_IDENTIFIER_CODE_POINTS ||
    CONTROL_CHARACTER.test(sanitized) ||
    (providerOpaque && !isKlaviyoProviderOpaqueId(sanitized))
  ) {
    return error();
  }
  return sanitized;
}

function requiredApiRevision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isKlaviyoRawStringWithinBounds(value) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    invalidInput();
  }
  return value;
}

function optionalIdentifier(
  value: unknown,
  warnings: string[],
  warning: string,
  providerOpaque = false,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !isKlaviyoRawStringWithinBounds(value)) {
    invalidPage();
  }
  const sanitized =
    typeof value === "string"
      ? sanitizeKlaviyoSensitiveString(value, "identifier")
      : null;
  if (
    sanitized === null ||
    sanitized.trim() === "" ||
    codePointLength(sanitized) > MAX_IDENTIFIER_CODE_POINTS ||
    CONTROL_CHARACTER.test(sanitized) ||
    (providerOpaque && !isKlaviyoProviderOpaqueId(sanitized))
  ) {
    warnings.push(warning);
    return null;
  }
  return sanitized;
}

function snapshotAliases(value: EventAliasRegistry): EventAliasRegistry {
  const snapshot = {} as EventAliasRegistry;
  const sources = new Set<string>();
  try {
    for (const field of KLAVIYO_EVENT_ALIAS_FIELDS) {
      const source = value[field];
      if (
        source !== null &&
        (typeof source !== "string" ||
          source.length === 0 ||
          !isKlaviyoRawStringWithinBounds(source) ||
          Buffer.byteLength(source, "utf8") >
            KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES ||
          codePointLength(source) > MAX_SCALAR_CODE_POINTS ||
          CONTROL_CHARACTER.test(source) ||
          sanitizeKlaviyoSensitiveString(source, "identifier") === null ||
          sources.has(source))
      ) {
        invalidInput();
      }
      snapshot[field] = source;
      if (source !== null) sources.add(source);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Klaviyo event normalizer input is invalid") {
      throw error;
    }
    invalidInput();
  }
  return snapshot;
}

function snapshotMerchantHosts(value: ReadonlySet<string>): Set<string> {
  let hosts: unknown[];
  try {
    hosts = Array.from(Set.prototype.values.call(value) as Iterable<unknown>);
  } catch {
    invalidInput();
  }
  const snapshot = new Set<string>();
  for (const host of hosts) {
    if (typeof host !== "string") invalidInput();
    const normalized = host.trim().toLowerCase();
    if (!EXACT_HOSTNAME_PATTERN.test(normalized)) invalidInput();
    snapshot.add(normalized);
  }
  return snapshot;
}

function snapshotEventProperties(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalidPage();
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    invalidPage();
  }
  if (keys.length > REDACTED_PROPERTY_MAX_RAW_KEYS) invalidPage();
  for (const key of keys) {
    if (
      key.length > KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES ||
      Buffer.byteLength(key, "utf8") > KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES ||
      CONTROL_CHARACTER.test(key)
    ) {
      invalidPage();
    }
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    try {
      snapshot[key] = value[key];
    } catch {
      invalidPage();
    }
  }
  return snapshot;
}

function scalarText(
  value: unknown,
  kind: "identifier" | "text",
): { present: boolean; valid: boolean; value: string | null } {
  if (value === undefined || value === null) {
    return { present: false, valid: true, value: null };
  }
  let text: string;
  if (typeof value === "string") {
    if (!isKlaviyoRawStringWithinBounds(value)) invalidPage();
    const sanitized = sanitizeKlaviyoSensitiveString(value, kind);
    if (sanitized === null) return { present: true, valid: false, value: null };
    if (kind === "identifier" && sanitized.trim() !== sanitized) {
      return { present: true, valid: false, value: null };
    }
    text = kind === "identifier" ? sanitized : sanitized.trim();
  } else if (typeof value === "number" && Number.isFinite(value)) {
    text = String(value);
  } else {
    return { present: true, valid: false, value: null };
  }
  if (
    text.length === 0 ||
    codePointLength(text) > MAX_SCALAR_CODE_POINTS ||
    CONTROL_CHARACTER.test(text)
  ) {
    return { present: true, valid: false, value: null };
  }
  return { present: true, valid: true, value: text };
}

function numericValue(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  if (!isKlaviyoRawStringWithinBounds(value)) invalidPage();
  const text = value.trim();
  if (
    text.length === 0 ||
    text.length > 128 ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)
  ) {
    return null;
  }
  return text;
}

function currencyValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!isKlaviyoRawStringWithinBounds(value)) invalidPage();
  const text = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : null;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  if (!isKlaviyoRawStringWithinBounds(value)) invalidPage();
  const text = value.trim();
  if (!/^[1-9]\d*$/.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function aliasedValue(
  properties: Record<string, unknown>,
  aliases: EventAliasRegistry,
  field: keyof EventAliasRegistry,
): unknown {
  const source = aliases[field];
  return source === null ? undefined : properties[source];
}

function normalizeProduct(
  properties: Record<string, unknown>,
  aliases: EventAliasRegistry,
  sourceOrdinal: number,
): { present: boolean; valid: boolean; product: NormalizedKlaviyoProduct | null } {
  const productId = scalarText(aliasedValue(properties, aliases, "productId"), "identifier");
  const variantId = scalarText(aliasedValue(properties, aliases, "variantId"), "identifier");
  const sku = scalarText(aliasedValue(properties, aliases, "sku"), "identifier");
  const productName = scalarText(aliasedValue(properties, aliases, "productName"), "text");
  const variantName = scalarText(aliasedValue(properties, aliases, "variantName"), "text");
  const fields = [productId, variantId, sku, productName, variantName];
  const productSourcePresent = PRODUCT_FIELDS.some((field) => {
    const source = aliases[field];
    return source !== null && Object.hasOwn(properties, source);
  });
  const hasProductValue = fields.some((field) => field.present);
  const rawQuantity = aliasedValue(properties, aliases, "quantity");
  const quantitySource = aliases.quantity;
  const quantitySourcePresent =
    quantitySource !== null && Object.hasOwn(properties, quantitySource);
  const hasQuantityValue = rawQuantity !== undefined && rawQuantity !== null;
  const quantity = hasQuantityValue ? positiveInteger(rawQuantity) : null;
  if (
    !hasProductValue ||
    fields.some((field) => !field.valid) ||
    (hasQuantityValue && quantity === null)
  ) {
    return {
      present: productSourcePresent || quantitySourcePresent,
      valid: false,
      product: null,
    };
  }
  return {
    present: true,
    valid: true,
    product: {
      sourceOrdinal,
      productId: productId.value,
      variantId: variantId.value,
      sku: sku.value,
      productName: productName.value,
      variantName: variantName.value,
      quantity,
    },
  };
}

function snapshotItem(
  value: unknown,
  aliases: EventAliasRegistry,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const sourceKeys = new Set(
    [...PRODUCT_FIELDS, "quantity" as const]
      .map((field) => aliases[field])
      .filter((source): source is string => source !== null),
  );
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return null;
  }
  if (keys.length > KLAVIYO_PRODUCT_ITEM_MAX_RAW_KEYS) return null;
  for (const key of keys) {
    if (
      key.length > KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES ||
      Buffer.byteLength(key, "utf8") > KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES ||
      CONTROL_CHARACTER.test(key)
    ) {
      return null;
    }
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    if (!sourceKeys.has(key)) continue;
    try {
      snapshot[key] = value[key];
    } catch {
      return null;
    }
  }
  return snapshot;
}

function productEvidence(
  metricKind: KlaviyoMetricKind,
  properties: Record<string, unknown>,
  aliases: EventAliasRegistry,
): {
  products: NormalizedKlaviyoProduct[];
  completeness: ProductEvidenceCompleteness;
  warnings: string[];
} {
  const itemsAlias = aliases.items;
  if (metricKind === "placed_order" && itemsAlias !== null) {
    const rawItems = properties[itemsAlias];
    if (rawItems === undefined || rawItems === null) {
      return {
        products: [],
        completeness: "unavailable",
        warnings: ["product_evidence_unavailable"],
      };
    }
    if (!Array.isArray(rawItems)) {
      return {
        products: [],
        completeness: "incomplete",
        warnings: ["product_evidence_invalid_collection"],
      };
    }
    let length: number;
    try {
      length = rawItems.length;
    } catch {
      return {
        products: [],
        completeness: "incomplete",
        warnings: ["product_evidence_invalid_collection"],
      };
    }
    const boundedLength = Math.min(length, NORMALIZED_PRODUCT_MAX_ITEMS);
    if (length === 0) {
      return {
        products: [],
        completeness: "incomplete",
        warnings: ["product_evidence_empty_collection"],
      };
    }
    const products: NormalizedKlaviyoProduct[] = [];
    let invalid = false;
    for (let index = 0; index < boundedLength; index += 1) {
      let rawItem: unknown;
      try {
        rawItem = rawItems[index];
      } catch {
        invalid = true;
        continue;
      }
      const item = snapshotItem(rawItem, aliases);
      if (item === null) {
        invalid = true;
        continue;
      }
      const normalized = normalizeProduct(item, aliases, index);
      if (!normalized.valid || normalized.product === null) invalid = true;
      else products.push(normalized.product);
    }
    const truncated = length > NORMALIZED_PRODUCT_MAX_ITEMS;
    const warnings: string[] = [];
    if (invalid) warnings.push("product_evidence_invalid_item");
    if (truncated) warnings.push("product_evidence_truncated");
    return {
      products,
      completeness: invalid || truncated ? "incomplete" : "complete",
      warnings,
    };
  }

  if (metricKind === "placed_order" || metricKind === "ordered_product") {
    const normalized = normalizeProduct(properties, aliases, 0);
    if (!normalized.present) {
      return {
        products: [],
        completeness: "unavailable",
        warnings: ["product_evidence_unavailable"],
      };
    }
    if (!normalized.valid || normalized.product === null) {
      return {
        products: [],
        completeness: "incomplete",
        warnings: ["product_evidence_invalid_item"],
      };
    }
    return {
      products: [normalized.product],
      completeness: "complete",
      warnings: [],
    };
  }

  return {
    products: [],
    completeness: "unavailable",
    warnings: ["product_evidence_unavailable"],
  };
}

function relationshipData(
  relationships: Record<string, unknown>,
  name: string,
): unknown {
  const relationship = relationships[name];
  if (!isRecord(relationship)) return undefined;
  try {
    return relationship.data;
  } catch {
    invalidPage();
  }
}

function requiredMetricRelationship(
  relationships: Record<string, unknown>,
  externalMetricId: string,
): void {
  const data = relationshipData(relationships, "metric");
  if (!isRecord(data)) invalidPage();
  let type: unknown;
  let id: unknown;
  try {
    type = data.type;
    id = data.id;
  } catch {
    invalidPage();
  }
  if (type !== "metric" || id !== externalMetricId) invalidPage();
}

function profileRelationship(
  relationships: Record<string, unknown>,
  warnings: string[],
): string | null {
  const data = relationshipData(relationships, "profile");
  if (data === undefined || data === null) return null;
  if (!isRecord(data)) {
    warnings.push("profile_relationship_invalid");
    return null;
  }
  let type: unknown;
  let id: unknown;
  try {
    type = data.type;
    id = data.id;
  } catch {
    warnings.push("profile_relationship_invalid");
    return null;
  }
  if (type !== "profile") {
    warnings.push("profile_relationship_invalid");
    return null;
  }
  return optionalIdentifier(
    id,
    warnings,
    "profile_identifier_omitted",
    true,
  );
}

function attributionRelationships(
  relationships: Record<string, unknown>,
  warnings: string[],
): string[] {
  const data = relationshipData(relationships, "attributions");
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data)) {
    warnings.push("attribution_relationship_invalid");
    return [];
  }
  let length: number;
  try {
    length = data.length;
  } catch {
    warnings.push("attribution_relationship_invalid");
    return [];
  }
  const identifiers = new Set<string>();
  let invalid = false;
  const scanLength = Math.min(length, ATTRIBUTION_SCAN_MAX_ITEMS);
  for (let index = 0; index < scanLength; index += 1) {
    let item: unknown;
    try {
      item = data[index];
    } catch {
      invalid = true;
      continue;
    }
    if (!isRecord(item)) {
      invalid = true;
      continue;
    }
    let type: unknown;
    let id: unknown;
    try {
      type = item.type;
      id = item.id;
    } catch {
      invalid = true;
      continue;
    }
    if (typeof id === "string" && !isKlaviyoRawStringWithinBounds(id)) {
      invalidPage();
    }
    if (
      type !== "attribution" ||
      typeof id !== "string" ||
      id.trim() === "" ||
      codePointLength(id) > MAX_IDENTIFIER_CODE_POINTS ||
      CONTROL_CHARACTER.test(id) ||
      !isKlaviyoProviderOpaqueId(id)
    ) {
      invalid = true;
      continue;
    }
    identifiers.add(id);
  }
  const sorted = [...identifiers].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    length > NORMALIZED_ATTRIBUTION_MAX_IDS ||
    length > ATTRIBUTION_SCAN_MAX_ITEMS ||
    sorted.length > NORMALIZED_ATTRIBUTION_MAX_IDS
  ) {
    warnings.push("attribution_relationship_truncated");
  }
  if (invalid) warnings.push("attribution_relationship_invalid");
  return sorted.slice(0, NORMALIZED_ATTRIBUTION_MAX_IDS);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

const PROFILE_DERIVED_WARNINGS = new Set([
  "profile_identifier_omitted",
  "profile_relationship_invalid",
]);

type NormalizedEventWithoutChecksum = Omit<
  NormalizedKlaviyoEvent,
  "sourceChecksum" | "identityDigests" | "erasureSuppressionCandidates"
>;

type NormalizedEventDraft = {
  event: NormalizedEventWithoutChecksum;
  normalizedBytes: number;
};

function normalizedEventJson(event: NormalizedEventWithoutChecksum): string {
  return stableJson({
    ...event,
    occurredAt: event.occurredAt.toISOString(),
  });
}

function checksum(event: NormalizedEventWithoutChecksum): string {
  const canonical = {
    externalEventId: event.externalEventId,
    eventUuid: event.eventUuid,
    metricId: event.metricId,
    metricKind: event.metricKind,
    occurredAt: event.occurredAt.toISOString(),
    explicitOrderIdCandidate: event.explicitOrderIdCandidate,
    providerUniqueIdCandidate: event.providerUniqueIdCandidate,
    providerValue: event.providerValue,
    providerCurrency: event.providerCurrency,
    attributionRelationshipIds: event.attributionRelationshipIds,
    evidence: {
      ...event.evidence,
      warnings: event.evidence.warnings.filter(
        (warning) => !PROFILE_DERIVED_WARNINGS.has(warning),
      ),
    },
    products: event.products,
    productEvidenceCompleteness: event.productEvidenceCompleteness,
    apiRevision: event.apiRevision,
  };
  return createHash("sha256")
    .update(stableJson(canonical), "utf8")
    .digest("base64url");
}

function normalizeResource(input: {
  resource: KlaviyoResource;
  metricRowId: string;
  externalMetricId: string;
  metricKind: KlaviyoMetricKind;
  apiRevision: string;
  merchantHosts: ReadonlySet<string>;
  aliases: EventAliasRegistry;
}): NormalizedEventDraft {
  const { resource } = input;
  let type: unknown;
  let rawId: unknown;
  let rawAttributes: unknown;
  let rawRelationships: unknown;
  try {
    type = resource.type;
    rawId = resource.id;
    rawAttributes = resource.attributes;
    rawRelationships = resource.relationships;
  } catch {
    invalidPage();
  }
  if (type !== "event") invalidPage();
  const externalEventId = requiredIdentifier(rawId, invalidPage, true);
  if (!isRecord(rawAttributes) || !isRecord(rawRelationships)) invalidPage();
  requiredMetricRelationship(rawRelationships, input.externalMetricId);

  let rawDatetime: unknown;
  let rawUuid: unknown;
  let rawProperties: unknown;
  try {
    rawDatetime = rawAttributes.datetime;
    rawUuid = rawAttributes.uuid;
    rawProperties = rawAttributes.event_properties;
  } catch {
    invalidPage();
  }
  const occurredAt = parseOccurredAt(rawDatetime);
  const properties = snapshotEventProperties(rawProperties);
  const approvedKeys = new Set(
    KLAVIYO_EVENT_ALIAS_FIELDS.map((field) => input.aliases[field]).filter(
      (source): source is string => source !== null,
    ),
  );
  let evidence: ReturnType<typeof redactEventProperties>;
  try {
    evidence = redactEventProperties(
      properties,
      approvedKeys,
      input.merchantHosts,
    );
  } catch {
    invalidPage();
  }
  const warnings = [...evidence.warnings];
  const eventUuid = optionalIdentifier(
    rawUuid,
    warnings,
    "event_uuid_omitted",
    true,
  );
  const profileId = profileRelationship(rawRelationships, warnings);
  const attributionRelationshipIds = attributionRelationships(
    rawRelationships,
    warnings,
  );
  const products = productEvidence(input.metricKind, properties, input.aliases);
  warnings.push(...products.warnings);

  const orderId = scalarText(
    aliasedValue(properties, input.aliases, "orderId"),
    "identifier",
  );
  const uniqueId = scalarText(
    aliasedValue(properties, input.aliases, "uniqueEventId"),
    "identifier",
  );
  if (orderId.present && !orderId.valid) warnings.push("order_id_candidate_omitted");
  if (uniqueId.present && !uniqueId.valid) {
    warnings.push("provider_unique_id_candidate_omitted");
  }
  const rawValue = aliasedValue(properties, input.aliases, "value");
  const providerValue = rawValue === undefined || rawValue === null
    ? null
    : numericValue(rawValue);
  if (rawValue !== undefined && rawValue !== null && providerValue === null) {
    warnings.push("provider_value_omitted");
  }
  const rawCurrency = aliasedValue(properties, input.aliases, "currency");
  const providerCurrency = rawCurrency === undefined || rawCurrency === null
    ? null
    : currencyValue(rawCurrency);
  if (
    rawCurrency !== undefined &&
    rawCurrency !== null &&
    providerCurrency === null
  ) {
    warnings.push("provider_currency_omitted");
  }

  evidence.warnings = [...new Set(warnings)].sort();
  const normalizedWithoutChecksum: NormalizedEventWithoutChecksum = {
    externalEventId,
    eventUuid,
    metricId: input.metricRowId,
    metricKind: input.metricKind,
    occurredAt,
    profileId,
    explicitOrderIdCandidate: orderId.valid ? orderId.value : null,
    providerUniqueIdCandidate: uniqueId.valid ? uniqueId.value : null,
    providerValue,
    providerCurrency,
    attributionRelationshipIds,
    evidence,
    products: products.products,
    productEvidenceCompleteness: products.completeness,
    apiRevision: input.apiRevision,
  };
  const normalizedBytes = Buffer.byteLength(
    normalizedEventJson(normalizedWithoutChecksum),
    "utf8",
  ) + SOURCE_CHECKSUM_SERIALIZED_OVERHEAD_BYTES;
  if (normalizedBytes > KLAVIYO_EVENT_MAX_NORMALIZED_BYTES) invalidPage();
  return { event: normalizedWithoutChecksum, normalizedBytes };
}

export type NormalizeEventPageIdentityInput = {
  scope: IdentityScope;
  identityKeyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
};

/**
 * Extract sparse included profile emails for in-memory HMAC derivation.
 * Emails never leave this function inside a normalized event.
 */
function includedProfileEmails(page: KlaviyoCompoundPage): Map<string, string> {
  const emails = new Map<string, string>();
  let included: unknown;
  try {
    included = page.included;
  } catch {
    return emails;
  }
  if (!Array.isArray(included)) return emails;
  for (const resource of included) {
    if (!isRecord(resource)) continue;
    let type: unknown;
    let id: unknown;
    let attributes: unknown;
    try {
      type = resource.type;
      id = resource.id;
      attributes = resource.attributes;
    } catch {
      continue;
    }
    if (type !== "profile" || typeof id !== "string") continue;
    if (!isRecord(attributes)) continue;
    let email: unknown;
    try {
      email = attributes.email;
    } catch {
      continue;
    }
    if (
      typeof email === "string" &&
      email.includes("@") &&
      isKlaviyoRawStringWithinBounds(email)
    ) {
      emails.set(id, email);
    }
  }
  return emails;
}

function deriveEventIdentity(
  event: NormalizedEventWithoutChecksum,
  identity: NormalizeEventPageIdentityInput | undefined,
  profileEmailById: Map<string, string>,
): {
  identityDigests: VersionedIdentityDigest[];
  erasureSuppressionCandidates: ErasureSuppressionDigest[];
} {
  if (!identity || event.profileId === null) {
    return { identityDigests: [], erasureSuppressionCandidates: [] };
  }
  const email = profileEmailById.get(event.profileId) ?? null;
  const identityDigests =
    email === null
      ? []
      : computeIdentityDigests({
          scope: identity.scope,
          email,
          keyring: identity.identityKeyring,
        });
  const erasureSuppressionCandidates = computeErasureSuppressionDigests({
    scope: identity.scope,
    key: identity.suppressionKey,
    email,
    klaviyoProfileId: event.profileId,
  });
  return { identityDigests, erasureSuppressionCandidates };
}

export function normalizeEventPage(input: {
  metricRowId: string;
  externalMetricId: string;
  metricKind: KlaviyoMetricKind;
  apiRevision: string;
  merchantHosts: ReadonlySet<string>;
  approvedAliases: EventAliasRegistry;
  page: KlaviyoCompoundPage;
  identity?: NormalizeEventPageIdentityInput;
}): NormalizedKlaviyoEvent[] {
  let metricRowId: unknown;
  let externalMetricId: unknown;
  let metricKind: unknown;
  let apiRevision: unknown;
  let merchantHosts: ReadonlySet<string>;
  let approvedAliases: EventAliasRegistry;
  let page: KlaviyoCompoundPage;
  try {
    metricRowId = input.metricRowId;
    externalMetricId = input.externalMetricId;
    metricKind = input.metricKind;
    apiRevision = input.apiRevision;
    merchantHosts = input.merchantHosts;
    approvedAliases = input.approvedAliases;
    page = input.page;
  } catch {
    invalidInput();
  }
  const internalMetricId = requiredIdentifier(metricRowId, invalidInput);
  const providerMetricId = requiredIdentifier(
    externalMetricId,
    invalidInput,
    true,
  );
  const revision = requiredApiRevision(apiRevision);
  if (!KLAVIYO_ALLOWED_METRIC_KINDS.includes(metricKind as never)) invalidInput();
  const aliases = snapshotAliases(approvedAliases);
  const hosts = snapshotMerchantHosts(merchantHosts);

  let data: KlaviyoResource[];
  let pageRevision: unknown;
  try {
    const rawData = page.data;
    if (!Array.isArray(rawData)) invalidPage();
    const rawEventCount = rawData.length;
    if (rawEventCount > KLAVIYO_EVENT_PAGE_MAX_EVENTS) invalidPage();
    data = Array.prototype.slice.call(rawData) as KlaviyoResource[];
    pageRevision = page.apiRevision;
  } catch (error) {
    if (error instanceof Error && error.message === "Klaviyo event page is invalid") {
      throw error;
    }
    invalidPage();
  }
  if (pageRevision !== revision) invalidPage();

  const drafts = data.map((resource) =>
    normalizeResource({
      resource,
      metricRowId: internalMetricId,
      externalMetricId: providerMetricId,
      metricKind: metricKind as KlaviyoMetricKind,
      apiRevision: revision,
      merchantHosts: hosts,
      aliases,
    }),
  );
  if (
    drafts.reduce((total, draft) => total + draft.normalizedBytes, 0) >
    KLAVIYO_EVENT_PAGE_MAX_NORMALIZED_BYTES
  ) {
    invalidPage();
  }
  if (
    new Set(drafts.map((draft) => draft.event.externalEventId)).size !==
    drafts.length
  ) {
    invalidPage();
  }
  const profileEmailById = input.identity
    ? includedProfileEmails(page)
    : new Map<string, string>();
  return drafts.map(({ event }) => ({
    ...event,
    ...deriveEventIdentity(event, input.identity, profileEmailById),
    // The content checksum stays identity-free: digests and suppression
    // candidates never influence it.
    sourceChecksum: checksum(event),
  }));
}
