import "server-only";

import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { MATCHER_VERSION } from "@/lib/klaviyo/match-types";
import {
  computeAdvisoryMatches,
  type ApprovedJoinRule,
  type MatchComputation,
  type MatchEventInput,
  type MatchOrderInput,
  type MatchOrderedProductInput,
} from "@/lib/klaviyo/matcher";
import {
  publishFailedMatchRun,
  publishMatchRun,
} from "@/lib/klaviyo/match-repository";
import type { KlaviyoStoreTransaction } from "@/lib/klaviyo/source-store";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import {
  klaviyoConnections,
  klaviyoEventProducts,
  klaviyoEventRunObservations,
  klaviyoEvents,
  klaviyoJoinRules,
  klaviyoMetrics,
  klaviyoSyncRuns,
} from "@/schema/klaviyo";
import { klaviyoEventRunIdentityObservations } from "@/schema/klaviyo-match";
import { shopifyOrders } from "@/schema/shopify";
import {
  shopifyEvidenceRunIdentityObservations,
  shopifyEvidenceRunObservations,
  shopifyEvidenceSyncRuns,
  shopifyOrderLines,
  sourceIdentityHmacs,
} from "@/schema/shopify-evidence";
import { canonicalContentChecksum } from "@/lib/shopify-evidence-store";

type Executor = typeof db | KlaviyoStoreTransaction;

export class MatchInputStaleError extends Error {
  constructor(
    readonly reason: string,
    /** Safe reason code from the last per-run rejection a selection loop
     * swallowed — codes only, never provider or row content. */
    readonly lastRejection: string | null = null,
  ) {
    super(
      `Klaviyo match input is stale or unacceptable: ${reason}${
        lastRejection === null ? "" : ` (last run rejected: ${lastRejection})`
      }`,
    );
    this.name = "MatchInputStaleError";
  }
}

export function stableHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.keys(entry as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((accumulator, key) => {
            accumulator[key] = (entry as Record<string, unknown>)[key];
            return accumulator;
          }, {})
      : entry,
  );
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

export type KlaviyoProjectionEvent = {
  eventId: string;
  metricKind: "placed_order" | "ordered_product";
  occurredAt: Date;
  explicitOrderIdCandidate: string | null;
  providerUniqueIdCandidate: string | null;
  productEvidenceCompleteness: "complete" | "incomplete" | "unavailable";
  observedChecksum: string;
  identityHmacId: string | null;
  identityKeyVersion: string | null;
};

export type KlaviyoProjection = {
  sourceRunId: string;
  window: { from: Date; to: Date };
  currentKeyVersion: string | null;
  events: KlaviyoProjectionEvent[];
  checksum: string;
};

export async function loadKlaviyoProjection(
  input: { scope: KlaviyoConnectionScope; sourceRunId: string },
  executor: Executor = db,
): Promise<KlaviyoProjection> {
  const { scope, sourceRunId } = input;
  const [run] = await executor
    .select({
      operation: klaviyoSyncRuns.operation,
      status: klaviyoSyncRuns.status,
      checkpoint: klaviyoSyncRuns.checkpoint,
      requestParameters: klaviyoSyncRuns.requestParameters,
      requestedFrom: klaviyoSyncRuns.requestedFrom,
      requestedTo: klaviyoSyncRuns.requestedTo,
    })
    .from(klaviyoSyncRuns)
    .where(
      and(
        eq(klaviyoSyncRuns.id, sourceRunId),
        eq(klaviyoSyncRuns.organizationId, scope.organizationId),
        eq(klaviyoSyncRuns.storeId, scope.storeId),
        eq(klaviyoSyncRuns.connectionId, scope.connectionId),
      ),
    )
    .limit(1);
  if (!run) throw new MatchInputStaleError("source_run_missing");
  const parameters = run.requestParameters as Record<string, unknown> | null;
  if (
    run.operation !== "events" ||
    run.status !== "success" ||
    run.checkpoint !== null ||
    parameters?.sourceMode !== "order_core" ||
    JSON.stringify(parameters?.metricKinds) !==
      JSON.stringify(["placed_order", "ordered_product"]) ||
    run.requestedFrom === null ||
    run.requestedTo === null
  ) {
    throw new MatchInputStaleError("source_run_unacceptable");
  }

  const [gate] = await executor
    .select({
      currentVersion: klaviyoConnections.identityCurrentKeyVersion,
    })
    .from(klaviyoConnections)
    .where(
      and(
        eq(klaviyoConnections.organizationId, scope.organizationId),
        eq(klaviyoConnections.storeId, scope.storeId),
        eq(klaviyoConnections.id, scope.connectionId),
      ),
    )
    .limit(1);
  if (!gate) throw new MatchInputStaleError("connection_missing");

  const rows = await executor
    .select({
      eventId: klaviyoEvents.id,
      observedChecksum: klaviyoEventRunObservations.observedSourceChecksum,
      currentChecksum: klaviyoEvents.sourceChecksum,
      occurredAt: klaviyoEvents.occurredAt,
      explicitOrderIdCandidate: klaviyoEvents.explicitOrderIdCandidate,
      providerUniqueIdCandidate: klaviyoEvents.providerUniqueIdCandidate,
      productEvidenceCompleteness: klaviyoEvents.productEvidenceCompleteness,
      canonicalKind: klaviyoMetrics.canonicalKind,
    })
    .from(klaviyoEventRunObservations)
    .innerJoin(
      klaviyoEvents,
      and(
        eq(klaviyoEvents.organizationId, klaviyoEventRunObservations.organizationId),
        eq(klaviyoEvents.storeId, klaviyoEventRunObservations.storeId),
        eq(klaviyoEvents.connectionId, klaviyoEventRunObservations.connectionId),
        eq(klaviyoEvents.id, klaviyoEventRunObservations.eventId),
      ),
    )
    .innerJoin(klaviyoMetrics, eq(klaviyoMetrics.id, klaviyoEvents.metricId))
    .where(
      and(
        eq(klaviyoEventRunObservations.organizationId, scope.organizationId),
        eq(klaviyoEventRunObservations.storeId, scope.storeId),
        eq(klaviyoEventRunObservations.connectionId, scope.connectionId),
        eq(klaviyoEventRunObservations.syncRunId, sourceRunId),
      ),
    )
    .orderBy(asc(klaviyoEvents.id));

  for (const row of rows) {
    // Every current identity-free event checksum must equal its immutable
    // observed checksum; a mutated event stales the projection.
    if (row.observedChecksum !== row.currentChecksum) {
      throw new MatchInputStaleError("event_content_mutated");
    }
  }

  const identityLinks =
    rows.length === 0
      ? []
      : await executor
          .select({
            eventId: klaviyoEventRunIdentityObservations.eventId,
            identityHmacId: klaviyoEventRunIdentityObservations.identityHmacId,
            keyVersion: sourceIdentityHmacs.keyVersion,
          })
          .from(klaviyoEventRunIdentityObservations)
          .innerJoin(
            sourceIdentityHmacs,
            eq(
              sourceIdentityHmacs.id,
              klaviyoEventRunIdentityObservations.identityHmacId,
            ),
          )
          .where(
            and(
              eq(
                klaviyoEventRunIdentityObservations.connectionId,
                scope.connectionId,
              ),
              eq(klaviyoEventRunIdentityObservations.syncRunId, sourceRunId),
            ),
          );
  const identityByEvent = new Map<string, { id: string; keyVersion: string }>();
  for (const link of identityLinks) {
    // Previous-version links never score.
    if (gate.currentVersion !== null && link.keyVersion === gate.currentVersion) {
      identityByEvent.set(link.eventId, {
        id: link.identityHmacId,
        keyVersion: link.keyVersion,
      });
    }
  }

  const events: KlaviyoProjectionEvent[] = rows.map((row) => ({
    eventId: row.eventId,
    metricKind: row.canonicalKind as "placed_order" | "ordered_product",
    occurredAt: row.occurredAt,
    explicitOrderIdCandidate: row.explicitOrderIdCandidate,
    providerUniqueIdCandidate: row.providerUniqueIdCandidate,
    productEvidenceCompleteness:
      row.productEvidenceCompleteness as KlaviyoProjectionEvent["productEvidenceCompleteness"],
    observedChecksum: row.observedChecksum,
    identityHmacId: identityByEvent.get(row.eventId)?.id ?? null,
    identityKeyVersion: identityByEvent.get(row.eventId)?.keyVersion ?? null,
  }));

  const checksum = stableHash({
    sourceRunId,
    membership: events.map((event) => [
      event.eventId,
      event.observedChecksum,
      event.identityHmacId,
      event.identityKeyVersion,
    ]),
  });
  return {
    sourceRunId,
    window: { from: run.requestedFrom, to: run.requestedTo },
    currentKeyVersion: gate.currentVersion,
    events,
    checksum,
  };
}

export type ShopifyProjectionOrder = {
  orderId: string;
  shopifyNumericOrderId: string;
  orderCreatedAt: Date;
  lineDisposition: "complete" | "preserved_partial";
  identityDisposition: string;
  observedContentChecksum: string;
  identityHmacId: string | null;
  identityKeyVersion: string | null;
  lines: Array<{
    shopifyProductId: string | null;
    shopifyVariantId: string | null;
    sku: string | null;
    quantity: number;
  }>;
};

export type ShopifyProjection = {
  shopifyEvidenceRunId: string;
  window: { from: Date; to: Date };
  coverage: { status: string; lineCompleteness: string };
  orders: ShopifyProjectionOrder[];
  missingOrderCount: number;
  checksum: string;
};

export async function loadShopifyProjection(
  input: { scope: KlaviyoConnectionScope; shopifyEvidenceRunId: string },
  executor: Executor = db,
): Promise<ShopifyProjection> {
  const { scope, shopifyEvidenceRunId } = input;
  const [run] = await executor
    .select({
      status: shopifyEvidenceSyncRuns.status,
      lineCompleteness: shopifyEvidenceSyncRuns.lineCompleteness,
      requestedFrom: shopifyEvidenceSyncRuns.requestedFrom,
      requestedTo: shopifyEvidenceSyncRuns.requestedTo,
    })
    .from(shopifyEvidenceSyncRuns)
    .where(
      and(
        eq(shopifyEvidenceSyncRuns.id, shopifyEvidenceRunId),
        eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
        eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
      ),
    )
    .limit(1);
  if (!run) throw new MatchInputStaleError("evidence_run_missing");
  const acceptable =
    (run.status === "success" && run.lineCompleteness === "complete") ||
    (run.status === "partial" && run.lineCompleteness === "partial");
  if (!acceptable) throw new MatchInputStaleError("evidence_coverage_unacceptable");

  const observations = await executor
    .select({
      orderId: shopifyEvidenceRunObservations.orderId,
      lineDisposition: shopifyEvidenceRunObservations.lineDisposition,
      identityDisposition: shopifyEvidenceRunObservations.identityDisposition,
      observedContentChecksum:
        shopifyEvidenceRunObservations.observedContentChecksum,
      shopifyOrderId: shopifyOrders.shopifyOrderId,
      orderCreatedAt: shopifyOrders.orderCreatedAt,
    })
    .from(shopifyEvidenceRunObservations)
    .innerJoin(
      shopifyOrders,
      and(
        eq(shopifyOrders.organizationId, shopifyEvidenceRunObservations.organizationId),
        eq(shopifyOrders.storeId, shopifyEvidenceRunObservations.storeId),
        eq(shopifyOrders.id, shopifyEvidenceRunObservations.orderId),
      ),
    )
    .where(
      and(
        eq(shopifyEvidenceRunObservations.organizationId, scope.organizationId),
        eq(shopifyEvidenceRunObservations.storeId, scope.storeId),
        eq(shopifyEvidenceRunObservations.evidenceRunId, shopifyEvidenceRunId),
      ),
    )
    .orderBy(asc(shopifyEvidenceRunObservations.orderId));

  const orderIds = observations.map((observation) => observation.orderId);
  const lines =
    orderIds.length === 0
      ? []
      : await executor
          .select({
            orderId: shopifyOrderLines.orderId,
            shopifyLineItemId: shopifyOrderLines.shopifyLineItemId,
            shopifyProductId: shopifyOrderLines.shopifyProductId,
            shopifyVariantId: shopifyOrderLines.shopifyVariantId,
            sku: shopifyOrderLines.sku,
            quantity: shopifyOrderLines.quantity,
          })
          .from(shopifyOrderLines)
          .where(
            and(
              eq(shopifyOrderLines.organizationId, scope.organizationId),
              eq(shopifyOrderLines.storeId, scope.storeId),
              inArray(shopifyOrderLines.orderId, orderIds),
            ),
          )
          .orderBy(asc(shopifyOrderLines.orderId), asc(shopifyOrderLines.id));
  const linesByOrder = new Map<string, typeof lines>();
  for (const line of lines) {
    const bucket = linesByOrder.get(line.orderId) ?? [];
    bucket.push(line);
    linesByOrder.set(line.orderId, bucket);
  }

  const identityLinks =
    orderIds.length === 0
      ? []
      : await executor
          .select({
            orderId: shopifyEvidenceRunIdentityObservations.orderId,
            identityHmacId:
              shopifyEvidenceRunIdentityObservations.identityHmacId,
            keyVersion: sourceIdentityHmacs.keyVersion,
          })
          .from(shopifyEvidenceRunIdentityObservations)
          .innerJoin(
            sourceIdentityHmacs,
            eq(
              sourceIdentityHmacs.id,
              shopifyEvidenceRunIdentityObservations.identityHmacId,
            ),
          )
          .where(
            and(
              eq(
                shopifyEvidenceRunIdentityObservations.organizationId,
                scope.organizationId,
              ),
              eq(
                shopifyEvidenceRunIdentityObservations.storeId,
                scope.storeId,
              ),
              eq(
                shopifyEvidenceRunIdentityObservations.evidenceRunId,
                shopifyEvidenceRunId,
              ),
            ),
          );
  const identityByOrder = new Map<string, { id: string; keyVersion: string }>();
  for (const link of identityLinks) {
    identityByOrder.set(link.orderId, {
      id: link.identityHmacId,
      keyVersion: link.keyVersion,
    });
  }

  const orders: ShopifyProjectionOrder[] = observations.map((observation) => {
    const orderLines = (linesByOrder.get(observation.orderId) ?? []).map(
      (line) => ({
        shopifyLineItemId: line.shopifyLineItemId,
        shopifyProductId: line.shopifyProductId,
        shopifyVariantId: line.shopifyVariantId,
        sku: line.sku,
        quantity: line.quantity,
      }),
    );
    // Recompute Plan 1's canonical identity-free projection and require
    // equality with the immutable observation.
    const recomputed = canonicalContentChecksum({
      order: {
        id: observation.orderId,
        shopifyOrderId: observation.shopifyOrderId,
        orderCreatedAt: observation.orderCreatedAt,
      },
      lines: orderLines,
      lineDisposition:
        observation.lineDisposition as "complete" | "preserved_partial",
      identityDisposition:
        observation.identityDisposition as
          | "available"
          | "unavailable"
          | "not_refreshed"
          | "suppressed",
    });
    if (recomputed !== observation.observedContentChecksum) {
      throw new MatchInputStaleError("shopify_content_mutated");
    }
    return {
      orderId: observation.orderId,
      shopifyNumericOrderId: observation.shopifyOrderId,
      orderCreatedAt: observation.orderCreatedAt,
      lineDisposition:
        observation.lineDisposition as "complete" | "preserved_partial",
      identityDisposition: observation.identityDisposition,
      observedContentChecksum: observation.observedContentChecksum,
      identityHmacId: identityByOrder.get(observation.orderId)?.id ?? null,
      identityKeyVersion:
        identityByOrder.get(observation.orderId)?.keyVersion ?? null,
      lines: orderLines.map((line) => ({
        shopifyProductId: line.shopifyProductId,
        shopifyVariantId: line.shopifyVariantId,
        sku: line.sku,
        quantity: line.quantity,
      })),
    };
  });

  // For success+complete, membership must equal every scoped order in the
  // evaluated window.
  let missingOrderCount = 0;
  if (run.requestedFrom !== null && run.requestedTo !== null) {
    const windowOrders = await executor
      .select({ id: shopifyOrders.id })
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, scope.organizationId),
          eq(shopifyOrders.storeId, scope.storeId),
          gte(shopifyOrders.orderCreatedAt, run.requestedFrom),
          lt(shopifyOrders.orderCreatedAt, run.requestedTo),
        ),
      );
    const observed = new Set(orderIds);
    missingOrderCount = windowOrders.filter(
      (order) => !observed.has(order.id),
    ).length;
    if (run.status === "success" && missingOrderCount > 0) {
      throw new MatchInputStaleError("evidence_membership_incomplete");
    }
  }

  const checksum = stableHash({
    shopifyEvidenceRunId,
    window: {
      from: run.requestedFrom?.toISOString() ?? null,
      to: run.requestedTo?.toISOString() ?? null,
    },
    coverage: { status: run.status, lineCompleteness: run.lineCompleteness },
    membership: orders.map((order) => [
      order.orderId,
      order.observedContentChecksum,
      order.lineDisposition,
      order.identityDisposition,
      order.identityHmacId,
      order.identityKeyVersion,
    ]),
  });
  return {
    shopifyEvidenceRunId,
    window: { from: run.requestedFrom!, to: run.requestedTo! },
    coverage: { status: run.status, lineCompleteness: run.lineCompleteness },
    orders,
    missingOrderCount,
    checksum,
  };
}

export async function loadApprovedRules(
  scope: KlaviyoConnectionScope,
  executor: Executor = db,
): Promise<ApprovedJoinRule[]> {
  const rules = await executor
    .select({
      eventKind: klaviyoJoinRules.eventKind,
      sourceProperty: klaviyoJoinRules.sourceProperty,
      targetNamespace: klaviyoJoinRules.targetNamespace,
      canonicalizer: klaviyoJoinRules.canonicalizer,
    })
    .from(klaviyoJoinRules)
    .where(
      and(
        eq(klaviyoJoinRules.organizationId, scope.organizationId),
        eq(klaviyoJoinRules.storeId, scope.storeId),
        eq(klaviyoJoinRules.connectionId, scope.connectionId),
        eq(klaviyoJoinRules.state, "approved"),
      ),
    )
    .orderBy(asc(klaviyoJoinRules.sourceProperty));
  return rules.map((rule) => ({
    eventKind: rule.eventKind as ApprovedJoinRule["eventKind"],
    sourceProperty: rule.sourceProperty,
    targetNamespace: rule.targetNamespace,
    canonicalizer: rule.canonicalizer as ApprovedJoinRule["canonicalizer"],
    candidateSource:
      rule.sourceProperty === "$event_id" ? "order_id" : "order_id",
  }));
}

export function deriveFingerprints(input: {
  scope: KlaviyoConnectionScope;
  klaviyo: KlaviyoProjection;
  shopify: ShopifyProjection;
  ruleChecksum: string;
  configChecksum: string;
}): { publicationScopeFingerprint: string; invocationFingerprint: string } {
  // Hash only the closed scope triple. Callers may hold wider
  // connection-record shapes; extra fields must never reach the
  // fingerprint or two processes will derive different values for the
  // same publication.
  const scope: KlaviyoConnectionScope = {
    organizationId: input.scope.organizationId,
    storeId: input.scope.storeId,
    connectionId: input.scope.connectionId,
  };
  const publicationScopeFingerprint = stableHash({
    scope,
    eventWindow: {
      from: input.klaviyo.window.from.toISOString(),
      to: input.klaviyo.window.to.toISOString(),
    },
    shopifyWindow: {
      from: input.shopify.window.from.toISOString(),
      to: input.shopify.window.to.toISOString(),
    },
    matcherVersion: MATCHER_VERSION,
    ruleChecksum: input.ruleChecksum,
    configChecksum: input.configChecksum,
  });
  const invocationFingerprint = stableHash({
    publicationScopeFingerprint,
    sourceRunId: input.klaviyo.sourceRunId,
    shopifyEvidenceRunId: input.shopify.shopifyEvidenceRunId,
    klaviyoSourceChecksum: input.klaviyo.checksum,
    shopifyEvidenceChecksum: input.shopify.checksum,
  });
  return { publicationScopeFingerprint, invocationFingerprint };
}

async function identityEqualPairs(
  scope: KlaviyoConnectionScope,
  klaviyo: KlaviyoProjection,
  shopify: ShopifyProjection,
  executor: Executor,
): Promise<Array<{ eventId: string; orderId: string }>> {
  const hmacIds = [
    ...klaviyo.events.flatMap((event) =>
      event.identityHmacId === null ? [] : [event.identityHmacId],
    ),
    ...shopify.orders.flatMap((order) =>
      order.identityHmacId === null ? [] : [order.identityHmacId],
    ),
  ];
  if (hmacIds.length === 0) return [];
  // Digests are loaded transiently for equality only and never persisted.
  const rows = await executor
    .select({ id: sourceIdentityHmacs.id, digest: sourceIdentityHmacs.digest })
    .from(sourceIdentityHmacs)
    .where(
      and(
        eq(sourceIdentityHmacs.organizationId, scope.organizationId),
        eq(sourceIdentityHmacs.storeId, scope.storeId),
        inArray(sourceIdentityHmacs.id, hmacIds),
      ),
    );
  const digestById = new Map(rows.map((row) => [row.id, row.digest]));
  const pairs: Array<{ eventId: string; orderId: string }> = [];
  for (const event of klaviyo.events) {
    if (event.identityHmacId === null) continue;
    const eventDigest = digestById.get(event.identityHmacId);
    if (eventDigest === undefined) continue;
    for (const order of shopify.orders) {
      if (order.identityHmacId === null) continue;
      if (order.identityKeyVersion !== event.identityKeyVersion) continue;
      if (digestById.get(order.identityHmacId) === eventDigest) {
        pairs.push({ eventId: event.eventId, orderId: order.orderId });
      }
    }
  }
  return pairs;
}

/**
 * Select the newest acceptable source pair for recompute: the latest
 * successful terminal order-core Klaviyo run and the latest acceptable
 * Shopify evidence run — never a generic events run or unrelated latest.
 */
export async function selectLatestMatchInputs(
  scope: KlaviyoConnectionScope,
): Promise<{
  sourceRunId: string;
  shopifyEvidenceRunId: string;
  invocationFingerprint: string;
  publicationScopeFingerprint: string;
  window: { from: Date; to: Date };
}> {
  const candidateRuns = await db
    .select({
      id: klaviyoSyncRuns.id,
      finishedAt: klaviyoSyncRuns.finishedAt,
    })
    .from(klaviyoSyncRuns)
    .where(
      and(
        eq(klaviyoSyncRuns.organizationId, scope.organizationId),
        eq(klaviyoSyncRuns.storeId, scope.storeId),
        eq(klaviyoSyncRuns.connectionId, scope.connectionId),
        eq(klaviyoSyncRuns.operation, "events"),
        eq(klaviyoSyncRuns.status, "success"),
      ),
    )
    .orderBy(desc(klaviyoSyncRuns.finishedAt));
  let klaviyo: KlaviyoProjection | null = null;
  let lastSourceRejection: string | null = null;
  for (const run of candidateRuns) {
    try {
      klaviyo = await loadKlaviyoProjection({ scope, sourceRunId: run.id });
      break;
    } catch (error) {
      if (error instanceof MatchInputStaleError) {
        lastSourceRejection = error.reason;
        continue;
      }
      throw error;
    }
  }
  if (!klaviyo) {
    throw new MatchInputStaleError(
      "no_acceptable_source_run",
      lastSourceRejection,
    );
  }

  const evidenceRuns = await db
    .select({ id: shopifyEvidenceSyncRuns.id })
    .from(shopifyEvidenceSyncRuns)
    .where(
      and(
        eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
        eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
        inArray(shopifyEvidenceSyncRuns.status, ["success", "partial"]),
      ),
    )
    .orderBy(desc(shopifyEvidenceSyncRuns.startedAt));
  let shopify: ShopifyProjection | null = null;
  let lastEvidenceRejection: string | null = null;
  for (const run of evidenceRuns) {
    try {
      shopify = await loadShopifyProjection({
        scope,
        shopifyEvidenceRunId: run.id,
      });
      break;
    } catch (error) {
      if (error instanceof MatchInputStaleError) {
        lastEvidenceRejection = error.reason;
        continue;
      }
      throw error;
    }
  }
  if (!shopify) {
    throw new MatchInputStaleError(
      "no_acceptable_evidence_run",
      lastEvidenceRejection,
    );
  }

  const rules = await loadApprovedRules(scope);
  const { approvedRuleChecksum, matcherConfigChecksum } = await import(
    "@/lib/klaviyo/matcher"
  );
  const fingerprints = deriveFingerprints({
    scope,
    klaviyo,
    shopify,
    ruleChecksum: approvedRuleChecksum(rules),
    configChecksum: matcherConfigChecksum(),
  });
  return {
    sourceRunId: klaviyo.sourceRunId,
    shopifyEvidenceRunId: shopify.shopifyEvidenceRunId,
    invocationFingerprint: fingerprints.invocationFingerprint,
    publicationScopeFingerprint: fingerprints.publicationScopeFingerprint,
    window: klaviyo.window,
  };
}

export type ComputeAndPublishInput = {
  scope: KlaviyoConnectionScope;
  sourceRunId: string;
  shopifyEvidenceRunId: string;
  expectedInvocationFingerprint?: string;
};

export async function computeAndPublishMatches(
  input: ComputeAndPublishInput,
): Promise<{
  runId: string;
  invocationFingerprint: string;
  replayed: boolean;
  counts: { orders: number; events: number; candidates: number };
}> {
  const startedAt = new Date();
  const matchRunId = crypto.randomUUID();

  const klaviyo = await loadKlaviyoProjection(input);
  const shopify = await loadShopifyProjection(input);
  const rules = await loadApprovedRules(input.scope);
  const pairs = await identityEqualPairs(input.scope, klaviyo, shopify, db);

  const events: MatchEventInput[] = [];
  const orderedProducts: MatchOrderedProductInput[] = [];
  const products = await loadEventProducts(
    input.scope,
    klaviyo.events.map((event) => event.eventId),
  );
  for (const event of klaviyo.events) {
    if (event.metricKind === "placed_order") {
      events.push({
        eventId: event.eventId,
        metricKind: "placed_order",
        occurredAt: event.occurredAt,
        explicitOrderIdCandidate: event.explicitOrderIdCandidate,
        providerUniqueIdCandidate: event.providerUniqueIdCandidate,
        products: products.get(event.eventId) ?? [],
        productEvidenceCompleteness: event.productEvidenceCompleteness,
      });
    } else {
      orderedProducts.push({
        eventId: event.eventId,
        explicitOrderIdCandidate: event.explicitOrderIdCandidate,
        products: products.get(event.eventId) ?? [],
      });
    }
  }
  const orders: MatchOrderInput[] = shopify.orders.map((order) => ({
    orderId: order.orderId,
    shopifyNumericOrderId: order.shopifyNumericOrderId,
    orderCreatedAt: order.orderCreatedAt,
    // preserved_partial lines cannot produce exact/diagnostic product
    // contribution; expose them as empty line evidence.
    lines: order.lineDisposition === "complete" ? order.lines : [],
  }));

  const computation: MatchComputation = computeAdvisoryMatches({
    scope: input.scope,
    currentIdentityKeyVersion: klaviyo.currentKeyVersion,
    approvedRules: rules,
    events,
    orderedProductEvents: orderedProducts,
    orders,
    identityEqualPairs: pairs,
    klaviyoSourceChecksum: klaviyo.checksum,
    shopifyEvidenceChecksum: shopify.checksum,
  });

  const fingerprints = deriveFingerprints({
    scope: input.scope,
    klaviyo,
    shopify,
    ruleChecksum: computation.ruleChecksum,
    configChecksum: computation.configChecksum,
  });
  if (
    input.expectedInvocationFingerprint !== undefined &&
    input.expectedInvocationFingerprint !== fingerprints.invocationFingerprint
  ) {
    throw new MatchInputStaleError("invocation_fingerprint_mismatch");
  }

  const expectedOrderIds = shopify.orders.map((order) => order.orderId);
  const expectedEventIds = events.map((event) => event.eventId);
  if (
    computation.orderResults.length !== expectedOrderIds.length ||
    computation.eventResults.length !== expectedEventIds.length
  ) {
    throw new MatchInputStaleError("result_count_mismatch");
  }

  try {
    const published = await publishMatchRun({
      scope: input.scope,
      runId: matchRunId,
      startedAt,
      sourceRunId: input.sourceRunId,
      shopifyEvidenceRunId: input.shopifyEvidenceRunId,
      publicationScopeFingerprint: fingerprints.publicationScopeFingerprint,
      invocationFingerprint: fingerprints.invocationFingerprint,
      computation,
      expectedOrderIds,
      expectedEventIds,
    });
    return {
      runId: published.runId,
      invocationFingerprint: fingerprints.invocationFingerprint,
      replayed: published.replayed,
      counts: {
        orders: computation.orderResults.length,
        events: computation.eventResults.length,
        candidates: computation.candidates.length,
      },
    };
  } catch (error) {
    if (error instanceof MatchInputStaleError) throw error;
    await publishFailedMatchRun({
      scope: input.scope,
      runId: matchRunId,
      startedAt,
      sourceRunId: input.sourceRunId,
      shopifyEvidenceRunId: input.shopifyEvidenceRunId,
      publicationScopeFingerprint: fingerprints.publicationScopeFingerprint,
      invocationFingerprint: fingerprints.invocationFingerprint,
      matcherVersion: MATCHER_VERSION,
      safeFailureCode: "MATCH_PUBLICATION_FAILED",
    }).catch(() => undefined);
    throw error;
  }
}

async function loadEventProducts(
  scope: KlaviyoConnectionScope,
  eventIds: string[],
): Promise<Map<string, Array<{ productId: string | null; variantId: string | null; sku: string | null; quantity: number | null }>>> {
  const map = new Map<
    string,
    Array<{
      productId: string | null;
      variantId: string | null;
      sku: string | null;
      quantity: number | null;
    }>
  >();
  if (eventIds.length === 0) return map;
  const rows = await db
    .select({
      eventId: klaviyoEventProducts.eventId,
      productId: klaviyoEventProducts.productId,
      variantId: klaviyoEventProducts.variantId,
      sku: klaviyoEventProducts.sku,
      quantity: klaviyoEventProducts.quantity,
      sourceOrdinal: klaviyoEventProducts.sourceOrdinal,
    })
    .from(klaviyoEventProducts)
    .where(
      and(
        eq(klaviyoEventProducts.organizationId, scope.organizationId),
        eq(klaviyoEventProducts.storeId, scope.storeId),
        eq(klaviyoEventProducts.connectionId, scope.connectionId),
        inArray(klaviyoEventProducts.eventId, eventIds),
      ),
    )
    .orderBy(asc(klaviyoEventProducts.eventId), asc(klaviyoEventProducts.sourceOrdinal));
  for (const row of rows) {
    const bucket = map.get(row.eventId) ?? [];
    bucket.push({
      productId: row.productId,
      variantId: row.variantId,
      sku: row.sku,
      quantity: row.quantity,
    });
    map.set(row.eventId, bucket);
  }
  return map;
}
