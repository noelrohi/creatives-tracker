import { describe, expect, it } from "vitest";
import {
  computeAdvisoryMatches,
  type MatchEventInput,
  type MatchInput,
  type MatchOrderInput,
} from "@/lib/klaviyo/matcher";

const scope = {
  organizationId: "org-1",
  storeId: "store-1",
  connectionId: "connection-1",
};

const RULE = {
  eventKind: "placed_order" as const,
  sourceProperty: "$event_id",
  targetNamespace: "shopify_order_gid",
  canonicalizer: "trimmed_exact" as const,
  candidateSource: "order_id" as const,
};
const UNIQUE_RULE = {
  eventKind: "placed_order" as const,
  sourceProperty: "UniqueEventId",
  targetNamespace: "shopify_order_gid",
  canonicalizer: "trimmed_exact" as const,
  candidateSource: "unique_event_id" as const,
};

const BASE_TIME = new Date("2026-07-20T10:00:00.000Z");

function order(
  orderId: string,
  numericId: string,
  minutesOffset = 0,
  lines: MatchOrderInput["lines"] = [
    {
      shopifyProductId: null,
      shopifyVariantId: "gid://shopify/ProductVariant/1",
      sku: null,
      quantity: 1,
    },
  ],
): MatchOrderInput {
  return {
    orderId,
    shopifyNumericOrderId: numericId,
    orderCreatedAt: new Date(BASE_TIME.getTime() - minutesOffset * 60 * 1000),
    lines,
  };
}

function event(
  eventId: string,
  overrides: Partial<MatchEventInput> = {},
): MatchEventInput {
  return {
    eventId,
    metricKind: "placed_order",
    occurredAt: BASE_TIME,
    explicitOrderIdCandidate: null,
    providerUniqueIdCandidate: null,
    products: [],
    productEvidenceCompleteness: "unavailable",
    ...overrides,
  };
}

function baseInput(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    scope,
    currentIdentityKeyVersion: "v1",
    approvedRules: [RULE],
    events: [],
    orderedProductEvents: [],
    orders: [],
    identityEqualPairs: [],
    klaviyoSourceChecksum: "klaviyo-checksum",
    shopifyEvidenceChecksum: "shopify-checksum",
    ...overrides,
  };
}

describe("computeAdvisoryMatches policy", () => {
  it("confirms one approved explicit order-ID edge with confidence 1", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [event("event-1", { explicitOrderIdCandidate: "1001" })],
        orders: [order("order-1", "1001")],
      }),
    );
    expect(computation.eventResults[0]).toMatchObject({
      status: "confirmed",
      selectedClass: "deterministic",
    });
    expect(computation.orderResults[0]).toMatchObject({
      status: "confirmed",
      selectedEventId: "event-1",
    });
    const edge = computation.candidates.find(
      (candidate) => candidate.candidateClass === "deterministic",
    )!;
    expect(edge.confidence).toBe(1);
  });

  it("joins a GID-stored order to a bare numeric event candidate", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [
          event("event-gid", { explicitOrderIdCandidate: "6892186108118" }),
        ],
        orders: [order("order-gid", "gid://shopify/Order/6892186108118")],
      }),
    );
    expect(computation.eventResults[0]).toMatchObject({
      status: "confirmed",
      selectedClass: "deterministic",
    });
    expect(computation.orderResults[0]).toMatchObject({
      status: "confirmed",
      selectedEventId: "event-gid",
    });
  });

  it("confirms one approved unique-event rule resolving uniquely", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        approvedRules: [UNIQUE_RULE],
        events: [
          event("event-1", { providerUniqueIdCandidate: "1001" }),
        ],
        orders: [order("order-1", "1001")],
      }),
    );
    expect(computation.eventResults[0]).toMatchObject({
      status: "confirmed",
      selectedClass: "deterministic",
    });
    expect(
      computation.candidates.find((c) => c.candidateClass === "deterministic")!
        .confidence,
    ).toBe(1);
  });

  it("stays ambiguous on conflicting deterministic keys regardless of diagnostics", () => {
    // Order-ID rule resolves to order-1 while the unique-event rule resolves
    // to order-2: conflicting deterministic keys.
    const computation = computeAdvisoryMatches(
      baseInput({
        approvedRules: [RULE, UNIQUE_RULE],
        events: [
          event("event-1", {
            explicitOrderIdCandidate: "1001",
            providerUniqueIdCandidate: "2001",
          }),
        ],
        orders: [order("order-1", "1001"), order("order-2", "2001", 4)],
        identityEqualPairs: [{ eventId: "event-1", orderId: "order-2" }],
      }),
    );
    expect(computation.eventResults[0]).toMatchObject({
      status: "ambiguous",
      selectedEdge: null,
    });
    expect(computation.eventResults[0].reasonCodes).toContain(
      "conflicting_deterministic_keys",
    );
  });

  it("scores same-store HMAC plus 4-minute distance as candidate 7/11", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [event("event-1", { occurredAt: BASE_TIME })],
        orders: [order("order-1", "2001", 4)],
        identityEqualPairs: [{ eventId: "event-1", orderId: "order-1" }],
      }),
    );
    const candidate = computation.candidates[0];
    expect(candidate.score).toBe(7);
    expect(candidate.confidence).toBeCloseTo(7 / 11, 10);
    expect(computation.eventResults[0]).toMatchObject({
      status: "candidate",
      selectedClass: "diagnostic",
    });
  });

  it("scores exact variant multiset plus 30-minute distance as candidate 6/11", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [
          event("event-1", {
            products: [
              {
                productId: null,
                variantId: "gid://shopify/ProductVariant/1",
                sku: null,
                quantity: 1,
              },
            ],
            productEvidenceCompleteness: "complete",
          }),
        ],
        orders: [order("order-1", "2001", 30)],
      }),
    );
    const candidate = computation.candidates[0];
    expect(candidate.score).toBe(6);
    expect(candidate.confidence).toBeCloseTo(6 / 11, 10);
    expect(computation.eventResults[0].status).toBe("candidate");
  });

  it("gives partial product plus 23-hour distance score 3 with no eligible edge", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [
          event("event-1", {
            products: [
              { productId: "7", variantId: null, sku: null, quantity: 1 },
              { productId: "9", variantId: null, sku: null, quantity: 1 },
            ],
            productEvidenceCompleteness: "complete",
          }),
        ],
        orders: [
          order("order-1", "2001", 23 * 60, [
            {
              shopifyProductId: "7",
              shopifyVariantId: null,
              sku: null,
              quantity: 1,
            },
          ]),
        ],
      }),
    );
    expect(computation.candidates[0].score).toBe(3);
    expect(computation.eventResults[0].status).toBe("unmatched");
    expect(computation.orderResults[0].status).toBe("no_klaviyo_event");
  });

  it("returns ambiguous with no selected edge on equal top scores", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [event("event-1")],
        orders: [order("order-1", "2001", 4), order("order-2", "3001", 5)],
        identityEqualPairs: [
          { eventId: "event-1", orderId: "order-1" },
          { eventId: "event-1", orderId: "order-2" },
        ],
      }),
    );
    expect(computation.eventResults[0]).toMatchObject({
      status: "ambiguous",
      selectedEdge: null,
    });
    expect(computation.orderResults.map((result) => result.status)).toEqual([
      "ambiguous",
      "ambiguous",
    ]);
  });

  it("marks unmatched events and no-event orders when nothing is eligible", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [event("event-1")],
        orders: [order("order-1", "2001", 10)],
      }),
    );
    expect(computation.eventResults[0].status).toBe("unmatched");
    expect(computation.orderResults[0].status).toBe("no_klaviyo_event");
    expect(computation.candidates).toHaveLength(0);
  });

  it("keeps both event results and marks the order duplicate on double conversion", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [
          event("event-1", { explicitOrderIdCandidate: "1001" }),
          event("event-2", { explicitOrderIdCandidate: "1001" }),
        ],
        orders: [order("order-1", "1001")],
      }),
    );
    expect(
      computation.eventResults.map((result) => result.status),
    ).toEqual(["confirmed", "confirmed"]);
    expect(computation.orderResults[0]).toMatchObject({
      status: "duplicate_conversion_events",
      selectedEdge: null,
      productStatus: null,
    });
  });

  it("caps a perfect diagnostic edge at candidate with confidence at most .99", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [
          event("event-1", {
            products: [
              {
                productId: null,
                variantId: "gid://shopify/ProductVariant/1",
                sku: null,
                quantity: 1,
              },
            ],
            productEvidenceCompleteness: "complete",
          }),
        ],
        orders: [order("order-1", "2001", 4)],
        identityEqualPairs: [{ eventId: "event-1", orderId: "order-1" }],
      }),
    );
    const candidate = computation.candidates[0];
    expect(candidate.score).toBe(11);
    expect(candidate.candidateClass).toBe("diagnostic");
    expect(candidate.confidence).toBeLessThanOrEqual(0.99);
    expect(computation.eventResults[0].status).toBe("candidate");
  });

  it("gives amount zero weight and rejects edges beyond 24 hours", () => {
    const farAway = computeAdvisoryMatches(
      baseInput({
        events: [event("event-1")],
        orders: [order("order-1", "2001", 25 * 60)],
        identityEqualPairs: [{ eventId: "event-1", orderId: "order-1" }],
      }),
    );
    expect(farAway.candidates).toHaveLength(0);
    const scored = computeAdvisoryMatches(
      baseInput({
        events: [event("event-1")],
        orders: [order("order-1", "2001", 4)],
        identityEqualPairs: [{ eventId: "event-1", orderId: "order-1" }],
      }),
    );
    expect(scored.candidates[0].weights.amount).toBe(0);
    expect(scored.candidates[0].featureVector.amount).toBe(0);
  });

  it("keeps product conclusion null for candidate orders", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [
          event("event-1", {
            products: [
              {
                productId: null,
                variantId: "gid://shopify/ProductVariant/1",
                sku: null,
                quantity: 1,
              },
            ],
            productEvidenceCompleteness: "complete",
          }),
        ],
        orders: [order("order-1", "2001", 4)],
      }),
    );
    expect(computation.orderResults[0]).toMatchObject({
      status: "candidate",
      productStatus: null,
    });
  });

  it("associates Ordered Product events only through explicit order IDs", () => {
    const computation = computeAdvisoryMatches(
      baseInput({
        events: [event("event-1", { explicitOrderIdCandidate: "1001" })],
        orderedProductEvents: [
          {
            eventId: "op-1",
            explicitOrderIdCandidate: "gid://shopify/Order/1001",
            products: [
              {
                productId: null,
                variantId: "gid://shopify/ProductVariant/1",
                sku: null,
                quantity: 1,
              },
            ],
          },
          {
            // No explicit order ID: profile/time/product-only association
            // is rejected, so this event never links.
            eventId: "op-2",
            explicitOrderIdCandidate: null,
            products: [
              {
                productId: null,
                variantId: "gid://shopify/ProductVariant/1",
                sku: null,
                quantity: 1,
              },
            ],
          },
        ],
        orders: [order("order-1", "1001")],
      }),
    );
    expect(computation.productLinks).toHaveLength(1);
    expect(computation.productLinks[0]).toMatchObject({
      orderedProductEventId: "op-1",
      placedOrderEventId: "event-1",
      method: "deterministic",
    });
    expect(computation.orderResults[0].productStatus).toBe("exact");
  });

  it("echoes checksums and computes stable rule/config checksums", () => {
    const first = computeAdvisoryMatches(baseInput({}));
    const second = computeAdvisoryMatches(baseInput({}));
    expect(first.klaviyoSourceChecksum).toBe("klaviyo-checksum");
    expect(first.shopifyEvidenceChecksum).toBe("shopify-checksum");
    expect(first.ruleChecksum).toBe(second.ruleChecksum);
    expect(first.configChecksum).toBe(second.configChecksum);
    expect(first.matcherVersion).toBe("klaviyo-v1");
  });
});
