import { describe, expect, it } from "vitest";
import {
  assertExactClaimReplayCheckpoint,
  normalizeAttributionClaims,
  normalizeCoarseInteraction,
  normalizeReferencedInteraction,
  sanitizeInteractionUrl,
  type NormalizeClaimsInput,
} from "@/lib/klaviyo/claims";

function claimsInput(
  overrides: Partial<NormalizeClaimsInput> = {},
): NormalizeClaimsInput {
  return {
    conversionEventRowId: "event-row-1",
    conversionExternalEventId: "external-1",
    storedAttributionRelationshipIds: ["attribution-1"],
    storedTruncated: false,
    fetchedEventExternalId: "external-1",
    attributions: [
      {
        type: "attribution",
        id: "attribution-1",
        relationships: {
          campaign: { data: { type: "campaign", id: "campaign-1" } },
          "campaign-message": {
            data: { type: "campaign-message", id: "message-1" },
          },
          "attributed-event": { data: { type: "event", id: "interaction-1" } },
        },
      },
    ],
    apiRevision: "2026-07-15",
    ...overrides,
  };
}

describe("normalizeAttributionClaims", () => {
  it("maps proven relationships and keeps internal/external conversion IDs distinct", () => {
    const result = normalizeAttributionClaims(claimsInput());
    expect(result.complete).toBe(true);
    expect(result.claims).toHaveLength(1);
    const claim = result.claims[0];
    expect(claim.conversionEventRowId).toBe("event-row-1");
    expect(claim.conversionExternalEventId).toBe("external-1");
    expect(claim.marketingRelationships.campaignId).toBe("campaign-1");
    expect(claim.marketingRelationships.messageId).toBe("message-1");
    expect(claim.attributedInteractionEventId).toBe("interaction-1");
    expect(claim.marketingRelationships.flowId).toBeNull();
    expect(claim.marketingRelationships.variationId).toBeNull();
  });

  it("rejects a response for a different conversion event", () => {
    expect(() =>
      normalizeAttributionClaims(
        claimsInput({ fetchedEventExternalId: "external-other" }),
      ),
    ).toThrow("different conversion event");
  });

  it("keeps missing relationships null with reason codes and never invents them", () => {
    const result = normalizeAttributionClaims(
      claimsInput({
        attributions: [{ type: "attribution", id: "attribution-1" }],
      }),
    );
    const claim = result.claims[0];
    expect(claim.marketingRelationships).toEqual({
      campaignId: null,
      flowId: null,
      messageId: null,
      variationId: null,
      externalVariationReference: null,
    });
    expect(claim.unknownReasonCodes).toEqual(
      expect.arrayContaining([
        "marketing_source_unknown",
        "message_unknown",
        "interaction_relationship_unavailable",
      ]),
    );
  });

  it("is incomplete on truncation, missing, unexpected, or duplicated resources", () => {
    expect(
      normalizeAttributionClaims(claimsInput({ storedTruncated: true }))
        .incompleteReasonCodes,
    ).toContain("attribution_relationship_truncated");
    expect(
      normalizeAttributionClaims(
        claimsInput({
          storedAttributionRelationshipIds: ["attribution-1", "attribution-2"],
        }),
      ).incompleteReasonCodes,
    ).toContain("attribution_resource_missing");
    expect(
      normalizeAttributionClaims(
        claimsInput({ storedAttributionRelationshipIds: [] }),
      ).incompleteReasonCodes,
    ).toContain("attribution_resource_unexpected");
    const duplicated = claimsInput();
    duplicated.attributions = [
      ...duplicated.attributions,
      duplicated.attributions[0],
    ];
    expect(
      normalizeAttributionClaims(duplicated).incompleteReasonCodes,
    ).toContain("attribution_resource_duplicated");
  });

  it("keeps a variation only as a redacted external reference", () => {
    const result = normalizeAttributionClaims(
      claimsInput({
        attributions: [
          {
            type: "attribution",
            id: "attribution-1",
            relationships: {
              flow: { data: { type: "flow", id: "flow-1" } },
              "flow-message": {
                data: { type: "flow-message", id: "flow-message-1" },
              },
              "flow-message-variation": {
                data: { type: "flow-message-variation", id: "variation-raw" },
              },
            },
          },
        ],
      }),
    );
    const claim = result.claims[0];
    expect(claim.marketingRelationships.variationId).toBeNull();
    expect(claim.marketingRelationships.externalVariationReference).toBe(
      "variation-raw",
    );
    expect(claim.marketingRelationships.flowId).toBe("flow-1");
  });
});

describe("interaction detail labelling", () => {
  it("labels a proven click with a sanitized host and path", () => {
    const { detail, reasonCodes } = normalizeReferencedInteraction({
      externalEventId: "interaction-1",
      metricKind: "clicked_email",
      occurredAt: new Date("2026-07-20T10:00:00Z"),
      channel: "email",
      url: "https://shop.example.com/products/x?utm_source=klaviyo&email=a@b.com",
      botClick: null,
    });
    expect(detail).toMatchObject({
      interactionType: "click",
      host: "shop.example.com",
      path: "/products/x",
      botClick: null,
    });
    expect(reasonCodes).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain("utm_source");
    expect(JSON.stringify(detail)).not.toContain("a@b.com");
  });

  it("never relabels opens or deliveries as clicks", () => {
    const open = normalizeCoarseInteraction({
      kind: "open",
      occurredAt: null,
      channel: "email",
      botClick: null,
    });
    expect(open.interactionType).toBe("open");
    expect(open.host).toBeNull();
    const delivery = normalizeCoarseInteraction({
      kind: "delivery",
      occurredAt: null,
      channel: "email",
      botClick: true,
    });
    expect(delivery.interactionType).toBe("delivery");
    expect(delivery.botClick).toBe(true);
  });

  it("keeps relationship but unknown detail for disallowed metrics", () => {
    const { detail, reasonCodes } = normalizeReferencedInteraction({
      externalEventId: "interaction-2",
      metricKind: "placed_order",
      occurredAt: null,
      channel: null,
      url: null,
      botClick: null,
    });
    expect(detail).toBeNull();
    expect(reasonCodes).toEqual(["referenced_metric_not_allowlisted"]);
    const unknownMetric = normalizeReferencedInteraction({
      externalEventId: "interaction-3",
      metricKind: null,
      occurredAt: null,
      channel: null,
      url: null,
      botClick: null,
    });
    expect(unknownMetric.detail).toBeNull();
  });

  it("drops unsafe URLs while preserving the interaction", () => {
    const { detail, reasonCodes } = normalizeReferencedInteraction({
      externalEventId: "interaction-4",
      metricKind: "clicked_sms",
      occurredAt: null,
      channel: "sms",
      url: "javascript:alert(1)",
      botClick: false,
    });
    expect(detail).toMatchObject({
      interactionType: "sms",
      host: null,
      path: null,
      botClick: false,
    });
    expect(reasonCodes).toContain("interaction_url_unsafe");
  });
});

describe("sanitizeInteractionUrl", () => {
  it("keeps only safe host and path", () => {
    expect(
      sanitizeInteractionUrl("https://user:pass@shop.example.com/x"),
    ).toBeNull();
    expect(sanitizeInteractionUrl("ftp://shop.example.com/x")).toBeNull();
    expect(sanitizeInteractionUrl("not a url")).toBeNull();
    expect(sanitizeInteractionUrl("https://shop.example.com/a/b")).toEqual({
      host: "shop.example.com",
      path: "/a/b",
    });
  });
});

describe("assertExactClaimReplayCheckpoint", () => {
  const checkpoint = {
    claimReplayId: "graph-1",
    sourceRunId: "source-run-1",
    matchRunId: "match-run-1",
    lookbackCutoff: "2026-08-05T00:00:00.000Z",
    phase: "missing",
    afterOccurredAt: null,
    afterEventRowId: null,
    remainingIncompleteRetries: 5,
    remainingFailedRetries: 5,
    attemptingConversionEventId: null,
    attemptingOccurredAt: null,
    stage: "idle",
  };

  it("accepts the exact closed shape and rejects drift", () => {
    expect(() => assertExactClaimReplayCheckpoint(checkpoint)).not.toThrow();
    expect(() =>
      assertExactClaimReplayCheckpoint({ ...checkpoint, phase: "other" }),
    ).toThrow("malformed");
    expect(() =>
      assertExactClaimReplayCheckpoint({ ...checkpoint, extra: 1 }),
    ).toThrow("malformed");
    expect(() =>
      assertExactClaimReplayCheckpoint({ ...checkpoint, stage: "running" }),
    ).toThrow("malformed");
    expect(() =>
      assertExactClaimReplayCheckpoint({ ...checkpoint, lookbackCutoff: null }),
    ).toThrow("malformed");
    expect(() =>
      assertExactClaimReplayCheckpoint({
        ...checkpoint,
        lookbackCutoff: "not a timestamp",
      }),
    ).toThrow("malformed");
  });
});
