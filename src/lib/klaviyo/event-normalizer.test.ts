import { describe, expect, it } from "vitest";
import {
  KLAVIYO_EVENT_MAX_NORMALIZED_BYTES,
  KLAVIYO_EVENT_PAGE_MAX_EVENTS,
  KLAVIYO_EVENT_PAGE_MAX_NORMALIZED_BYTES,
  KLAVIYO_PRODUCT_ITEM_MAX_RAW_KEYS,
  NORMALIZED_PRODUCT_MAX_ITEMS,
  normalizeEventPage,
  type EventAliasRegistry,
} from "@/lib/klaviyo/event-normalizer";
import {
  KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES,
  KLAVIYO_RAW_STRING_MAX_UTF16_UNITS,
} from "@/lib/klaviyo/redaction";

const approvedAliases: EventAliasRegistry = {
  orderId: "OrderId",
  uniqueEventId: "$event_id",
  productId: "ProductID",
  variantId: "VariantID",
  sku: "SKU",
  productName: null,
  variantName: null,
  quantity: "Quantity",
  value: null,
  currency: null,
  items: null,
};

function eventResource(overrides: Record<string, unknown> = {}) {
  return {
    type: "event",
    id: "event-1",
    attributes: {
      datetime: "2026-07-20T10:00:00.000Z",
      uuid: "uuid-1",
      event_properties: {
        OrderId: "gid://shopify/Order/1001",
        $event_id: "provider-1",
        ProductID: "product-1",
        VariantID: "variant-1",
        SKU: "SKU-1",
        Quantity: 2,
      },
    },
    relationships: {
      profile: { data: { type: "profile", id: "profile-1" } },
      metric: { data: { type: "metric", id: "metric-external-1" } },
    },
    ...overrides,
  };
}

function normalizerInput(overrides: Record<string, unknown> = {}) {
  return {
    metricRowId: "metric-row-1",
    externalMetricId: "metric-external-1",
    metricKind: "placed_order" as const,
    apiRevision: "2026-07-15",
    merchantHosts: new Set(["reviv.example.com"]),
    approvedAliases,
    page: {
      data: [eventResource()],
      included: [],
      nextCursor: null,
      apiRevision: "2026-07-15",
    },
    ...overrides,
  };
}

describe("normalizeEventPage", () => {
  it("normalizes a Placed Order without retaining included email", () => {
    const [event] = normalizeEventPage({
      metricRowId: "metric-row-1",
      externalMetricId: "metric-external-1",
      metricKind: "placed_order",
      apiRevision: "2026-07-15",
      merchantHosts: new Set(["reviv.example.com"]),
      approvedAliases,
      page: {
        data: [
          {
            type: "event",
            id: "event-1",
            attributes: {
              datetime: "2026-07-20T10:00:00.000Z",
              uuid: "uuid-1",
              event_properties: {
                OrderId: "gid://shopify/Order/1001",
                $event_id: "provider-1",
                ProductID: "product-1",
                VariantID: "variant-1",
                SKU: "SKU-1",
                Quantity: 2,
              },
            },
            relationships: {
              profile: { data: { type: "profile", id: "profile-1" } },
              metric: { data: { type: "metric", id: "metric-external-1" } },
            },
          },
        ],
        included: [
          {
            type: "profile",
            id: "profile-1",
            attributes: { email: "person@example.com" },
          },
        ],
        nextCursor: null,
        apiRevision: "2026-07-15",
      },
    });

    expect(event).toMatchObject({
      externalEventId: "event-1",
      metricId: "metric-row-1",
      profileId: "profile-1",
      explicitOrderIdCandidate: "gid://shopify/Order/1001",
      providerUniqueIdCandidate: "provider-1",
      productEvidenceCompleteness: "complete",
      products: [
        expect.objectContaining({
          productId: "product-1",
          variantId: "variant-1",
          sku: "SKU-1",
          quantity: 2,
        }),
      ],
    });
    expect(JSON.stringify(event)).not.toContain("person@example.com");
  });

  it("keeps the checksum independent of profile IDs and profile-derived warnings", () => {
    const [validProfile] = normalizeEventPage(normalizerInput());
    const [invalidProfile] = normalizeEventPage(
      normalizerInput({
        page: {
          data: [
            eventResource({
              relationships: {
                profile: {
                  data: { type: "not-profile", id: "person@example.com" },
                },
                metric: {
                  data: { type: "metric", id: "metric-external-1" },
                },
              },
            }),
          ],
          included: [
            {
              type: "profile",
              id: "other-profile",
              attributes: { email: "other@example.com" },
            },
          ],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(validProfile.profileId).toBe("profile-1");
    expect(invalidProfile.profileId).toBeNull();
    expect(invalidProfile.evidence.warnings).toContain(
      "profile_relationship_invalid",
    );
    expect(invalidProfile.sourceChecksum).toBe(validProfile.sourceChecksum);
  });

  it("rejects an event whose provider metric relationship differs", () => {
    expect(() =>
      normalizeEventPage({
        metricRowId: "metric-row-1",
        externalMetricId: "metric-external-1",
        metricKind: "placed_order",
        apiRevision: "2026-07-15",
        merchantHosts: new Set(["reviv.example.com"]),
        approvedAliases,
        page: {
          data: [
            {
              type: "event",
              id: "event-1",
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                event_properties: {},
              },
              relationships: {
                metric: { data: { type: "metric", id: "other-metric" } },
              },
            },
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    ).toThrow();
  });

  it("validates the whole page before returning and requires IDs and timestamps", () => {
    for (const invalidEvent of [
      eventResource({ id: "" }),
      eventResource({ id: undefined }),
      eventResource({
        attributes: { datetime: "not-a-date", event_properties: {} },
      }),
      eventResource({
        attributes: { event_properties: {} },
      }),
      eventResource({
        relationships: {
          metric: { data: { type: "profile", id: "metric-external-1" } },
        },
      }),
      eventResource({ relationships: {} }),
    ]) {
      expect(() =>
        normalizeEventPage(
          normalizerInput({
            page: {
              data: [eventResource({ id: "valid-first" }), invalidEvent],
              included: [],
              nextCursor: null,
              apiRevision: "2026-07-15",
            },
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      normalizeEventPage(
        normalizerInput({
          page: {
            data: [eventResource()],
            included: [],
            nextCursor: null,
            apiRevision: "different-revision",
          },
        }),
      ),
    ).toThrow();
  });

  it("never aliases an encoded provider event ID to its decoded spelling", () => {
    expect(() =>
      normalizeEventPage(
        normalizerInput({
          page: {
            data: [eventResource({ id: "event%2D1" })],
            included: [],
            nextCursor: null,
            apiRevision: "2026-07-15",
          },
        }),
      ),
    ).toThrow("event page is invalid");
    expect(normalizeEventPage(normalizerInput())[0].externalEventId).toBe(
      "event-1",
    );
  });

  it("rejects an encoded external metric ID instead of accepting a rewritten provider ID", () => {
    expect(() =>
      normalizeEventPage(
        normalizerInput({
          externalMetricId: "metric%2Dexternal-1",
          page: {
            data: [
              eventResource({
                relationships: {
                  metric: {
                    data: { type: "metric", id: "metric%2Dexternal-1" },
                  },
                },
              }),
            ],
            included: [],
            nextCursor: null,
            apiRevision: "2026-07-15",
          },
        }),
      ),
    ).toThrow("normalizer input is invalid");
  });

  it("requires exact calendar-valid timestamps with an explicit timezone", () => {
    const invalidTimestamps = [
      "2026-02-29T10:00:00.000Z",
      "2026-04-31T10:00:00.000Z",
      "2026-13-01T10:00:00.000Z",
      "2026-07-20T24:00:00.000Z",
      "2026-07-20T10:60:00.000Z",
      "2026-07-20T10:00:60.000Z",
      "2026-07-20T10:00:00.000",
      "2026-07-20 10:00:00Z",
      "2026-07-20",
    ];
    for (const datetime of invalidTimestamps) {
      expect(() =>
        normalizeEventPage(
          normalizerInput({
            page: {
              data: [
                eventResource({
                  attributes: { datetime, event_properties: {} },
                }),
              ],
              included: [],
              nextCursor: null,
              apiRevision: "2026-07-15",
            },
          }),
        ),
      ).toThrow("event page is invalid");
    }

    const [leapDay] = normalizeEventPage(
      normalizerInput({
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2028-02-29T10:00:00.123456Z",
                event_properties: {},
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );
    const [offset] = normalizeEventPage(
      normalizerInput({
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T18:00:00+08:00",
                event_properties: {},
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(leapDay.occurredAt.toISOString()).toBe("2028-02-29T10:00:00.123Z");
    expect(offset.occurredAt.toISOString()).toBe("2026-07-20T10:00:00.000Z");
  });

  it("maps only approved scalar aliases and never uses the provider metric as its FK", () => {
    const [event] = normalizeEventPage(
      normalizerInput({ metricRowId: "internal-metric-row" }),
    );

    expect(event.metricId).toBe("internal-metric-row");
    expect(event).not.toHaveProperty("externalMetricId");
    expect(event.evidence.values).toEqual({
      $event_id: "provider-1",
      ProductID: "product-1",
      Quantity: 2,
      SKU: "SKU-1",
      VariantID: "variant-1",
    });
  });

  it("normalizes structured Placed Order items and positive integer quantities", () => {
    const aliases: EventAliasRegistry = { ...approvedAliases, items: "Items" };
    const properties = {
      OrderId: "1001",
      Items: [
        { ProductID: "p-1", SKU: "sku-1", Quantity: 1 },
        { ProductID: "p-2", VariantID: "v-2", Quantity: "2" },
      ],
    };
    const [event] = normalizeEventPage(
      normalizerInput({
        approvedAliases: aliases,
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                event_properties: properties,
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(event.productEvidenceCompleteness).toBe("complete");
    expect(event.products).toEqual([
      {
        sourceOrdinal: 0,
        productId: "p-1",
        variantId: null,
        sku: "sku-1",
        productName: null,
        variantName: null,
        quantity: 1,
      },
      {
        sourceOrdinal: 1,
        productId: "p-2",
        variantId: "v-2",
        sku: null,
        productName: null,
        variantName: null,
        quantity: 2,
      },
    ]);
    expect(event.evidence.values).not.toHaveProperty("Items");
  });

  it("marks an explicitly empty Placed Order item collection incomplete", () => {
    const aliases: EventAliasRegistry = { ...approvedAliases, items: "Items" };
    const [event] = normalizeEventPage(
      normalizerInput({
        approvedAliases: aliases,
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                event_properties: { Items: [] },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(event.products).toEqual([]);
    expect(event.productEvidenceCompleteness).toBe("incomplete");
    expect(event.evidence.warnings).toContain("product_evidence_empty_collection");
  });

  it("downgrades malformed, truncated, and absent product evidence", () => {
    const aliases: EventAliasRegistry = { ...approvedAliases, items: "Items" };
    let overflowItemReads = 0;
    const manyItems = Array.from(
      { length: NORMALIZED_PRODUCT_MAX_ITEMS + 1 },
      (_, index) =>
        index === NORMALIZED_PRODUCT_MAX_ITEMS
          ? Object.defineProperty({ Quantity: 1 }, "ProductID", {
              enumerable: true,
              get() {
                overflowItemReads += 1;
                return "must-not-be-read";
              },
            })
          : { ProductID: `p-${index}`, Quantity: 1 },
    );
    const cases = [
      {
        items: [{ ProductID: "good", Quantity: 1 }, { ProductID: "bad", Quantity: 0 }],
        completeness: "incomplete",
        warning: "product_evidence_invalid_item",
      },
      {
        items: manyItems,
        completeness: "incomplete",
        warning: "product_evidence_truncated",
      },
      {
        items: "not-an-array",
        completeness: "incomplete",
        warning: "product_evidence_invalid_collection",
      },
      {
        items: undefined,
        completeness: "unavailable",
        warning: "product_evidence_unavailable",
      },
    ] as const;

    for (const testCase of cases) {
      const eventProperties =
        testCase.items === undefined ? {} : { Items: testCase.items };
      const [event] = normalizeEventPage(
        normalizerInput({
          approvedAliases: aliases,
          page: {
            data: [
              eventResource({
                attributes: {
                  datetime: "2026-07-20T10:00:00.000Z",
                  event_properties: eventProperties,
                },
              }),
            ],
            included: [],
            nextCursor: null,
            apiRevision: "2026-07-15",
          },
        }),
      );
      expect(event.productEvidenceCompleteness).toBe(testCase.completeness);
      expect(event.evidence.warnings).toContain(testCase.warning);
    }
    expect(overflowItemReads).toBe(0);
  });

  it("distinguishes a present null direct product source from an absent source", () => {
    const [presentNull] = normalizeEventPage(
      normalizerInput({
        metricKind: "ordered_product",
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                event_properties: { ProductID: null },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );
    const [absent] = normalizeEventPage(
      normalizerInput({
        metricKind: "ordered_product",
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                event_properties: {},
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(presentNull.productEvidenceCompleteness).toBe("incomplete");
    expect(absent.productEvidenceCompleteness).toBe("unavailable");
  });

  it("normalizes Ordered Product scalar evidence and rejects non-positive quantities", () => {
    const complete = normalizeEventPage(
      normalizerInput({ metricKind: "ordered_product" }),
    )[0];
    expect(complete.productEvidenceCompleteness).toBe("complete");
    expect(complete.products[0]?.quantity).toBe(2);

    for (const quantity of [0, -1, 1.5, "2.0", "nope"]) {
      const [event] = normalizeEventPage(
        normalizerInput({
          metricKind: "ordered_product",
          page: {
            data: [
              eventResource({
                attributes: {
                  datetime: "2026-07-20T10:00:00.000Z",
                  event_properties: { ProductID: "product-1", Quantity: quantity },
                },
              }),
            ],
            included: [],
            nextCursor: null,
            apiRevision: "2026-07-15",
          },
        }),
      );
      expect(event.productEvidenceCompleteness).toBe("incomplete");
      expect(event.products).toEqual([]);
      expect(event.evidence.warnings).toContain("product_evidence_invalid_item");
    }
  });

  it("deduplicates, canonically orders, and caps attribution relationship IDs", () => {
    const attributionData = [
      { type: "attribution", id: "z-last" },
      { type: "attribution", id: "a-first" },
      { type: "attribution", id: "z-last" },
      ...Array.from({ length: 105 }, (_, index) => ({
        type: "attribution",
        id: `id-${String(index).padStart(3, "0")}`,
      })),
    ];
    const [event] = normalizeEventPage(
      normalizerInput({
        page: {
          data: [
            eventResource({
              relationships: {
                metric: {
                  data: { type: "metric", id: "metric-external-1" },
                },
                attributions: { data: attributionData },
              },
            }),
          ],
          included: [
            {
              type: "attribution",
              id: "z-last",
              attributes: { raw: "person@example.com" },
            },
          ],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(event.attributionRelationshipIds).toHaveLength(100);
    expect(event.attributionRelationshipIds).toEqual(
      [...event.attributionRelationshipIds].sort(),
    );
    expect(new Set(event.attributionRelationshipIds).size).toBe(100);
    expect(event.evidence.warnings).toContain(
      "attribution_relationship_truncated",
    );
    expect(JSON.stringify(event)).not.toContain("person@example.com");
  });

  it("accepts only attribution-typed relationships with provider-safe opaque IDs", () => {
    const [event] = normalizeEventPage(
      normalizerInput({
        page: {
          data: [
            eventResource({
              relationships: {
                metric: {
                  data: { type: "metric", id: "metric-external-1" },
                },
                attributions: {
                  data: [
                    { type: "campaign", id: "wrong-type-1" },
                    { type: "attribution", id: "12345678901" },
                    { type: "attribution", id: "unsafe/id" },
                    { type: "attribution", id: "attribution%2Dencoded" },
                    { type: "attribution", id: "attribution-safe-1" },
                  ],
                },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(event.attributionRelationshipIds).toEqual(["attribution-safe-1"]);
    expect(event.evidence.warnings).toContain("attribution_relationship_invalid");
  });

  it("warns when a raw attribution relationship exceeds the cap with duplicates", () => {
    const [event] = normalizeEventPage(
      normalizerInput({
        page: {
          data: [
            eventResource({
              relationships: {
                metric: {
                  data: { type: "metric", id: "metric-external-1" },
                },
                attributions: {
                  data: Array.from({ length: 101 }, () => ({
                    type: "attribution",
                    id: "same-id",
                  })),
                },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(event.attributionRelationshipIds).toEqual(["same-id"]);
    expect(event.evidence.warnings).toContain(
      "attribution_relationship_truncated",
    );
  });

  it("validates and snapshots merchant hosts even for an empty page", () => {
    const invalidHosts = new Set(["reviv.example.com/path"]);
    expect(() =>
      normalizeEventPage(
        normalizerInput({
          merchantHosts: invalidHosts,
          page: {
            data: [],
            included: [],
            nextCursor: null,
            apiRevision: "2026-07-15",
          },
        }),
      ),
    ).toThrow("normalizer input is invalid");
  });

  it("produces a stable recursive checksum independent of JSON key order", () => {
    const forward = normalizerInput();
    const reverse = normalizerInput({
      page: {
        data: [
          eventResource({
            attributes: {
              event_properties: {
                Quantity: 2,
                SKU: "SKU-1",
                VariantID: "variant-1",
                ProductID: "product-1",
                $event_id: "provider-1",
                OrderId: "gid://shopify/Order/1001",
              },
              uuid: "uuid-1",
              datetime: "2026-07-20T10:00:00.000Z",
            },
          }),
        ],
        included: [{ type: "profile", id: "p", attributes: { arbitrary: "changed" } }],
        nextCursor: null,
        apiRevision: "2026-07-15",
      },
    });

    const first = normalizeEventPage(forward)[0];
    const second = normalizeEventPage(reverse)[0];
    expect(first).toEqual(second);
    expect(first.sourceChecksum).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const changed = normalizeEventPage(
      normalizerInput({
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                event_properties: {
                  ...(
                    eventResource().attributes as Record<string, unknown>
                  ).event_properties as Record<string, unknown>,
                  Quantity: 3,
                },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    )[0];
    expect(changed.sourceChecksum).not.toBe(first.sourceChecksum);
  });

  it("redacts identity-shaped scalar content from every persisted output", () => {
    const email = "person@example.com";
    const [event] = normalizeEventPage(
      normalizerInput({
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                uuid: email,
                event_properties: {
                  OrderId: email,
                  ProductID: email,
                  SKU: email,
                  ProductName: email,
                },
              },
              relationships: {
                profile: { data: { type: "profile", id: email } },
                metric: {
                  data: { type: "metric", id: "metric-external-1" },
                },
                attributions: {
                  data: [{ type: "attribution", id: email }],
                },
              },
            }),
          ],
          included: [{ type: "profile", id: email, attributes: { email } }],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(JSON.stringify(event)).not.toContain(email);
  });

  it("drops encoded and credential-shaped persisted fields while preserving commerce IDs", () => {
    const aliases: EventAliasRegistry = {
      ...approvedAliases,
      productName: "ProductName",
    };
    const [safe] = normalizeEventPage(
      normalizerInput({
        metricKind: "ordered_product",
        approvedAliases: aliases,
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                event_properties: {
                  OrderId: "gid://shopify/Order/1001",
                  ProductID: "gid://shopify/Product/1234567890123",
                  SKU: "SKU%20BLUE",
                  ProductName: "Basic Black Dress",
                  Quantity: 1,
                },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );
    expect(safe.explicitOrderIdCandidate).toBe("gid://shopify/Order/1001");
    expect(safe.products[0]).toMatchObject({
      productId: "gid://shopify/Product/1234567890123",
      sku: "SKU%20BLUE",
      productName: "Basic Black Dress",
    });

    const secret = "user%2540example.com";
    const [unsafe] = normalizeEventPage(
      normalizerInput({
        metricKind: "ordered_product",
        approvedAliases: aliases,
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                uuid: "Bearer abcdefghijklmnopqrstuvwxyz",
                event_properties: {
                  OrderId: secret,
                  $event_id: "sk_live_abcdefghijklmnopqrstuvwxyz",
                  ProductID: secret,
                  ProductName: "Contact 用户@例子.公司",
                  Quantity: 1,
                },
              },
              relationships: {
                profile: { data: { type: "profile", id: "unsafe/id" } },
                metric: {
                  data: { type: "metric", id: "metric-external-1" },
                },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );
    expect(JSON.stringify(unsafe)).not.toMatch(
      /example|例子|Bearer|sk_live|unsafe\/id/i,
    );
    expect(unsafe.eventUuid).toBeNull();
    expect(unsafe.profileId).toBeNull();
    expect(unsafe.explicitOrderIdCandidate).toBeNull();
    expect(unsafe.providerUniqueIdCandidate).toBeNull();
    expect(unsafe.productEvidenceCompleteness).toBe("incomplete");
  });

  it("rejects product identifiers that would require whitespace rewriting", () => {
    const [event] = normalizeEventPage(
      normalizerInput({
        metricKind: "ordered_product",
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                event_properties: {
                  ProductID: " product-1 ",
                  Quantity: 1,
                },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(event.products).toEqual([]);
    expect(event.productEvidenceCompleteness).toBe("incomplete");
  });

  it("preserves numeric commerce IDs and literal-percent SKUs exactly", () => {
    const [event] = normalizeEventPage(
      normalizerInput({
        metricKind: "ordered_product",
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                event_properties: {
                  ProductID: "14155552671",
                  SKU: "50%OFF",
                  Quantity: 1,
                },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(event.products).toEqual([
      expect.objectContaining({
        productId: "14155552671",
        sku: "50%OFF",
      }),
    ]);
    expect(event.productEvidenceCompleteness).toBe("complete");
  });

  it("rejects encoded profile IDs without rewriting them", () => {
    const [event] = normalizeEventPage(
      normalizerInput({
        page: {
          data: [
            eventResource({
              relationships: {
                profile: {
                  data: { type: "profile", id: "profile%2Dencoded" },
                },
                metric: {
                  data: { type: "metric", id: "metric-external-1" },
                },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );

    expect(event.profileId).toBeNull();
    expect(JSON.stringify(event)).not.toContain("profile%2Dencoded");
    expect(event.evidence.warnings).toContain("profile_identifier_omitted");
  });

  it("bounds nested item keys and strings before reading or parsing them", () => {
    let oversizedItemReads = 0;
    const oversizedItem: Record<string, unknown> = {};
    for (let index = 0; index <= KLAVIYO_PRODUCT_ITEM_MAX_RAW_KEYS; index += 1) {
      Object.defineProperty(oversizedItem, `item-key-${index}`, {
        enumerable: true,
        get() {
          oversizedItemReads += 1;
          return "must-not-be-read";
        },
      });
    }
    const aliases: EventAliasRegistry = { ...approvedAliases, items: "Items" };
    const [bounded] = normalizeEventPage(
      normalizerInput({
        approvedAliases: aliases,
        page: {
          data: [
            eventResource({
              attributes: {
                datetime: "2026-07-20T10:00:00.000Z",
                event_properties: { Items: [oversizedItem] },
              },
            }),
          ],
          included: [],
          nextCursor: null,
          apiRevision: "2026-07-15",
        },
      }),
    );
    expect(oversizedItemReads).toBe(0);
    expect(bounded.productEvidenceCompleteness).toBe("incomplete");

    const hugeQuantity = "9".repeat(KLAVIYO_RAW_STRING_MAX_UTF16_UNITS + 1);
    expect(() =>
      normalizeEventPage(
        normalizerInput({
          approvedAliases: aliases,
          page: {
            data: [
              eventResource({
                attributes: {
                  datetime: "2026-07-20T10:00:00.000Z",
                  event_properties: {
                    Items: [{ ProductID: "product-1", Quantity: hugeQuantity }],
                  },
                },
              }),
            ],
            included: [],
            nextCursor: null,
            apiRevision: "2026-07-15",
          },
        }),
      ),
    ).toThrow("event page is invalid");
  });

  it("rejects page, property, alias, and aggregate work before returning output", () => {
    let pageResourceReads = 0;
    const oversizedPage = Array.from(
      { length: KLAVIYO_EVENT_PAGE_MAX_EVENTS + 1 },
      (_, index) =>
        Object.defineProperty({}, "type", {
          enumerable: true,
          get() {
            pageResourceReads += 1;
            return index === 0 ? "event" : "event";
          },
        }),
    );
    expect(() =>
      normalizeEventPage(
        normalizerInput({
          page: {
            data: oversizedPage,
            included: [],
            nextCursor: null,
            apiRevision: "2026-07-15",
          },
        }),
      ),
    ).toThrow("event page is invalid");
    expect(pageResourceReads).toBe(0);

    let aliasEventReads = 0;
    const oversizedAlias = "界".repeat(
      Math.floor(KLAVIYO_ALIAS_KEY_MAX_UTF8_BYTES / 3) + 1,
    );
    const aliasPage = {
      data: [
        Object.defineProperty({}, "type", {
          enumerable: true,
          get() {
            aliasEventReads += 1;
            return "event";
          },
        }),
      ],
      included: [],
      nextCursor: null,
      apiRevision: "2026-07-15",
    };
    expect(() =>
      normalizeEventPage(
        normalizerInput({
          approvedAliases: { ...approvedAliases, productName: oversizedAlias },
          page: aliasPage,
        }),
      ),
    ).toThrow("normalizer input is invalid");
    expect(aliasEventReads).toBe(0);

    const largeName = "N".repeat(600);
    const largeItems = Array.from({ length: NORMALIZED_PRODUCT_MAX_ITEMS }, (_, index) => ({
      ProductID: `product-${index}`,
      ProductName: largeName,
      Quantity: 1,
    }));
    const aliases: EventAliasRegistry = {
      ...approvedAliases,
      productName: "ProductName",
      items: "Items",
    };
    expect(() =>
      normalizeEventPage(
        normalizerInput({
          approvedAliases: aliases,
          page: {
            data: [
              eventResource({
                attributes: {
                  datetime: "2026-07-20T10:00:00.000Z",
                  event_properties: { Items: largeItems },
                },
              }),
            ],
            included: [],
            nextCursor: null,
            apiRevision: "2026-07-15",
          },
        }),
      ),
    ).toThrow("event page is invalid");

    const mediumItems = Array.from({ length: 30 }, (_, index) => ({
      ProductID: `product-${index}`,
      ProductName: "M".repeat(300),
      Quantity: 1,
    }));
    const aggregateEvents = Array.from({ length: 40 }, (_, index) =>
      eventResource({
        id: `aggregate-event-${index}`,
        attributes: {
          datetime: "2026-07-20T10:00:00.000Z",
          event_properties: { Items: mediumItems },
        },
      }),
    );
    expect(() =>
      normalizeEventPage(
        normalizerInput({
          approvedAliases: aliases,
          page: {
            data: aggregateEvents,
            included: [],
            nextCursor: null,
            apiRevision: "2026-07-15",
          },
        }),
      ),
    ).toThrow("event page is invalid");
    expect(KLAVIYO_EVENT_MAX_NORMALIZED_BYTES).toBeLessThan(
      KLAVIYO_EVENT_PAGE_MAX_NORMALIZED_BYTES,
    );
  });
});
