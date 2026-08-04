import "server-only";

import { createHash } from "node:crypto";
import {
  computeIdentityDigests,
  parseIdentityHmacKeyring,
  type IdentityHmacKeyring,
} from "@/lib/identity-hmac";
import {
  KlaviyoApiClient,
  type KlaviyoCompoundPage,
  type KlaviyoResource,
} from "@/lib/klaviyo/client";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialProvider,
} from "@/lib/klaviyo/credential-provider";
import { redactEventProperties } from "@/lib/klaviyo/redaction";
import {
  commitKlaviyoProbeReport,
  finishKlaviyoSyncRun,
  getConnectionRecord,
  listNewestEvidenceCompleteOrders,
  loadEnabledOrderCoreMetrics,
  loadRunningProbeSampleSize,
  prepareKlaviyoOperationRun,
  renewKlaviyoSyncRunHeartbeat,
  type CandidateAliasInput,
  type CandidateRuleInput,
  type ProbePersistence,
  type SampledEvidenceOrder,
} from "@/lib/klaviyo/source-store";
import {
  KLAVIYO_EVENT_ALIAS_FIELDS,
  type JsonType,
  type KlaviyoConnectionScope,
  type KlaviyoEventAliasField,
  type PropertyFingerprintEntry,
  type RedactedProbeExample,
} from "@/lib/klaviyo/types";

export const PROBE_MIN_SAMPLE = 20;
export const PROBE_MAX_SAMPLE = 50;
const PROBE_MAX_EVENT_PAGES = 200;
const UNMATCHED_EXAMPLE_LIMIT = 10;

export type ProbeAttributionKind =
  | "campaign"
  | "flow"
  | "message"
  | "variation"
  | "interaction_type";

export type ProbeObservation = {
  metricKind: "placed_order" | "ordered_product";
  occurredAt: Date;
  sourceProperty: string;
  sourceType: JsonType;
  normalizedValue: string | null;
  productComparable: boolean;
  attributionKinds: ProbeAttributionKind[];
  fingerprint: PropertyFingerprintEntry[];
  warnings: string[];
};

const REDACTION_DENYLIST: readonly RegExp[] = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /https?:\/\/[^"\s]*[?#]/i,
  /\b[a-f0-9]{32,}\b/i,
];
const PHONE_CANDIDATE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function containsDeniedContent(serialized: string): boolean {
  if (REDACTION_DENYLIST.some((pattern) => pattern.test(serialized))) {
    return true;
  }
  for (const candidate of serialized.match(PHONE_CANDIDATE) ?? []) {
    if (ISO_DAY.test(candidate)) continue;
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= 9) return true;
  }
  return false;
}

function fingerprintKey(entry: PropertyFingerprintEntry): string {
  return `${entry.keyKind}:${entry.key}:${entry.type}`;
}

export function summarizeProbe(input: {
  sampledShopifyOrderIds: string[];
  observations: ProbeObservation[];
  redactionVerified: boolean;
}): ProbePersistence {
  const sampled = new Set(input.sampledShopifyOrderIds);
  const identifierCoverage: Record<string, number> = {};
  const collisionValueSets = new Map<string, Map<string, Set<string>>>();
  const collisionCounts = new Map<string, Map<string, number>>();
  const unmatchedSummary: Record<string, number> = {};
  const unmatchedExamples: RedactedProbeExample[] = [];
  const productCoverage: Record<string, number> = {
    comparable: 0,
    placed_order: 0,
    ordered_product: 0,
  };
  const attributionCoverage: Record<string, number> = {};
  const shapes = new Map<string, PropertyFingerprintEntry>();
  let bindingOverlapCount = 0;

  for (const observation of input.observations) {
    for (const entry of observation.fingerprint) {
      const key = fingerprintKey(entry);
      if (!shapes.has(key)) shapes.set(key, entry);
    }
    for (const kind of observation.attributionKinds) {
      attributionCoverage[kind] = (attributionCoverage[kind] ?? 0) + 1;
    }
    if (observation.productComparable) {
      productCoverage.comparable += 1;
      productCoverage[observation.metricKind] =
        (productCoverage[observation.metricKind] ?? 0) + 1;
    }

    if (observation.normalizedValue !== null) {
      identifierCoverage[observation.sourceProperty] =
        (identifierCoverage[observation.sourceProperty] ?? 0) + 1;
      const perKind =
        collisionValueSets.get(observation.sourceProperty) ??
        new Map<string, Set<string>>();
      const values = perKind.get(observation.metricKind) ?? new Set<string>();
      if (values.has(observation.normalizedValue)) {
        const perKindCounts =
          collisionCounts.get(observation.sourceProperty) ??
          new Map<string, number>();
        perKindCounts.set(
          observation.metricKind,
          (perKindCounts.get(observation.metricKind) ?? 0) + 1,
        );
        collisionCounts.set(observation.sourceProperty, perKindCounts);
      }
      values.add(observation.normalizedValue);
      perKind.set(observation.metricKind, values);
      collisionValueSets.set(observation.sourceProperty, perKind);
    }

    const matched =
      observation.normalizedValue !== null &&
      sampled.has(observation.normalizedValue);
    if (matched) {
      bindingOverlapCount += 1;
    } else {
      unmatchedSummary[observation.metricKind] =
        (unmatchedSummary[observation.metricKind] ?? 0) + 1;
      if (unmatchedExamples.length < UNMATCHED_EXAMPLE_LIMIT) {
        unmatchedExamples.push({
          metricKind: observation.metricKind,
          occurredOnUtc: observation.occurredAt.toISOString().slice(0, 10),
          fingerprint: observation.fingerprint,
          warnings: observation.warnings,
        });
      }
    }
  }

  const collisionSummary: Record<string, number> = {};
  for (const [sourceProperty, perKind] of collisionCounts) {
    let total = 0;
    for (const count of perKind.values()) total += count;
    if (total > 0) collisionSummary[sourceProperty] = total;
  }

  const persistence: ProbePersistence = {
    bindingOverlapCount,
    keyTypeShapes: [...shapes.values()],
    identifierCoverage,
    collisionSummary,
    unmatchedSummary,
    unmatchedExamples,
    productCoverage,
    attributionCoverage,
    redactionVerified: false,
  };
  const clean = !containsDeniedContent(JSON.stringify(persistence));
  return { ...persistence, redactionVerified: input.redactionVerified && clean };
}

function assertSampleSize(sampleSize: number): void {
  if (
    !Number.isInteger(sampleSize) ||
    sampleSize < PROBE_MIN_SAMPLE ||
    sampleSize > PROBE_MAX_SAMPLE
  ) {
    throw new Error("Probe sample size must be between 20 and 50");
  }
}

async function requireProbeReadiness(
  scope: KlaviyoConnectionScope,
): Promise<void> {
  const connection = await getConnectionRecord(scope);
  if (!connection) throw new Error("Klaviyo connection is outside this scope");
  if (connection.status !== "pending") {
    throw new Error("Klaviyo probes run only against a pending connection");
  }
  if (connection.klaviyoAccountId === null) {
    throw new Error("Klaviyo probes require a discovery-verified account");
  }
  // Throws unless exactly one enabled native metric exists per order kind.
  await loadEnabledOrderCoreMetrics(scope);
}

/**
 * Prepare exactly one running scoped probe run whose safe request is
 * `{ sampleSize }`. Secrets and readiness fail before any database write.
 */
export async function prepareKlaviyoProbeRun(input: {
  scope: KlaviyoConnectionScope;
  sampleSize: number;
  triggerType: string;
  now?: Date;
  credentialProvider?: KlaviyoCredentialProvider;
  loadIdentityKeyring?: () => unknown;
  loadProbeReadiness?: (scope: KlaviyoConnectionScope) => Promise<void>;
  prepareRun?: typeof prepareKlaviyoOperationRun;
}): Promise<{ syncRunId: string; reused: boolean }> {
  assertSampleSize(input.sampleSize);
  (input.loadIdentityKeyring ?? parseIdentityHmacKeyring)();
  const credentialProvider =
    input.credentialProvider ?? new EnvironmentKlaviyoCredentialProvider();
  await credentialProvider.getPilotBinding();
  await (input.loadProbeReadiness ?? requireProbeReadiness)(input.scope);
  return (input.prepareRun ?? prepareKlaviyoOperationRun)({
    scope: input.scope,
    operation: "probe",
    triggerType: input.triggerType,
    requestParameters: { sampleSize: input.sampleSize },
    now: input.now ?? new Date(),
  });
}

const RECOGNIZED_ALIAS_SOURCES: Record<
  KlaviyoEventAliasField,
  readonly string[]
> = {
  orderId: ["OrderId", "order_id", "$order_id"],
  uniqueEventId: ["$event_id", "EventId"],
  productId: ["ProductID", "product_id", "$product_id"],
  variantId: ["VariantID", "variant_id"],
  sku: ["SKU", "sku"],
  productName: ["ProductName", "Product Name"],
  variantName: ["VariantName", "Variant Name"],
  quantity: ["Quantity", "quantity"],
  value: ["$value", "Value"],
  currency: ["$currency_code", "Currency"],
  items: ["Items", "items", "line_items"],
};

const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/(\d+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeOf(value: unknown): JsonType {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function canonicalOrderForms(value: unknown): string[] {
  if (typeof value !== "string" && typeof value !== "number") return [];
  const text = String(value).trim();
  if (text.length === 0 || text.length > 512) return [];
  const gidMatch = ORDER_GID_PATTERN.exec(text);
  if (gidMatch) return [text, gidMatch[1]];
  if (/^\d+$/.test(text)) return [`gid://shopify/Order/${text}`, text];
  return [text];
}

function sampledOrderIdSet(orders: SampledEvidenceOrder[]): Set<string> {
  const set = new Set<string>();
  for (const order of orders) {
    set.add(order.shopifyOrderId);
    set.add(`gid://shopify/Order/${order.shopifyOrderId}`);
  }
  return set;
}

function attributionKindsFromPage(
  event: KlaviyoResource,
  includedAttributions: Map<string, KlaviyoResource>,
): ProbeAttributionKind[] {
  const kinds = new Set<ProbeAttributionKind>();
  const relationships = isRecord(event.relationships)
    ? event.relationships
    : {};
  const attributions = isRecord(relationships.attributions)
    ? relationships.attributions
    : {};
  const data = Array.isArray(attributions.data) ? attributions.data : [];
  for (const item of data) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const resource = includedAttributions.get(item.id);
    if (!resource) continue;
    const related = isRecord(resource.relationships)
      ? resource.relationships
      : {};
    for (const kind of ["campaign", "flow", "message", "variation"] as const) {
      const relation = related[`attributed-${kind}`] ?? related[kind];
      if (isRecord(relation) && relation.data) kinds.add(kind);
    }
    const attributes = isRecord(resource.attributes) ? resource.attributes : {};
    if (typeof attributes.interaction_type === "string") {
      kinds.add("interaction_type");
    }
  }
  return [...kinds];
}

type SampledEventPage = {
  metricKind: "placed_order" | "ordered_product";
  page: KlaviyoCompoundPage;
};

type FieldTally = Map<string, { populated: number; malformed: number }>;

export async function runKlaviyoProbe(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  credentialProvider?: KlaviyoCredentialProvider;
  clientFactory?: (
    privateApiKey: string,
  ) => Pick<KlaviyoApiClient, "listEvents">;
  loadIdentityKeyring?: () => IdentityHmacKeyring;
  loadConnection?: typeof getConnectionRecord;
  loadSampleSize?: typeof loadRunningProbeSampleSize;
  loadSampledOrders?: typeof listNewestEvidenceCompleteOrders;
  loadEnabledMetrics?: typeof loadEnabledOrderCoreMetrics;
  renewHeartbeat?: typeof renewKlaviyoSyncRunHeartbeat;
  commitProbe?: typeof commitKlaviyoProbeReport;
  finishRun?: typeof finishKlaviyoSyncRun;
  computeDigests?: typeof computeIdentityDigests;
  now?: () => Date;
}): Promise<{
  reportId: string;
  sampledOrders: number;
  candidateRules: number;
}> {
  const keyring = (input.loadIdentityKeyring ?? parseIdentityHmacKeyring)();

  const loadConnection = input.loadConnection ?? getConnectionRecord;
  const connection = await loadConnection(input.scope);
  if (!connection) throw new Error("Klaviyo connection is outside this scope");
  const credentialProvider =
    input.credentialProvider ?? new EnvironmentKlaviyoCredentialProvider();
  const credential = await credentialProvider.resolve({
    connectionId: connection.connectionId,
    credentialReference: connection.credentialReference,
    persistedKlaviyoAccountId: connection.klaviyoAccountId,
    shopDomain: connection.shopDomain,
  });

  const { sampleSize } = await (
    input.loadSampleSize ?? loadRunningProbeSampleSize
  )(input.scope, input.syncRunId);
  const renewHeartbeat = input.renewHeartbeat ?? renewKlaviyoSyncRunHeartbeat;
  const now = input.now ?? (() => new Date());
  await renewHeartbeat({
    scope: input.scope,
    syncRunId: input.syncRunId,
    operation: "probe",
    now: now(),
  });

  const orders = await (
    input.loadSampledOrders ?? listNewestEvidenceCompleteOrders
  )(input.scope, sampleSize);
  if (orders.length < PROBE_MIN_SAMPLE) {
    await (input.finishRun ?? finishKlaviyoSyncRun)({
      scope: input.scope,
      syncRunId: input.syncRunId,
      operation: "probe",
      status: "failed",
      error: new Error("insufficient sample"),
    });
    throw new Error(
      "Probe requires at least 20 evidence-complete Shopify orders",
    );
  }

  const orderTimes = orders.map((order) => order.orderCreatedAt.getTime());
  const window = {
    from: new Date(Math.min(...orderTimes)),
    to: new Date(Math.max(...orderTimes) + 1),
  };

  const metrics = await (
    input.loadEnabledMetrics ?? loadEnabledOrderCoreMetrics
  )(input.scope);
  const client = (
    input.clientFactory ??
    ((privateApiKey: string) => new KlaviyoApiClient({ privateApiKey }))
  )(credential.privateApiKey);

  const pages: SampledEventPage[] = [];
  let rowsRead = 0;
  for (const metric of metrics) {
    let cursor: string | null = null;
    let pageCount = 0;
    do {
      const page = await client.listEvents({
        metricId: metric.externalMetricId,
        from: window.from,
        to: window.to,
        cursor,
        includeAttributions: true,
        includeProfileEmail: true,
      });
      pages.push({ metricKind: metric.metricKind, page });
      rowsRead += page.data.length;
      cursor = page.nextCursor;
      pageCount += 1;
      if (pageCount > PROBE_MAX_EVENT_PAGES) {
        throw new Error("Klaviyo probe exceeded the event page bound");
      }
      await renewHeartbeat({
        scope: input.scope,
        syncRunId: input.syncRunId,
        operation: "probe",
        now: now(),
      });
    } while (cursor !== null);
  }

  const sampledIds = sampledOrderIdSet(orders);
  const digestToOrderGid = new Map<string, string>();
  for (const order of orders) {
    for (const digest of order.identityDigests) {
      if (!digestToOrderGid.has(digest)) {
        digestToOrderGid.set(
          digest,
          `gid://shopify/Order/${order.shopifyOrderId}`,
        );
      }
    }
  }
  const computeDigests = input.computeDigests ?? computeIdentityDigests;
  const identityScope = {
    organizationId: input.scope.organizationId,
    storeId: input.scope.storeId,
  };

  const observations: ProbeObservation[] = [];
  const aliasTallies = new Map<string, Map<KlaviyoEventAliasField, FieldTally>>();
  const orderIdRuleTallies = new Map<
    "placed_order" | "ordered_product",
    Map<string, { populated: number; values: Set<string>; collisions: number; gidShaped: number }>
  >();
  let sampledKlaviyoEvents = 0;

  for (const { metricKind, page } of pages) {
    const metric = metrics.find((entry) => entry.metricKind === metricKind)!;
    const includedProfiles = new Map<string, KlaviyoResource>();
    const includedAttributions = new Map<string, KlaviyoResource>();
    for (const resource of page.included) {
      if (resource.type === "profile") includedProfiles.set(resource.id, resource);
      if (resource.type === "attribution") {
        includedAttributions.set(resource.id, resource);
      }
    }

    for (const event of page.data) {
      if (event.type !== "event") continue;
      sampledKlaviyoEvents += 1;
      const attributes = isRecord(event.attributes) ? event.attributes : {};
      const properties = isRecord(attributes.event_properties)
        ? attributes.event_properties
        : {};
      const occurredAt =
        typeof attributes.datetime === "string" &&
        !Number.isNaN(Date.parse(attributes.datetime))
          ? new Date(attributes.datetime)
          : new Date(0);
      const recognizedKeys = new Set(
        Object.values(RECOGNIZED_ALIAS_SOURCES).flat(),
      );
      const evidence = redactEventProperties(
        properties,
        recognizedKeys,
        new Set(credential.allowedUrlHosts),
      );
      const attributionKinds = attributionKindsFromPage(
        event,
        includedAttributions,
      );

      // Track per-metric recognized alias coverage.
      const metricTallies =
        aliasTallies.get(metric.metricRowId) ??
        new Map<KlaviyoEventAliasField, FieldTally>();
      for (const field of KLAVIYO_EVENT_ALIAS_FIELDS) {
        for (const sourceKey of RECOGNIZED_ALIAS_SOURCES[field]) {
          if (!(sourceKey in properties)) continue;
          const fieldTally: FieldTally =
            metricTallies.get(field) ?? new Map();
          const tally = fieldTally.get(sourceKey) ?? {
            populated: 0,
            malformed: 0,
          };
          const raw = properties[sourceKey];
          const scalar =
            typeof raw === "string"
              ? raw.trim().length > 0
              : typeof raw === "number" && Number.isFinite(raw);
          const structured = field === "items" && Array.isArray(raw);
          if (scalar || structured) tally.populated += 1;
          else tally.malformed += 1;
          fieldTally.set(sourceKey, tally);
          metricTallies.set(field, fieldTally);
        }
      }
      aliasTallies.set(metric.metricRowId, metricTallies);

      const productComparable =
        metricKind === "ordered_product"
          ? RECOGNIZED_ALIAS_SOURCES.productId.some((key) => key in properties) ||
            RECOGNIZED_ALIAS_SOURCES.sku.some((key) => key in properties)
          : RECOGNIZED_ALIAS_SOURCES.items.some(
              (key) => key in properties && Array.isArray(properties[key]),
            );

      // Identifier observations for recognized order-ID shaped keys.
      for (const sourceKey of RECOGNIZED_ALIAS_SOURCES.orderId) {
        if (!(sourceKey in properties)) continue;
        const forms = canonicalOrderForms(properties[sourceKey]);
        const matchedForm = forms.find((form) => sampledIds.has(form)) ?? null;
        const normalizedValue = matchedForm ?? forms[0] ?? null;
        observations.push({
          metricKind,
          occurredAt,
          sourceProperty: sourceKey,
          sourceType: jsonTypeOf(properties[sourceKey]),
          normalizedValue,
          productComparable,
          attributionKinds,
          fingerprint: evidence.fingerprint,
          warnings: evidence.warnings,
        });

        if (normalizedValue !== null) {
          const kindTallies =
            orderIdRuleTallies.get(metricKind) ?? new Map();
          const ruleTally = kindTallies.get(sourceKey) ?? {
            populated: 0,
            values: new Set<string>(),
            collisions: 0,
            gidShaped: 0,
          };
          ruleTally.populated += 1;
          if (ruleTally.values.has(normalizedValue)) ruleTally.collisions += 1;
          ruleTally.values.add(normalizedValue);
          if (ORDER_GID_PATTERN.test(String(properties[sourceKey]).trim())) {
            ruleTally.gidShaped += 1;
          }
          kindTallies.set(sourceKey, ruleTally);
          orderIdRuleTallies.set(metricKind, kindTallies);
        }
      }

      // Aggregate exact-email overlap; digests are discarded after counting.
      const profileRelationship = isRecord(event.relationships)
        ? event.relationships.profile
        : null;
      const profileId =
        isRecord(profileRelationship) &&
        isRecord(profileRelationship.data) &&
        typeof profileRelationship.data.id === "string"
          ? profileRelationship.data.id
          : null;
      const profile = profileId ? includedProfiles.get(profileId) : null;
      const profileEmail =
        profile && isRecord(profile.attributes)
          ? profile.attributes.email
          : null;
      if (typeof profileEmail === "string" && profileEmail.includes("@")) {
        const digests = computeDigests({
          scope: identityScope,
          email: profileEmail,
          keyring,
        });
        // Digests are discarded after this lookup; only the sampled-order
        // membership (as the order GID) is observed.
        const matchedGid =
          digests
            .map((entry) => digestToOrderGid.get(entry.digest))
            .find((gid) => gid !== undefined) ?? null;
        observations.push({
          metricKind,
          occurredAt,
          sourceProperty: "profileEmail",
          sourceType: "string",
          normalizedValue: matchedGid,
          productComparable: false,
          attributionKinds: [],
          fingerprint: [],
          warnings: [],
        });
      }
    }
  }

  const persistence = summarizeProbe({
    sampledShopifyOrderIds: [...sampledIds],
    observations,
    redactionVerified: true,
  });

  const candidateAliases: CandidateAliasInput[] = [];
  for (const metric of metrics) {
    const metricTallies = aliasTallies.get(metric.metricRowId);
    if (!metricTallies) continue;
    for (const [field, fieldTally] of metricTallies) {
      const populatedSources = [...fieldTally.entries()].filter(
        ([, tally]) => tally.populated > 0,
      );
      // Ambiguous mappings are rejected instead of choosing one.
      if (populatedSources.length !== 1) continue;
      const [sourceProperty, tally] = populatedSources[0];
      candidateAliases.push({
        metricRowId: metric.metricRowId,
        canonicalField: field,
        sourceProperty,
        observedPopulated: tally.populated,
        observedMalformed: tally.malformed,
      });
    }
  }

  const candidateRules: CandidateRuleInput[] = [];
  for (const [metricKind, kindTallies] of orderIdRuleTallies) {
    for (const [sourceProperty, tally] of kindTallies) {
      if (tally.populated === 0) continue;
      const gidDeterministic = tally.gidShaped === tally.populated;
      candidateRules.push({
        eventKind: metricKind,
        sourceProperty,
        targetNamespace: "shopify_order_gid",
        canonicalizer: gidDeterministic ? "shopify_order_gid" : "trimmed_exact",
        observedPopulated: tally.populated,
        observedCollisions: tally.collisions,
      });
    }
  }

  const checksum = createHash("sha256")
    .update(
      JSON.stringify({
        persistence,
        sampledShopifyOrders: orders.length,
        sampledKlaviyoEvents,
        window: {
          from: window.from.toISOString(),
          to: window.to.toISOString(),
        },
      }),
    )
    .digest("hex");

  const { reportId } = await (input.commitProbe ?? commitKlaviyoProbeReport)({
    scope: input.scope,
    syncRunId: input.syncRunId,
    sampledFrom: window.from,
    sampledTo: window.to,
    sampledShopifyOrders: orders.length,
    sampledKlaviyoEvents,
    persistence,
    checksum,
    candidateAliases,
    candidateRules,
    rowsRead,
  });

  return {
    reportId,
    sampledOrders: orders.length,
    candidateRules: candidateRules.length,
  };
}
