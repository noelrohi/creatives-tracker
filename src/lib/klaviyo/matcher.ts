import { createHash } from "node:crypto";
import {
  DIAGNOSTIC_MAX_DISTANCE_MS,
  DIAGNOSTIC_MAX_SCORE,
  DIAGNOSTIC_MIN_SCORE,
  MATCHER_VERSION,
  type EventMatchStatus,
  type MatchCandidateClass,
  type OrderMatchStatus,
  type ProductMatchStatus,
} from "@/lib/klaviyo/match-types";
import { canonicalizeOrderIdCandidate } from "@/lib/klaviyo/match-normalization";
import {
  compareProducts,
  type KlaviyoProductObservation,
  type ProductComparison,
  type ShopifyLineObservation,
} from "@/lib/klaviyo/product-match";

/**
 * Pure advisory matcher. No database access, no revenue fields, no digest
 * values: identity evidence arrives only as equal-current-version pairs.
 * Deterministic identifiers confirm; diagnostics only rank candidates.
 */

export const MATCH_WEIGHTS = {
  identityEqual: 5,
  productExact: 4,
  productPartial: 2,
  timeClose: 2,
  timeFar: 1,
  amount: 0,
} as const;

export const MATCH_TOLERANCES = {
  timeCloseMs: 60 * 60 * 1000,
  timeMaxMs: DIAGNOSTIC_MAX_DISTANCE_MS,
} as const;

export type MatchEventInput = {
  eventId: string;
  metricKind: "placed_order";
  occurredAt: Date;
  explicitOrderIdCandidate: string | null;
  providerUniqueIdCandidate: string | null;
  products: KlaviyoProductObservation[];
  productEvidenceCompleteness: "complete" | "incomplete" | "unavailable";
};

export type MatchOrderedProductInput = {
  eventId: string;
  explicitOrderIdCandidate: string | null;
  products: KlaviyoProductObservation[];
};

export type MatchOrderInput = {
  orderId: string;
  shopifyNumericOrderId: string;
  orderCreatedAt: Date;
  lines: ShopifyLineObservation[];
};

export type ApprovedJoinRule = {
  eventKind: "placed_order" | "ordered_product";
  sourceProperty: string;
  targetNamespace: string;
  canonicalizer: "shopify_order_gid" | "trimmed_exact";
  /** Which normalized candidate this rule reads (derived from the alias registry). */
  candidateSource: "order_id" | "unique_event_id";
};

export type MatchInput = {
  scope: { organizationId: string; storeId: string; connectionId: string };
  currentIdentityKeyVersion: string | null;
  approvedRules: ApprovedJoinRule[];
  events: MatchEventInput[];
  orderedProductEvents: MatchOrderedProductInput[];
  orders: MatchOrderInput[];
  /** Pairs whose current-version identity digests compared equal. */
  identityEqualPairs: Array<{ eventId: string; orderId: string }>;
  klaviyoSourceChecksum: string;
  shopifyEvidenceChecksum: string;
};

export type MatchCandidateDraft = {
  eventId: string;
  orderId: string;
  candidateClass: MatchCandidateClass;
  method: string;
  featureVector: Record<string, unknown>;
  weights: Record<string, number>;
  tolerances: Record<string, number>;
  score: number;
  confidence: number;
  reasonCodes: string[];
};

export type EventMatchResultDraft = {
  eventId: string;
  status: EventMatchStatus;
  selectedEdge: { eventId: string; orderId: string } | null;
  selectedClass: MatchCandidateClass | null;
  candidateCount: number;
  duplicateWarning: boolean;
  reasonCodes: string[];
};

export type OrderMatchResultDraft = {
  orderId: string;
  status: OrderMatchStatus;
  selectedEdge: { eventId: string; orderId: string } | null;
  selectedClass: MatchCandidateClass | null;
  selectedEventId: string | null;
  productStatus: ProductMatchStatus | null;
  reasonCodes: string[];
};

export type ProductEvidenceLinkDraft = {
  orderedProductEventId: string;
  placedOrderEventId: string;
  shopifyOrderId: string;
  method: "deterministic";
  status: ProductMatchStatus;
  reasonCodes: string[];
};

export type MatchComputation = {
  matcherVersion: typeof MATCHER_VERSION;
  klaviyoSourceChecksum: string;
  shopifyEvidenceChecksum: string;
  ruleChecksum: string;
  configChecksum: string;
  candidates: MatchCandidateDraft[];
  eventResults: EventMatchResultDraft[];
  orderResults: OrderMatchResultDraft[];
  productLinks: ProductEvidenceLinkDraft[];
};

function stableHash(value: unknown): string {
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

function deterministicTargets(
  event: MatchEventInput,
  rules: ApprovedJoinRule[],
  ordersByNumericId: Map<string, MatchOrderInput>,
): Map<string, { orderId: string; sourceProperty: string }[]> {
  // Map of canonical order key -> matched rules for this event.
  const matches = new Map<string, { orderId: string; sourceProperty: string }[]>();
  for (const rule of rules) {
    if (rule.eventKind !== "placed_order") continue;
    const raw =
      rule.candidateSource === "unique_event_id"
        ? event.providerUniqueIdCandidate
        : event.explicitOrderIdCandidate;
    if (raw === null) continue;
    const canonical = canonicalizeOrderIdCandidate(raw);
    if (!canonical || canonical.namespace !== "shopify_order_gid") continue;
    const order = ordersByNumericId.get(canonical.value);
    if (!order) continue;
    const bucket = matches.get(order.orderId) ?? [];
    bucket.push({ orderId: order.orderId, sourceProperty: rule.sourceProperty });
    matches.set(order.orderId, bucket);
  }
  return matches;
}

export function approvedRuleChecksum(rules: ApprovedJoinRule[]): string {
  return stableHash(
    [...rules].sort((a, b) =>
      `${a.eventKind}:${a.sourceProperty}:${a.targetNamespace}`.localeCompare(
        `${b.eventKind}:${b.sourceProperty}:${b.targetNamespace}`,
      ),
    ),
  );
}

export function matcherConfigChecksum(): string {
  return stableHash({
    matcherVersion: MATCHER_VERSION,
    weights: MATCH_WEIGHTS,
    tolerances: MATCH_TOLERANCES,
    minScore: DIAGNOSTIC_MIN_SCORE,
    maxScore: DIAGNOSTIC_MAX_SCORE,
    // Behavior revision: order-side IDs join through the canonical
    // shopify_order_gid namespace, not raw string equality.
    orderIdJoin: "canonical_both_sides@1",
  });
}

export function computeAdvisoryMatches(input: MatchInput): MatchComputation {
  const ruleChecksum = approvedRuleChecksum(input.approvedRules);
  const configChecksum = matcherConfigChecksum();

  // Key orders by the same canonical order-ID namespace the event side
  // uses: a stored full GID and a bare numeric candidate must meet on the
  // numeric value. Non-canonicalizable IDs keep exact raw equality.
  const ordersByNumericId = new Map(
    input.orders.map((order) => {
      const canonical = canonicalizeOrderIdCandidate(order.shopifyNumericOrderId);
      const key =
        canonical !== null && canonical.namespace === "shopify_order_gid"
          ? canonical.value
          : order.shopifyNumericOrderId;
      return [key, order] as const;
    }),
  );
  const ordersById = new Map(input.orders.map((order) => [order.orderId, order]));
  const identityPairs = new Set(
    input.identityEqualPairs.map((pair) => `${pair.eventId}:${pair.orderId}`),
  );

  const candidates: MatchCandidateDraft[] = [];
  const eventResults: EventMatchResultDraft[] = [];
  type Selection = {
    eventId: string;
    orderId: string;
    candidateClass: MatchCandidateClass;
  };
  const selections: Selection[] = [];

  for (const event of input.events) {
    const eventCandidates: MatchCandidateDraft[] = [];

    // Deterministic edges: approved rules resolving into real orders.
    const deterministic = deterministicTargets(
      event,
      input.approvedRules,
      ordersByNumericId,
    );
    for (const [orderId] of deterministic) {
      eventCandidates.push({
        eventId: event.eventId,
        orderId,
        candidateClass: "deterministic",
        method: "approved_join_rule",
        featureVector: {
          namespace: "shopify_order_gid",
          identityKeyVersion: input.currentIdentityKeyVersion,
          identityEqual: identityPairs.has(`${event.eventId}:${orderId}`),
        },
        weights: { deterministic: 1 },
        tolerances: {},
        score: DIAGNOSTIC_MAX_SCORE,
        confidence: 1,
        reasonCodes: ["approved_deterministic_rule"],
      });
    }

    // Diagnostic edges over every order within the time tolerance.
    for (const order of input.orders) {
      if (deterministic.has(order.orderId)) continue;
      const distance = Math.abs(
        event.occurredAt.getTime() - order.orderCreatedAt.getTime(),
      );
      if (distance > MATCH_TOLERANCES.timeMaxMs) continue;
      const identityEqual = identityPairs.has(
        `${event.eventId}:${order.orderId}`,
      );
      const comparison: ProductComparison = compareProducts({
        source:
          event.productEvidenceCompleteness === "complete"
            ? "placed_order_items"
            : "none",
        klaviyoProducts: event.products,
        shopifyLines: order.lines,
      });
      const productContribution =
        comparison.status === "exact"
          ? MATCH_WEIGHTS.productExact
          : comparison.status === "partial"
            ? MATCH_WEIGHTS.productPartial
            : 0;
      // Identity or product presence is required for a diagnostic edge.
      if (!identityEqual && productContribution === 0) continue;
      const timeContribution =
        distance <= MATCH_TOLERANCES.timeCloseMs
          ? MATCH_WEIGHTS.timeClose
          : MATCH_WEIGHTS.timeFar;
      const score =
        (identityEqual ? MATCH_WEIGHTS.identityEqual : 0) +
        productContribution +
        timeContribution;
      const confidence = Math.min(score / DIAGNOSTIC_MAX_SCORE, 0.99);
      eventCandidates.push({
        eventId: event.eventId,
        orderId: order.orderId,
        candidateClass: "diagnostic",
        method: "diagnostic_scoring",
        featureVector: {
          identityEqual,
          identityKeyVersion: identityEqual
            ? input.currentIdentityKeyVersion
            : null,
          timeDistanceMs: distance,
          productStatusContribution: productContribution,
          amount: 0,
          diagnosticProductComparison:
            productContribution > 0
              ? {
                  source: comparison.source,
                  rows: comparison.rows,
                  reasonCodes: comparison.reasonCodes,
                }
              : null,
        },
        weights: { ...MATCH_WEIGHTS },
        tolerances: { ...MATCH_TOLERANCES },
        score,
        confidence,
        reasonCodes: [
          ...(identityEqual ? ["identity_digest_equal"] : []),
          ...(productContribution > 0
            ? [`product_${comparison.status}`]
            : []),
          distance <= MATCH_TOLERANCES.timeCloseMs
            ? "time_close"
            : "time_within_tolerance",
        ],
      });
    }

    candidates.push(...eventCandidates);

    const deterministicEdges = eventCandidates.filter(
      (candidate) => candidate.candidateClass === "deterministic",
    );
    const eligibleDiagnostics = eventCandidates.filter(
      (candidate) =>
        candidate.candidateClass === "diagnostic" &&
        candidate.score >= DIAGNOSTIC_MIN_SCORE,
    );

    if (deterministicEdges.length === 1) {
      eventResults.push({
        eventId: event.eventId,
        status: "confirmed",
        selectedEdge: {
          eventId: event.eventId,
          orderId: deterministicEdges[0].orderId,
        },
        selectedClass: "deterministic",
        candidateCount: eventCandidates.length,
        duplicateWarning: false,
        reasonCodes: ["approved_deterministic_rule"],
      });
      selections.push({
        eventId: event.eventId,
        orderId: deterministicEdges[0].orderId,
        candidateClass: "deterministic",
      });
      continue;
    }
    if (deterministicEdges.length > 1) {
      // Conflicting deterministic keys: ambiguous regardless of diagnostics.
      eventResults.push({
        eventId: event.eventId,
        status: "ambiguous",
        selectedEdge: null,
        selectedClass: null,
        candidateCount: eventCandidates.length,
        duplicateWarning: false,
        reasonCodes: ["conflicting_deterministic_keys"],
      });
      continue;
    }
    if (eligibleDiagnostics.length === 0) {
      eventResults.push({
        eventId: event.eventId,
        status: "unmatched",
        selectedEdge: null,
        selectedClass: null,
        candidateCount: eventCandidates.length,
        duplicateWarning: false,
        reasonCodes: ["no_eligible_edge"],
      });
      continue;
    }
    const topScore = Math.max(
      ...eligibleDiagnostics.map((candidate) => candidate.score),
    );
    const top = eligibleDiagnostics.filter(
      (candidate) => candidate.score === topScore,
    );
    if (top.length > 1) {
      eventResults.push({
        eventId: event.eventId,
        status: "ambiguous",
        selectedEdge: null,
        selectedClass: null,
        candidateCount: eventCandidates.length,
        duplicateWarning: false,
        reasonCodes: ["equal_top_scores"],
      });
      continue;
    }
    eventResults.push({
      eventId: event.eventId,
      status: "candidate",
      selectedEdge: { eventId: event.eventId, orderId: top[0].orderId },
      selectedClass: "diagnostic",
      candidateCount: eventCandidates.length,
      duplicateWarning: false,
      reasonCodes: top[0].reasonCodes,
    });
    selections.push({
      eventId: event.eventId,
      orderId: top[0].orderId,
      candidateClass: "diagnostic",
    });
  }

  // Ordered Product association: deterministic explicit order ID only —
  // profile, time, or product-only association methods are rejected.
  const productLinks: ProductEvidenceLinkDraft[] = [];
  const confirmedEventsByOrder = new Map<string, string[]>();
  for (const result of eventResults) {
    if (result.status !== "confirmed" || result.selectedEdge === null) continue;
    const bucket = confirmedEventsByOrder.get(result.selectedEdge.orderId) ?? [];
    bucket.push(result.eventId);
    confirmedEventsByOrder.set(result.selectedEdge.orderId, bucket);
  }
  const orderedProductsByOrder = new Map<string, MatchOrderedProductInput[]>();
  for (const orderedProduct of input.orderedProductEvents) {
    if (orderedProduct.explicitOrderIdCandidate === null) continue;
    const canonical = canonicalizeOrderIdCandidate(
      orderedProduct.explicitOrderIdCandidate,
    );
    if (!canonical || canonical.namespace !== "shopify_order_gid") continue;
    const order = ordersByNumericId.get(canonical.value);
    if (!order) continue;
    const bucket = orderedProductsByOrder.get(order.orderId) ?? [];
    bucket.push(orderedProduct);
    orderedProductsByOrder.set(order.orderId, bucket);
  }

  // Order results for every evaluated order.
  const orderResults: OrderMatchResultDraft[] = [];
  for (const order of input.orders) {
    const confirmedEvents = confirmedEventsByOrder.get(order.orderId) ?? [];
    if (confirmedEvents.length > 1) {
      orderResults.push({
        orderId: order.orderId,
        status: "duplicate_conversion_events",
        selectedEdge: null,
        selectedClass: null,
        selectedEventId: null,
        productStatus: null,
        reasonCodes: ["duplicate_conversion_events"],
      });
      continue;
    }
    if (confirmedEvents.length === 1) {
      const eventId = confirmedEvents[0];
      const event = input.events.find((entry) => entry.eventId === eventId)!;
      // Product status only after confirmation: prefer a complete Placed
      // Order item array, else explicitly associated Ordered Product events.
      const associated = orderedProductsByOrder.get(order.orderId) ?? [];
      const source =
        event.productEvidenceCompleteness === "complete" &&
        event.products.length > 0
          ? ("placed_order_items" as const)
          : associated.length > 0
            ? ("ordered_product_events" as const)
            : ("none" as const);
      const comparison = compareProducts({
        source,
        klaviyoProducts:
          source === "placed_order_items"
            ? event.products
            : associated.flatMap((entry) => entry.products),
        shopifyLines: order.lines,
      });
      if (source === "ordered_product_events") {
        for (const orderedProduct of associated) {
          productLinks.push({
            orderedProductEventId: orderedProduct.eventId,
            placedOrderEventId: eventId,
            shopifyOrderId: order.orderId,
            method: "deterministic",
            status: comparison.status,
            reasonCodes: comparison.reasonCodes,
          });
        }
      }
      orderResults.push({
        orderId: order.orderId,
        status: "confirmed",
        selectedEdge: { eventId, orderId: order.orderId },
        selectedClass: "deterministic",
        selectedEventId: eventId,
        productStatus: comparison.status,
        reasonCodes: ["approved_deterministic_rule"],
      });
      continue;
    }
    const diagnosticSelection = selections.find(
      (selection) =>
        selection.orderId === order.orderId &&
        selection.candidateClass === "diagnostic",
    );
    if (diagnosticSelection) {
      orderResults.push({
        orderId: order.orderId,
        status: "candidate",
        selectedEdge: {
          eventId: diagnosticSelection.eventId,
          orderId: order.orderId,
        },
        selectedClass: "diagnostic",
        selectedEventId: diagnosticSelection.eventId,
        // Product conclusion stays null for candidate orders.
        productStatus: null,
        reasonCodes: ["diagnostic_candidate"],
      });
      continue;
    }
    const ambiguousEvent = eventResults.some(
      (result) =>
        result.status === "ambiguous" &&
        candidates.some(
          (candidate) =>
            candidate.eventId === result.eventId &&
            candidate.orderId === order.orderId,
        ),
    );
    if (ambiguousEvent) {
      orderResults.push({
        orderId: order.orderId,
        status: "ambiguous",
        selectedEdge: null,
        selectedClass: null,
        selectedEventId: null,
        productStatus: null,
        reasonCodes: ["ambiguous_edges"],
      });
      continue;
    }
    orderResults.push({
      orderId: order.orderId,
      status: "no_klaviyo_event",
      selectedEdge: null,
      selectedClass: null,
      selectedEventId: null,
      productStatus: null,
      reasonCodes: ["no_eligible_edge"],
    });
  }
  void ordersById;

  return {
    matcherVersion: MATCHER_VERSION,
    klaviyoSourceChecksum: input.klaviyoSourceChecksum,
    shopifyEvidenceChecksum: input.shopifyEvidenceChecksum,
    ruleChecksum,
    configChecksum,
    candidates,
    eventResults,
    orderResults,
    productLinks,
  };
}
