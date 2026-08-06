import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import type {
  EventEvidenceStatus,
  OrderEvidenceStatus,
  ProductMatchStatus,
} from "@/lib/klaviyo/match-types";
import type { KlaviyoConnectionScope } from "@/lib/klaviyo/types";
import { klaviyoEvents, klaviyoMetrics } from "@/schema/klaviyo";
import {
  klaviyoEventMatchResults,
  klaviyoMatchCandidates,
  klaviyoOrderMatchResults,
  klaviyoProductEvidenceLinks,
} from "@/schema/klaviyo-match";
import { shopifyOrders } from "@/schema/shopify";

/**
 * Scoped, read-only order-core evidence queries. Every query is bound by
 * organization + store + connection; none returns HMACs, profile IDs, raw
 * URLs, source property values, or secrets, and none inserts or updates a
 * result row. `not_evaluated` is derived from absent current joins only.
 */

export type HalfOpenUtcWindow = { from: Date; to: Date };

type Cursor = { createdAt: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Cursor;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function boundaryReasonsForOrders(
  scope: KlaviyoConnectionScope,
  orderIds: string[],
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  // Bounded lookup of each entity's latest superseded incident-boundary
  // reason; never revives the old conclusion.
  const rows = await db
    .select({ orderId: klaviyoOrderMatchResults.orderId })
    .from(klaviyoOrderMatchResults)
    .where(
      and(
        eq(klaviyoOrderMatchResults.connectionId, scope.connectionId),
        inArray(klaviyoOrderMatchResults.orderId, orderIds),
        eq(klaviyoOrderMatchResults.supersessionReason, "incident_edge_boundary"),
      ),
    );
  return new Set(rows.map((row) => row.orderId));
}

export type OrderLedgerRow = {
  orderId: string;
  orderName: string | null;
  orderDay: string;
  orderStatus: OrderEvidenceStatus;
  productStatus: ProductMatchStatus | null;
  claimCount: number;
  matchRunId: string | null;
  boundaryWarning: boolean;
};

export async function listEvidenceOrders(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  orderStatus?: OrderEvidenceStatus;
  productStatus?: ProductMatchStatus;
  cursor?: string | null;
  limit?: number;
}): Promise<{ items: OrderLedgerRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const cursor = decodeCursor(input.cursor);
  const conditions = [
    eq(shopifyOrders.organizationId, input.scope.organizationId),
    eq(shopifyOrders.storeId, input.scope.storeId),
    gte(shopifyOrders.orderCreatedAt, input.window.from),
    lt(shopifyOrders.orderCreatedAt, input.window.to),
  ];
  if (cursor) {
    conditions.push(
      sql`(${shopifyOrders.orderCreatedAt}, ${shopifyOrders.id}) <
        (${sql.param(new Date(cursor.createdAt), shopifyOrders.orderCreatedAt)}, ${cursor.id})`,
    );
  }
  if (input.orderStatus === "not_evaluated") {
    conditions.push(isNull(klaviyoOrderMatchResults.id));
  } else if (input.orderStatus) {
    conditions.push(eq(klaviyoOrderMatchResults.status, input.orderStatus));
  }
  if (input.productStatus) {
    conditions.push(
      eq(klaviyoOrderMatchResults.productStatus, input.productStatus),
    );
  }

  const rows = await db
    .select({
      orderId: shopifyOrders.id,
      orderName: shopifyOrders.orderName,
      orderDay: shopifyOrders.orderDay,
      orderCreatedAt: shopifyOrders.orderCreatedAt,
      status: klaviyoOrderMatchResults.status,
      productStatus: klaviyoOrderMatchResults.productStatus,
      claimCount: klaviyoOrderMatchResults.claimCount,
      matchRunId: klaviyoOrderMatchResults.runId,
    })
    .from(shopifyOrders)
    .leftJoin(
      klaviyoOrderMatchResults,
      and(
        eq(klaviyoOrderMatchResults.organizationId, shopifyOrders.organizationId),
        eq(klaviyoOrderMatchResults.storeId, shopifyOrders.storeId),
        eq(klaviyoOrderMatchResults.connectionId, input.scope.connectionId),
        eq(klaviyoOrderMatchResults.orderId, shopifyOrders.id),
        isNull(klaviyoOrderMatchResults.supersededAt),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(shopifyOrders.orderCreatedAt), desc(shopifyOrders.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const boundary = await boundaryReasonsForOrders(
    input.scope,
    page.filter((row) => row.status === null).map((row) => row.orderId),
  );
  const items: OrderLedgerRow[] = page.map((row) => ({
    orderId: row.orderId,
    orderName: row.orderName,
    orderDay: row.orderDay,
    orderStatus: (row.status ?? "not_evaluated") as OrderEvidenceStatus,
    productStatus: (row.productStatus ?? null) as ProductMatchStatus | null,
    claimCount: row.claimCount ?? 0,
    matchRunId: row.matchRunId,
    boundaryWarning: row.status === null && boundary.has(row.orderId),
  }));
  const nextCursor =
    rows.length > limit
      ? encodeCursor({
          createdAt: page[page.length - 1].orderCreatedAt.toISOString(),
          id: page[page.length - 1].orderId,
        })
      : null;
  return { items, nextCursor };
}

export type EvidenceCoverage = {
  orders: Record<string, number>;
  events: Record<string, number>;
  boundaryWarnings: number;
};

export async function loadEvidenceCoverage(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
}): Promise<EvidenceCoverage> {
  const orderRows = await db
    .select({
      status: klaviyoOrderMatchResults.status,
      count: sql<number>`count(*)::int`,
    })
    .from(shopifyOrders)
    .leftJoin(
      klaviyoOrderMatchResults,
      and(
        eq(klaviyoOrderMatchResults.organizationId, shopifyOrders.organizationId),
        eq(klaviyoOrderMatchResults.storeId, shopifyOrders.storeId),
        eq(klaviyoOrderMatchResults.connectionId, input.scope.connectionId),
        eq(klaviyoOrderMatchResults.orderId, shopifyOrders.id),
        isNull(klaviyoOrderMatchResults.supersededAt),
      ),
    )
    .where(
      and(
        eq(shopifyOrders.organizationId, input.scope.organizationId),
        eq(shopifyOrders.storeId, input.scope.storeId),
        gte(shopifyOrders.orderCreatedAt, input.window.from),
        lt(shopifyOrders.orderCreatedAt, input.window.to),
      ),
    )
    .groupBy(klaviyoOrderMatchResults.status);
  const eventRows = await db
    .select({
      status: klaviyoEventMatchResults.status,
      count: sql<number>`count(*)::int`,
    })
    .from(klaviyoEvents)
    .innerJoin(klaviyoMetrics, eq(klaviyoMetrics.id, klaviyoEvents.metricId))
    .leftJoin(
      klaviyoEventMatchResults,
      and(
        eq(klaviyoEventMatchResults.connectionId, klaviyoEvents.connectionId),
        eq(klaviyoEventMatchResults.eventId, klaviyoEvents.id),
        isNull(klaviyoEventMatchResults.supersededAt),
      ),
    )
    .where(
      and(
        eq(klaviyoEvents.organizationId, input.scope.organizationId),
        eq(klaviyoEvents.storeId, input.scope.storeId),
        eq(klaviyoEvents.connectionId, input.scope.connectionId),
        eq(klaviyoMetrics.canonicalKind, "placed_order"),
        gte(klaviyoEvents.occurredAt, input.window.from),
        lt(klaviyoEvents.occurredAt, input.window.to),
      ),
    )
    .groupBy(klaviyoEventMatchResults.status);
  const [boundary] = await db
    .select({ count: sql<number>`count(distinct ${klaviyoOrderMatchResults.orderId})::int` })
    .from(klaviyoOrderMatchResults)
    .where(
      and(
        eq(klaviyoOrderMatchResults.connectionId, input.scope.connectionId),
        eq(
          klaviyoOrderMatchResults.supersessionReason,
          "incident_edge_boundary",
        ),
      ),
    );

  const orders: Record<string, number> = {};
  for (const row of orderRows) {
    orders[row.status ?? "not_evaluated"] =
      (orders[row.status ?? "not_evaluated"] ?? 0) + row.count;
  }
  const events: Record<string, number> = {};
  for (const row of eventRows) {
    events[row.status ?? "not_evaluated"] =
      (events[row.status ?? "not_evaluated"] ?? 0) + row.count;
  }
  return { orders, events, boundaryWarnings: boundary?.count ?? 0 };
}

export type OrderExplanation = {
  orderId: string;
  orderStatus: OrderEvidenceStatus;
  matchRunId: string | null;
  matcherVersion: string | null;
  reasonCodes: string[];
  boundaryWarning: boolean;
  candidates: Array<{
    candidateId: string;
    candidateClass: string;
    method: string;
    score: string;
    confidence: string;
    reasonCodes: string[];
    selected: boolean;
  }>;
};

export async function loadOrderExplanation(input: {
  scope: KlaviyoConnectionScope;
  orderId: string;
}): Promise<OrderExplanation | null> {
  const [order] = await db
    .select({ id: shopifyOrders.id })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, input.scope.organizationId),
        eq(shopifyOrders.storeId, input.scope.storeId),
        eq(shopifyOrders.id, input.orderId),
      ),
    )
    .limit(1);
  if (!order) return null;
  const [result] = await db
    .select({
      id: klaviyoOrderMatchResults.id,
      runId: klaviyoOrderMatchResults.runId,
      status: klaviyoOrderMatchResults.status,
      matcherVersion: klaviyoOrderMatchResults.matcherVersion,
      reasonCodes: klaviyoOrderMatchResults.reasonCodes,
      selectedCandidateId: klaviyoOrderMatchResults.selectedCandidateId,
    })
    .from(klaviyoOrderMatchResults)
    .where(
      and(
        eq(klaviyoOrderMatchResults.organizationId, input.scope.organizationId),
        eq(klaviyoOrderMatchResults.storeId, input.scope.storeId),
        eq(klaviyoOrderMatchResults.connectionId, input.scope.connectionId),
        eq(klaviyoOrderMatchResults.orderId, input.orderId),
        isNull(klaviyoOrderMatchResults.supersededAt),
      ),
    )
    .limit(1);
  if (!result) {
    const boundary = await boundaryReasonsForOrders(input.scope, [input.orderId]);
    return {
      orderId: input.orderId,
      orderStatus: "not_evaluated",
      matchRunId: null,
      matcherVersion: null,
      reasonCodes: [],
      boundaryWarning: boundary.has(input.orderId),
      candidates: [],
    };
  }
  const candidates = await db
    .select({
      id: klaviyoMatchCandidates.id,
      candidateClass: klaviyoMatchCandidates.candidateClass,
      method: klaviyoMatchCandidates.method,
      score: klaviyoMatchCandidates.score,
      confidence: klaviyoMatchCandidates.confidence,
      reasonCodes: klaviyoMatchCandidates.reasonCodes,
    })
    .from(klaviyoMatchCandidates)
    .where(
      and(
        eq(klaviyoMatchCandidates.connectionId, input.scope.connectionId),
        eq(klaviyoMatchCandidates.runId, result.runId),
        eq(klaviyoMatchCandidates.orderId, input.orderId),
      ),
    )
    .orderBy(asc(klaviyoMatchCandidates.id));
  return {
    orderId: input.orderId,
    orderStatus: result.status,
    matchRunId: result.runId,
    matcherVersion: result.matcherVersion,
    reasonCodes: result.reasonCodes,
    boundaryWarning: false,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.id,
      candidateClass: candidate.candidateClass,
      method: candidate.method,
      score: candidate.score,
      confidence: candidate.confidence,
      reasonCodes: candidate.reasonCodes,
      selected: candidate.id === result.selectedCandidateId,
    })),
  };
}

export type OrderProductsResponse =
  | {
      kind: "canonical";
      productStatus: ProductMatchStatus;
      links: Array<{ status: ProductMatchStatus; reasonCodes: string[] }>;
    }
  | { kind: "non_canonical"; orderStatus: OrderEvidenceStatus }
  | {
      kind: "diagnostic";
      matcherVersion: string;
      comparison: unknown;
    }
  | { kind: "not_found" };

export async function loadOrderProducts(input: {
  scope: KlaviyoConnectionScope;
  orderId: string;
  candidateId?: string;
}): Promise<OrderProductsResponse> {
  const [result] = await db
    .select({
      runId: klaviyoOrderMatchResults.runId,
      status: klaviyoOrderMatchResults.status,
      productStatus: klaviyoOrderMatchResults.productStatus,
    })
    .from(klaviyoOrderMatchResults)
    .where(
      and(
        eq(klaviyoOrderMatchResults.organizationId, input.scope.organizationId),
        eq(klaviyoOrderMatchResults.storeId, input.scope.storeId),
        eq(klaviyoOrderMatchResults.connectionId, input.scope.connectionId),
        eq(klaviyoOrderMatchResults.orderId, input.orderId),
        isNull(klaviyoOrderMatchResults.supersededAt),
      ),
    )
    .limit(1);
  if (!result) return { kind: "not_found" };

  if (input.candidateId !== undefined) {
    // The candidate must belong to the requested order AND be reachable
    // through that exact order's unsuperseded current result.
    const [candidate] = await db
      .select({
        featureVector: klaviyoMatchCandidates.featureVector,
      })
      .from(klaviyoMatchCandidates)
      .where(
        and(
          eq(klaviyoMatchCandidates.id, input.candidateId),
          eq(klaviyoMatchCandidates.organizationId, input.scope.organizationId),
          eq(klaviyoMatchCandidates.storeId, input.scope.storeId),
          eq(klaviyoMatchCandidates.connectionId, input.scope.connectionId),
          eq(klaviyoMatchCandidates.orderId, input.orderId),
          eq(klaviyoMatchCandidates.runId, result.runId),
        ),
      )
      .limit(1);
    if (!candidate) return { kind: "not_found" };
    const comparison =
      (candidate.featureVector as Record<string, unknown>)
        .diagnosticProductComparison ?? null;
    // Separately labelled diagnostic projection: stored with the candidate,
    // never recomputed, never carrying a published ProductMatchStatus.
    return {
      kind: "diagnostic",
      matcherVersion: "klaviyo-v1",
      comparison,
    };
  }

  if (result.status !== "confirmed" || result.productStatus === null) {
    return { kind: "non_canonical", orderStatus: result.status };
  }
  const links = await db
    .select({
      status: klaviyoProductEvidenceLinks.status,
      reasonCodes: klaviyoProductEvidenceLinks.reasonCodes,
    })
    .from(klaviyoProductEvidenceLinks)
    .where(
      and(
        eq(klaviyoProductEvidenceLinks.connectionId, input.scope.connectionId),
        eq(klaviyoProductEvidenceLinks.runId, result.runId),
        eq(klaviyoProductEvidenceLinks.shopifyOrderId, input.orderId),
      ),
    );
  return {
    kind: "canonical",
    productStatus: result.productStatus,
    links,
  };
}

export type UnmatchedEventRow = {
  eventId: string;
  occurredAt: Date;
  eventStatus: EventEvidenceStatus;
  boundaryWarning: boolean;
};

export async function listUnmatchedEvents(input: {
  scope: KlaviyoConnectionScope;
  window: HalfOpenUtcWindow;
  eventStatus?: EventEvidenceStatus;
  cursor?: string | null;
  limit?: number;
}): Promise<{ items: UnmatchedEventRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const cursor = decodeCursor(input.cursor);
  const conditions = [
    eq(klaviyoEvents.organizationId, input.scope.organizationId),
    eq(klaviyoEvents.storeId, input.scope.storeId),
    eq(klaviyoEvents.connectionId, input.scope.connectionId),
    eq(klaviyoMetrics.canonicalKind, "placed_order"),
    gte(klaviyoEvents.occurredAt, input.window.from),
    lt(klaviyoEvents.occurredAt, input.window.to),
  ];
  if (cursor) {
    conditions.push(
      sql`(${klaviyoEvents.occurredAt}, ${klaviyoEvents.id}) <
        (${sql.param(new Date(cursor.createdAt), klaviyoEvents.occurredAt)}, ${cursor.id})`,
    );
  }
  if (input.eventStatus === "not_evaluated") {
    conditions.push(isNull(klaviyoEventMatchResults.id));
  } else if (input.eventStatus) {
    conditions.push(eq(klaviyoEventMatchResults.status, input.eventStatus));
  } else {
    // Stable non-confirmed ledger by default.
    conditions.push(
      sql`(${klaviyoEventMatchResults.status} is null
        or ${klaviyoEventMatchResults.status} <> 'confirmed')`,
    );
  }

  const rows = await db
    .select({
      eventId: klaviyoEvents.id,
      occurredAt: klaviyoEvents.occurredAt,
      status: klaviyoEventMatchResults.status,
    })
    .from(klaviyoEvents)
    .innerJoin(klaviyoMetrics, eq(klaviyoMetrics.id, klaviyoEvents.metricId))
    .leftJoin(
      klaviyoEventMatchResults,
      and(
        eq(klaviyoEventMatchResults.connectionId, klaviyoEvents.connectionId),
        eq(klaviyoEventMatchResults.eventId, klaviyoEvents.id),
        isNull(klaviyoEventMatchResults.supersededAt),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(klaviyoEvents.occurredAt), desc(klaviyoEvents.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const notEvaluated = page
    .filter((row) => row.status === null)
    .map((row) => row.eventId);
  const boundaryRows =
    notEvaluated.length === 0
      ? []
      : await db
          .select({ eventId: klaviyoEventMatchResults.eventId })
          .from(klaviyoEventMatchResults)
          .where(
            and(
              eq(
                klaviyoEventMatchResults.connectionId,
                input.scope.connectionId,
              ),
              inArray(klaviyoEventMatchResults.eventId, notEvaluated),
              eq(
                klaviyoEventMatchResults.supersessionReason,
                "incident_edge_boundary",
              ),
            ),
          );
  const boundary = new Set(boundaryRows.map((row) => row.eventId));
  const items: UnmatchedEventRow[] = page.map((row) => ({
    eventId: row.eventId,
    occurredAt: row.occurredAt,
    eventStatus: (row.status ?? "not_evaluated") as EventEvidenceStatus,
    boundaryWarning: row.status === null && boundary.has(row.eventId),
  }));
  const nextCursor =
    rows.length > limit
      ? encodeCursor({
          createdAt: page[page.length - 1].occurredAt.toISOString(),
          id: page[page.length - 1].eventId,
        })
      : null;
  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Plan 4: claims, journeys, and inspector projections.
// ---------------------------------------------------------------------------

import {
  klaviyoAttributionClaims,
  klaviyoClaimReplayStates,
  klaviyoMarketingObjects,
} from "@/schema/klaviyo-claim";
import { buildOrderJourney, loadCanonicalJourneyEvents } from "@/lib/klaviyo/journey";
import type { JourneyLookbackDays } from "@/lib/klaviyo/journey";

type CurrentOrderResult = {
  id: string;
  runId: string;
  status: string;
  selectedCandidateId: string | null;
  selectedEventId: string | null;
  claimCount: number;
};

async function loadCurrentOrderResult(
  scope: KlaviyoConnectionScope,
  orderId: string,
): Promise<CurrentOrderResult | null> {
  const [result] = await db
    .select({
      id: klaviyoOrderMatchResults.id,
      runId: klaviyoOrderMatchResults.runId,
      status: klaviyoOrderMatchResults.status,
      selectedCandidateId: klaviyoOrderMatchResults.selectedCandidateId,
      selectedEventId: klaviyoOrderMatchResults.selectedEventId,
      claimCount: klaviyoOrderMatchResults.claimCount,
    })
    .from(klaviyoOrderMatchResults)
    .where(
      and(
        eq(klaviyoOrderMatchResults.organizationId, scope.organizationId),
        eq(klaviyoOrderMatchResults.storeId, scope.storeId),
        eq(klaviyoOrderMatchResults.connectionId, scope.connectionId),
        eq(klaviyoOrderMatchResults.orderId, orderId),
        isNull(klaviyoOrderMatchResults.supersededAt),
      ),
    )
    .limit(1);
  return result ?? null;
}

/**
 * Resolve an optional per-edge candidate strictly through the requested
 * current scoped result's own run: a candidate from another run, order, or
 * connection is unreachable, and the returned label is always explicitly
 * non-canonical.
 */
async function resolveScopedCandidateEvent(
  scope: KlaviyoConnectionScope,
  result: CurrentOrderResult,
  orderId: string,
  candidateId: string,
): Promise<{ eventId: string } | null> {
  const [candidate] = await db
    .select({ eventId: klaviyoMatchCandidates.eventId })
    .from(klaviyoMatchCandidates)
    .where(
      and(
        eq(klaviyoMatchCandidates.connectionId, scope.connectionId),
        eq(klaviyoMatchCandidates.runId, result.runId),
        eq(klaviyoMatchCandidates.id, candidateId),
        eq(klaviyoMatchCandidates.orderId, orderId),
      ),
    )
    .limit(1);
  return candidate ?? null;
}

export type OrderClaimNode = {
  attributionId: string;
  campaign: { id: string; name: string } | null;
  flow: { id: string; name: string } | null;
  message: { id: string; name: string } | null;
  externalVariationReference: string | null;
  interaction: {
    type: string | null;
    occurredAt: Date | null;
    channel: string | null;
    host: string | null;
    path: string | null;
    botClick: boolean | null;
  } | null;
  unknownReasonCodes: string[];
  fetchedAt: Date;
};

export type OrderClaimsResponse =
  | {
      kind: "none";
      reason: "order_not_evaluated" | "no_conversion_anchor";
    }
  | {
      kind: "canonical" | "diagnostic";
      conversionEventId: string;
      claims: OrderClaimNode[];
      replay: {
        status: string;
        reasonCodes: string[];
        attemptCount: number;
        attemptedAt: Date;
        completedAt: Date | null;
      } | null;
      caveats: string[];
    };

export async function loadOrderClaims(input: {
  scope: KlaviyoConnectionScope;
  orderId: string;
  candidateId?: string | null;
}): Promise<OrderClaimsResponse | null> {
  const result = await loadCurrentOrderResult(input.scope, input.orderId);
  if (!result) return { kind: "none", reason: "order_not_evaluated" };

  let conversionEventId: string | null = null;
  let kind: "canonical" | "diagnostic" = "canonical";
  const caveats: string[] = [];
  if (input.candidateId) {
    const candidate = await resolveScopedCandidateEvent(
      input.scope,
      result,
      input.orderId,
      input.candidateId,
    );
    if (!candidate) return null;
    conversionEventId = candidate.eventId;
    kind = "diagnostic";
    caveats.push("per_edge_diagnostic_non_canonical");
  } else if (result.status === "confirmed" && result.selectedEventId !== null) {
    conversionEventId = result.selectedEventId;
  } else {
    return { kind: "none", reason: "no_conversion_anchor" };
  }

  const rows = await db
    .select({
      attributionId: klaviyoAttributionClaims.klaviyoAttributionId,
      campaignObjectId: klaviyoAttributionClaims.campaignObjectId,
      flowObjectId: klaviyoAttributionClaims.flowObjectId,
      messageObjectId: klaviyoAttributionClaims.messageObjectId,
      externalVariationReference:
        klaviyoAttributionClaims.externalVariationReference,
      interactionType: klaviyoAttributionClaims.interactionType,
      interactionOccurredAt: klaviyoAttributionClaims.interactionOccurredAt,
      interactionChannel: klaviyoAttributionClaims.interactionChannel,
      interactionHost: klaviyoAttributionClaims.interactionHost,
      interactionPath: klaviyoAttributionClaims.interactionPath,
      botClick: klaviyoAttributionClaims.botClick,
      unknownReasonCodes: klaviyoAttributionClaims.unknownReasonCodes,
      fetchedAt: klaviyoAttributionClaims.fetchedAt,
    })
    .from(klaviyoAttributionClaims)
    .where(
      and(
        eq(klaviyoAttributionClaims.connectionId, input.scope.connectionId),
        eq(klaviyoAttributionClaims.conversionEventId, conversionEventId),
      ),
    )
    .orderBy(asc(klaviyoAttributionClaims.klaviyoAttributionId));

  const objectIds = [
    ...new Set(
      rows.flatMap((row) =>
        [row.campaignObjectId, row.flowObjectId, row.messageObjectId].filter(
          (value): value is string => value !== null,
        ),
      ),
    ),
  ];
  const objects = objectIds.length
    ? await db
        .select({
          id: klaviyoMarketingObjects.id,
          name: klaviyoMarketingObjects.name,
        })
        .from(klaviyoMarketingObjects)
        .where(
          and(
            eq(klaviyoMarketingObjects.connectionId, input.scope.connectionId),
            inArray(klaviyoMarketingObjects.id, objectIds),
          ),
        )
    : [];
  const nameById = new Map(objects.map((object) => [object.id, object.name]));
  const named = (id: string | null) =>
    id === null ? null : { id, name: nameById.get(id) ?? "" };

  const [replay] = await db
    .select({
      status: klaviyoClaimReplayStates.status,
      reasonCodes: klaviyoClaimReplayStates.reasonCodes,
      attemptCount: klaviyoClaimReplayStates.attemptCount,
      attemptedAt: klaviyoClaimReplayStates.attemptedAt,
      completedAt: klaviyoClaimReplayStates.completedAt,
    })
    .from(klaviyoClaimReplayStates)
    .where(
      and(
        eq(klaviyoClaimReplayStates.connectionId, input.scope.connectionId),
        eq(klaviyoClaimReplayStates.conversionEventId, conversionEventId),
      ),
    )
    .orderBy(desc(klaviyoClaimReplayStates.attemptedAt))
    .limit(1);
  if (replay && replay.status !== "complete") {
    caveats.push("claims_stale_or_incomplete");
  }

  return {
    kind,
    conversionEventId,
    claims: rows.map((row) => ({
      attributionId: row.attributionId,
      campaign: named(row.campaignObjectId),
      flow: named(row.flowObjectId),
      message: named(row.messageObjectId),
      externalVariationReference: row.externalVariationReference,
      interaction:
        row.interactionType === null &&
        row.interactionHost === null &&
        row.interactionOccurredAt === null
          ? null
          : {
              type: row.interactionType,
              occurredAt: row.interactionOccurredAt,
              channel: row.interactionChannel,
              host: row.interactionHost,
              path: row.interactionPath,
              botClick: row.botClick === null ? null : row.botClick === 1,
            },
      unknownReasonCodes: row.unknownReasonCodes,
      fetchedAt: row.fetchedAt,
    })),
    replay: replay ?? null,
    caveats,
  };
}

export type OrderJourneyResponse =
  | { kind: "none"; reason: "order_not_evaluated" | "no_confirmed_conversion" | "no_profile_relationship" }
  | {
      kind: "journey";
      label: "same_klaviyo_profile";
      events: Array<{
        eventRowId: string;
        metricKind: string | null;
        occurredAt: Date;
      }>;
      clipped: boolean;
      caveats: string[];
    };

/**
 * Confirmed-selected-event-only journey. A candidate ID never expands a
 * journey; candidate, ambiguous, duplicate-conversion, no-event, and
 * not-evaluated orders have none. The profile ID is used only server-side
 * for exact-equality selection and never leaves this projection.
 */
export async function loadOrderJourney(input: {
  scope: KlaviyoConnectionScope;
  orderId: string;
  lookbackDays: JourneyLookbackDays;
}): Promise<OrderJourneyResponse> {
  const result = await loadCurrentOrderResult(input.scope, input.orderId);
  if (!result) return { kind: "none", reason: "order_not_evaluated" };
  if (result.status !== "confirmed" || result.selectedEventId === null) {
    return { kind: "none", reason: "no_confirmed_conversion" };
  }
  const [conversion] = await db
    .select({
      id: klaviyoEvents.id,
      occurredAt: klaviyoEvents.occurredAt,
      profileId: klaviyoEvents.profileId,
    })
    .from(klaviyoEvents)
    .where(
      and(
        eq(klaviyoEvents.connectionId, input.scope.connectionId),
        eq(klaviyoEvents.id, result.selectedEventId),
      ),
    )
    .limit(1);
  if (!conversion || conversion.profileId === null) {
    return { kind: "none", reason: "no_profile_relationship" };
  }
  const lookbackStart = new Date(
    conversion.occurredAt.getTime() - input.lookbackDays * 24 * 60 * 60 * 1000,
  );
  const coverage = await loadCanonicalJourneyEvents({
    scope: input.scope,
    profileId: conversion.profileId,
    from: lookbackStart,
    to: new Date(conversion.occurredAt.getTime() + 1),
  });
  const journey = buildOrderJourney({
    conversion: {
      eventRowId: conversion.id,
      occurredAt: conversion.occurredAt,
      profileId: conversion.profileId,
    },
    attributedInteraction: null,
    profileEvents: coverage.events,
    lookbackDays: input.lookbackDays,
    ingestedFrom: coverage.ingestedFrom ?? conversion.occurredAt,
  });
  const caveats = [...journey.caveats];
  if (coverage.ingestedFrom === null) {
    caveats.push("no_successful_journey_coverage");
  }
  return {
    kind: "journey",
    label: journey.label,
    events: journey.events.map((event) => ({
      eventRowId: event.eventRowId,
      metricKind: event.metricKind,
      occurredAt: event.occurredAt,
    })),
    clipped: journey.clipped,
    caveats,
  };
}

export type OrderInspectorResponse = {
  order: {
    orderId: string;
    orderName: string | null;
    orderDay: string;
    lastClickUtm: {
      source: string | null;
      medium: string | null;
      campaign: string | null;
    };
  };
  result: {
    status: string;
    matchRunId: string;
    claimCount: number;
    selectedEventId: string | null;
  } | null;
  candidateEdge: {
    candidateId: string;
    candidateClass: string;
    method: string;
    score: string;
    confidence: string;
    label: "per_edge_diagnostic_non_canonical";
  } | null;
  conversionEvent: {
    externalEventId: string;
    occurredAt: Date;
    productEvidenceCompleteness: string;
    warnings: string[];
    profile: "present" | "absent";
  } | null;
  caveats: string[];
} | null;

/**
 * Normalized redacted inspector. Never returns the raw Klaviyo payload,
 * full email HMAC, profile ID, full URL/query, arbitrary property data, or
 * the raw Shopify customerJourney JSON — the only Shopify journey material
 * is the allowlisted bounded last-click UTM projection.
 */
export async function loadOrderInspector(input: {
  scope: KlaviyoConnectionScope;
  orderId: string;
  candidateId?: string | null;
}): Promise<OrderInspectorResponse> {
  const [order] = await db
    .select({
      orderId: shopifyOrders.id,
      orderName: shopifyOrders.orderName,
      orderDay: shopifyOrders.orderDay,
      utmSource: shopifyOrders.lastClickUtmSource,
      utmMedium: shopifyOrders.lastClickUtmMedium,
      utmCampaign: shopifyOrders.lastClickUtmCampaign,
    })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, input.scope.organizationId),
        eq(shopifyOrders.storeId, input.scope.storeId),
        eq(shopifyOrders.id, input.orderId),
      ),
    )
    .limit(1);
  if (!order) return null;

  const result = await loadCurrentOrderResult(input.scope, input.orderId);
  const caveats: string[] = [];
  let candidateEdge: NonNullable<OrderInspectorResponse>["candidateEdge"] =
    null;
  let eventRowId: string | null = null;
  if (result && input.candidateId) {
    const [candidate] = await db
      .select({
        id: klaviyoMatchCandidates.id,
        eventId: klaviyoMatchCandidates.eventId,
        candidateClass: klaviyoMatchCandidates.candidateClass,
        method: klaviyoMatchCandidates.method,
        score: klaviyoMatchCandidates.score,
        confidence: klaviyoMatchCandidates.confidence,
      })
      .from(klaviyoMatchCandidates)
      .where(
        and(
          eq(klaviyoMatchCandidates.connectionId, input.scope.connectionId),
          eq(klaviyoMatchCandidates.runId, result.runId),
          eq(klaviyoMatchCandidates.id, input.candidateId),
          eq(klaviyoMatchCandidates.orderId, input.orderId),
        ),
      )
      .limit(1);
    if (!candidate) return null;
    candidateEdge = {
      candidateId: candidate.id,
      candidateClass: candidate.candidateClass,
      method: candidate.method,
      score: String(candidate.score),
      confidence: String(candidate.confidence),
      label: "per_edge_diagnostic_non_canonical",
    };
    eventRowId = candidate.eventId;
    caveats.push("per_edge_diagnostic_non_canonical");
  } else if (result?.selectedEventId) {
    eventRowId = result.selectedEventId;
  }

  let conversionEvent: NonNullable<OrderInspectorResponse>["conversionEvent"] =
    null;
  if (eventRowId !== null) {
    const [event] = await db
      .select({
        externalEventId: klaviyoEvents.externalEventId,
        occurredAt: klaviyoEvents.occurredAt,
        productEvidenceCompleteness: klaviyoEvents.productEvidenceCompleteness,
        warnings: klaviyoEvents.warnings,
        profileId: klaviyoEvents.profileId,
      })
      .from(klaviyoEvents)
      .where(
        and(
          eq(klaviyoEvents.connectionId, input.scope.connectionId),
          eq(klaviyoEvents.id, eventRowId),
        ),
      )
      .limit(1);
    if (event) {
      conversionEvent = {
        externalEventId: event.externalEventId,
        occurredAt: event.occurredAt,
        productEvidenceCompleteness: event.productEvidenceCompleteness,
        warnings: event.warnings,
        profile: event.profileId === null ? "absent" : "present",
      };
    }
  }

  return {
    order: {
      orderId: order.orderId,
      orderName: order.orderName,
      orderDay: order.orderDay,
      lastClickUtm: {
        source: order.utmSource,
        medium: order.utmMedium,
        campaign: order.utmCampaign,
      },
    },
    result: result
      ? {
          status: result.status,
          matchRunId: result.runId,
          claimCount: result.claimCount,
          selectedEventId: result.selectedEventId,
        }
      : null,
    candidateEdge,
    conversionEvent,
    caveats,
  };
}
