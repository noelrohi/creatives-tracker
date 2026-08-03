import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  IncompleteShopifyLineSetError,
  RetryableShopifyEvidenceRequestError,
  fetchCompleteShopifyOrderLines,
  fetchShopifyIdentityEvidence,
  isRetryableShopifyLineFailure,
  probeShopifyEvidenceCapabilities,
  type ShopifyGraphql,
} from "@/lib/shopify-evidence-admin";
import {
  parseErasureSuppressionKey,
  parseIdentityHmacKeyring,
} from "@/lib/identity-hmac";

const CURRENT_SECRET = Buffer.alloc(32, 4).toString("base64url");
const PREVIOUS_SECRET = Buffer.alloc(32, 5).toString("base64url");
const SUPPRESSION_SECRET = Buffer.alloc(32, 6).toString("base64url");

type GraphqlMockFunction = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<unknown>;
type ShopifyGraphqlMock = ReturnType<typeof vi.fn<GraphqlMockFunction>> &
  ShopifyGraphql;

function mockGraphql(): ShopifyGraphqlMock {
  return vi.fn<GraphqlMockFunction>() as ShopifyGraphqlMock;
}

const keyring = parseIdentityHmacKeyring({
  IDENTITY_HMAC_SECRET: CURRENT_SECRET,
  IDENTITY_HMAC_KEY_VERSION: "v1",
});
const suppressionKey = parseErasureSuppressionKey({
  NODE_ENV: "test",
  IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
  IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
});

function linePage(overrides: Record<string, unknown> = {}) {
  return {
    node: {
      id: "gid://shopify/Order/1",
      updatedAt: "2026-07-31T01:00:00Z",
      lineItems: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      ...overrides,
    },
  };
}

function serializableErrorFields(error: Error): string {
  return JSON.stringify(
    Object.fromEntries(
      Reflect.ownKeys(error).map((key) => [String(key), error[key as keyof Error]]),
    ),
  );
}

describe("fetchCompleteShopifyOrderLines", () => {
  it("assembles every line page before returning a complete set", async () => {
    const graphql = mockGraphql()
      .mockResolvedValueOnce({
        node: {
          id: "gid://shopify/Order/1",
          updatedAt: "2026-07-31T01:00:00Z",
          lineItems: {
            nodes: [
              {
                id: "gid://shopify/LineItem/1",
                product: { id: "gid://shopify/Product/1" },
                variant: { id: "gid://shopify/ProductVariant/1" },
                sku: " SKU-1 ",
                title: "One",
                variantTitle: "Small",
                quantity: 1,
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      })
      .mockResolvedValueOnce({
        node: {
          id: "gid://shopify/Order/1",
          updatedAt: "2026-07-31T01:00:00Z",
          lineItems: {
            nodes: [
              {
                id: "gid://shopify/LineItem/2",
                product: null,
                variant: null,
                sku: "   ",
                title: "Custom item",
                variantTitle: null,
                quantity: 2,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

    const result = await fetchCompleteShopifyOrderLines(
      graphql,
      "gid://shopify/Order/1",
    );

    expect(result).toMatchObject({
      completeness: "complete",
      shopifyOrderId: "gid://shopify/Order/1",
      orderUpdatedAt: new Date("2026-07-31T01:00:00Z"),
    });
    expect(result.lines.map((line) => line.shopifyLineItemId)).toEqual([
      "gid://shopify/LineItem/1",
      "gid://shopify/LineItem/2",
    ]);
    expect(result.lines.map((line) => line.sourcePosition)).toEqual([0, 1]);
    expect(result.lines.map((line) => line.sku)).toEqual(["SKU-1", null]);
    expect(graphql).toHaveBeenNthCalledWith(2, expect.any(String), {
      orderId: "gid://shopify/Order/1",
      cursor: "cursor-1",
    });

    const lineQuery = String(graphql.mock.calls[0][0]);
    expect(lineQuery).toContain("lineItems(first: 250, after: $cursor)");
    expect(lineQuery).not.toContain("email");
    expect(lineQuery).not.toContain("customer {");
  });

  it("allows an empty line set after a complete page", async () => {
    const graphql = mockGraphql().mockResolvedValue(linePage());

    await expect(
      fetchCompleteShopifyOrderLines(graphql, "gid://shopify/Order/1"),
    ).resolves.toMatchObject({ completeness: "complete", lines: [] });
  });

  it("rejects a missing or changed order identity", async () => {
    for (const response of [
      { node: null },
      linePage({ id: "gid://shopify/Order/2" }),
    ]) {
      const graphql = mockGraphql().mockResolvedValue(response);
      await expect(
        fetchCompleteShopifyOrderLines(graphql, "gid://shopify/Order/1"),
      ).rejects.toThrowError(IncompleteShopifyLineSetError);
    }
  });

  it("rejects an invalid or changing order snapshot timestamp", async () => {
    const invalidDate = mockGraphql().mockResolvedValue(
      linePage({ updatedAt: "not-a-date" }),
    );
    await expect(
      fetchCompleteShopifyOrderLines(invalidDate, "gid://shopify/Order/1"),
    ).rejects.toThrow("invalid updatedAt");

    const changingDate = mockGraphql()
      .mockResolvedValueOnce(
        linePage({
          lineItems: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        }),
      )
      .mockResolvedValueOnce(
        linePage({ updatedAt: "2026-07-31T01:00:01Z" }),
      );
    await expect(
      fetchCompleteShopifyOrderLines(changingDate, "gid://shopify/Order/1"),
    ).rejects.toThrow("changed during line pagination");
  });

  it.each([
    ["blank ID", { id: "", quantity: 1 }],
    ["zero quantity", { id: "gid://shopify/LineItem/1", quantity: 0 }],
    ["negative quantity", { id: "gid://shopify/LineItem/1", quantity: -1 }],
    ["fractional quantity", { id: "gid://shopify/LineItem/1", quantity: 1.5 }],
  ])("rejects a line with %s", async (_label, invalidLine) => {
    const graphql = mockGraphql().mockResolvedValue(
      linePage({
        lineItems: {
          nodes: [
            {
              product: null,
              variant: null,
              sku: null,
              title: "Invalid",
              variantTitle: null,
              ...invalidLine,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    );

    await expect(
      fetchCompleteShopifyOrderLines(graphql, "gid://shopify/Order/1"),
    ).rejects.toThrow("invalid or duplicated");
  });

  it("rejects duplicate line IDs within or across pages", async () => {
    const duplicateLine = {
      id: "gid://shopify/LineItem/1",
      product: null,
      variant: null,
      sku: null,
      title: "Duplicate",
      variantTitle: null,
      quantity: 1,
    };
    const withinPage = mockGraphql().mockResolvedValue(
      linePage({
        lineItems: {
          nodes: [duplicateLine, duplicateLine],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    );
    await expect(
      fetchCompleteShopifyOrderLines(withinPage, "gid://shopify/Order/1"),
    ).rejects.toThrow("invalid or duplicated");

    const acrossPages = mockGraphql()
      .mockResolvedValueOnce(
        linePage({
          lineItems: {
            nodes: [duplicateLine],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        }),
      )
      .mockResolvedValueOnce(
        linePage({
          lineItems: {
            nodes: [duplicateLine],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      );
    await expect(
      fetchCompleteShopifyOrderLines(acrossPages, "gid://shopify/Order/1"),
    ).rejects.toThrow("invalid or duplicated");
  });

  it.each([
    ["missing", null],
    ["repeated", "cursor-1"],
  ])("rejects a %s next-page cursor", async (_label, secondCursor) => {
    const graphql = mockGraphql()
      .mockResolvedValueOnce(
        linePage({
          lineItems: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        }),
      )
      .mockResolvedValueOnce(
        linePage({
          lineItems: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: secondCursor },
          },
        }),
      );

    if (secondCursor === null) {
      const firstPageMissing = mockGraphql().mockResolvedValue(
        linePage({
          lineItems: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        }),
      );
      await expect(
        fetchCompleteShopifyOrderLines(
          firstPageMissing,
          "gid://shopify/Order/1",
        ),
      ).rejects.toThrow("cursor did not advance");
    }

    await expect(
      fetchCompleteShopifyOrderLines(graphql, "gid://shopify/Order/1"),
    ).rejects.toThrow("cursor did not advance");
  });

  it.each(["first", "later"] as const)(
    "sanitizes a %s-page provider failure and returns no line set",
    async (failurePage) => {
      const providerText = "remote response leaked-secret-body";
      const graphql = mockGraphql();
      if (failurePage === "later") {
        graphql.mockResolvedValueOnce(
          linePage({
            lineItems: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          }),
        );
      }
      graphql.mockRejectedValueOnce(new Error(providerText));

      let result: Awaited<ReturnType<typeof fetchCompleteShopifyOrderLines>> | undefined;
      let failure: unknown;
      try {
        result = await fetchCompleteShopifyOrderLines(
          graphql,
          "gid://shopify/Order/1",
        );
      } catch (error) {
        failure = error;
      }

      expect(result).toBeUndefined();
      expect(failure).toBeInstanceOf(RetryableShopifyEvidenceRequestError);
      expect(failure).toMatchObject({
        name: "RetryableShopifyEvidenceRequestError",
        message: "Shopify evidence request failed",
      });
      expect(failure).not.toHaveProperty("cause");
      expect(serializableErrorFields(failure as Error)).not.toContain(
        providerText,
      );
    },
  );

  it("classifies transport failures for retry and invalid sets as terminal", () => {
    expect(
      isRetryableShopifyLineFailure(
        new RetryableShopifyEvidenceRequestError(),
      ),
    ).toBe(true);
    expect(
      isRetryableShopifyLineFailure(
        new IncompleteShopifyLineSetError("cursor did not advance"),
      ),
    ).toBe(false);
  });
});

describe("fetchShopifyIdentityEvidence", () => {
  it("returns HMAC-only matching and suppression evidence for both aliases", async () => {
    const rawEmail = "Person@Example.com";
    const rawCustomerId = "gid://shopify/Customer/1";
    const graphql = mockGraphql().mockResolvedValue({
      node: {
        id: "gid://shopify/Order/1",
        email: rawEmail,
        customer: { id: rawCustomerId },
      },
    });

    const result = await fetchShopifyIdentityEvidence({
      graphql,
      shopifyOrderId: "gid://shopify/Order/1",
      scope: { organizationId: "org_a", storeId: "store_a" },
      keyring,
      suppressionKey,
    });

    expect(result.status).toBe("available");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(rawEmail);
    expect(serialized).not.toContain(CURRENT_SECRET);
    expect(serialized).not.toContain(SUPPRESSION_SECRET);
    if (result.status === "available") {
      expect(result.shopifyCustomerId).toBe(rawCustomerId);
      expect(result.digests).toHaveLength(1);
      expect(result.evaluatedKeyVersions).toEqual(["v1"]);
      expect(result.suppressionCandidates.map(({ kind }) => kind)).toEqual([
        "email",
        "shopify_customer_id",
      ]);
      for (const candidate of result.suppressionCandidates) {
        expect(candidate.digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(candidate.digest).not.toContain(rawEmail);
        expect(candidate.digest).not.toContain(rawCustomerId);
      }
    }

    const identityQuery = String(graphql.mock.calls[0][0]);
    expect(identityQuery).toContain("email");
    expect(identityQuery).toContain("customer { id }");
    expect(identityQuery).not.toContain("lineItems");
  });

  it("keeps suppression aliases scoped to the store", async () => {
    const makeGraphql = () =>
      mockGraphql().mockResolvedValue({
        node: {
          id: "gid://shopify/Order/1",
          email: "person@example.com",
          customer: { id: "gid://shopify/Customer/1" },
        },
      });
    const fetchForStore = (storeId: string) =>
      fetchShopifyIdentityEvidence({
        graphql: makeGraphql(),
        shopifyOrderId: "gid://shopify/Order/1",
        scope: { organizationId: "org_a", storeId },
        keyring,
        suppressionKey,
      });

    const [storeA, storeB] = await Promise.all([
      fetchForStore("store_a"),
      fetchForStore("store_b"),
    ]);
    expect(storeA.status).toBe("available");
    expect(storeB.status).toBe("available");
    if (storeA.status === "available" && storeB.status === "available") {
      expect(storeA.suppressionCandidates).not.toEqual(
        storeB.suppressionCandidates,
      );
    }
  });

  it("treats a blank email as present and HMACs both matching domains", async () => {
    const graphql = mockGraphql().mockResolvedValue({
      node: {
        id: "gid://shopify/Order/1",
        email: "",
        customer: null,
      },
    });

    const result = await fetchShopifyIdentityEvidence({
      graphql,
      shopifyOrderId: "gid://shopify/Order/1",
      scope: { organizationId: "org_a", storeId: "store_a" },
      keyring,
      suppressionKey,
    });

    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.digests).toHaveLength(1);
      expect(result.suppressionCandidates).toHaveLength(1);
      expect(result.suppressionCandidates[0].kind).toBe("email");
    }
  });

  it("omits only null protected aliases from suppression candidates", async () => {
    const graphql = mockGraphql().mockResolvedValue({
      node: {
        id: "gid://shopify/Order/1",
        email: null,
        customer: null,
      },
    });

    const result = await fetchShopifyIdentityEvidence({
      graphql,
      shopifyOrderId: "gid://shopify/Order/1",
      scope: { organizationId: "org_a", storeId: "store_a" },
      keyring,
      suppressionKey,
    });

    expect(result).toMatchObject({
      status: "available",
      shopifyCustomerId: null,
      digests: [],
      suppressionCandidates: [],
    });
  });

  it("emits current then previous rotation evidence and key checks", async () => {
    const rotatingKeyring = parseIdentityHmacKeyring({
      IDENTITY_HMAC_SECRET: CURRENT_SECRET,
      IDENTITY_HMAC_KEY_VERSION: "v2",
      IDENTITY_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
      IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v1",
    });
    const graphql = mockGraphql().mockResolvedValue({
      node: {
        id: "gid://shopify/Order/1",
        email: "person@example.com",
        customer: null,
      },
    });

    const result = await fetchShopifyIdentityEvidence({
      graphql,
      shopifyOrderId: "gid://shopify/Order/1",
      scope: { organizationId: "org_a", storeId: "store_a" },
      keyring: rotatingKeyring,
      suppressionKey,
    });

    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.evaluatedKeyVersions).toEqual(["v2", "v1"]);
      expect(result.digests.map(({ keyVersion }) => keyVersion)).toEqual([
        "v2",
        "v1",
      ]);
      expect(
        result.keyChecks.matching.map(({ keyVersion }) => keyVersion),
      ).toEqual(["v2", "v1"]);
    }
  });

  it("uses an immutable deep snapshot of rotating crypto inputs across the protected await", async () => {
    const makeRotatingKeyring = () =>
      parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_KEY_VERSION: "v2",
        IDENTITY_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
        IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v1",
      });
    const makeSuppressionKey = () =>
      parseErasureSuppressionKey({
        NODE_ENV: "test",
        IDENTITY_ERASURE_HMAC_SECRET: SUPPRESSION_SECRET,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      });
    const providerResponse = {
      node: {
        id: "gid://shopify/Order/1",
        email: "snapshot-person@example.com",
        customer: { id: "gid://shopify/Customer/1" },
      },
    };
    let resolveProvider!: (value: unknown) => void;
    const deferredProvider = new Promise<unknown>((resolve) => {
      resolveProvider = resolve;
    });
    const graphql = mockGraphql().mockReturnValue(deferredProvider);
    const params = {
      graphql,
      shopifyOrderId: "gid://shopify/Order/1",
      scope: { organizationId: "org_a", storeId: "store_a" },
      keyring: makeRotatingKeyring(),
      suppressionKey: makeSuppressionKey(),
    };

    const pending = fetchShopifyIdentityEvidence(params);
    expect(graphql).toHaveBeenCalledOnce();

    params.graphql = mockGraphql().mockRejectedValue(
      new Error("mutated GraphQL must not be used"),
    );
    params.shopifyOrderId = "gid://shopify/Order/mutated";
    params.scope.organizationId = "org_mutated";
    params.scope.storeId = "store_mutated";
    params.keyring.current.version = "mutated-current";
    params.keyring.previous!.version = "mutated-previous";
    params.suppressionKey.version = "mutated-suppression";
    params.keyring.current.secret.fill(99);
    params.keyring.previous!.secret.fill(98);
    params.suppressionKey.secret.fill(99);
    resolveProvider(providerResponse);

    const [result, control] = await Promise.all([
      pending,
      fetchShopifyIdentityEvidence({
        graphql: mockGraphql().mockResolvedValue(providerResponse),
        shopifyOrderId: "gid://shopify/Order/1",
        scope: { organizationId: "org_a", storeId: "store_a" },
        keyring: makeRotatingKeyring(),
        suppressionKey: makeSuppressionKey(),
      }),
    ]);

    expect(result).toEqual(control);
    expect(result.status).toBe("available");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("snapshot-person@example.com");
    expect(serialized).not.toContain(CURRENT_SECRET);
    expect(serialized).not.toContain(PREVIOUS_SECRET);
    expect(serialized).not.toContain(SUPPRESSION_SECRET);
    if (result.status === "available") {
      expect(result.evaluatedKeyVersions).toEqual(["v2", "v1"]);
      expect(result.digests.map(({ keyVersion }) => keyVersion)).toEqual([
        "v2",
        "v1",
      ]);
    }
  });

  it.each(["current", "previous"] as const)(
    "rejects suppression-root reuse against the %s matching root before GraphQL",
    async (matchingRoot) => {
      const rotatingKeyring = parseIdentityHmacKeyring({
        IDENTITY_HMAC_SECRET: CURRENT_SECRET,
        IDENTITY_HMAC_KEY_VERSION: "v2",
        IDENTITY_HMAC_PREVIOUS_SECRET: PREVIOUS_SECRET,
        IDENTITY_HMAC_PREVIOUS_KEY_VERSION: "v1",
      });
      const reusedSecret =
        matchingRoot === "current" ? CURRENT_SECRET : PREVIOUS_SECRET;
      const reusedSuppressionKey = parseErasureSuppressionKey({
        NODE_ENV: "test",
        IDENTITY_ERASURE_HMAC_SECRET: reusedSecret,
        IDENTITY_ERASURE_HMAC_KEY_VERSION: "e1",
      });
      const graphql = mockGraphql();

      await expect(
        fetchShopifyIdentityEvidence({
          graphql,
          shopifyOrderId: "gid://shopify/Order/1",
          scope: { organizationId: "org_a", storeId: "store_a" },
          keyring: rotatingKeyring,
          suppressionKey: reusedSuppressionKey,
        }),
      ).rejects.toThrow("root key material must be independent");
      expect(graphql).not.toHaveBeenCalled();
    },
  );

  it("rejects structurally invalid snapshot input before GraphQL", async () => {
    const graphql = mockGraphql();
    const invalidParams = {
      graphql,
      shopifyOrderId: "gid://shopify/Order/1",
      scope: { organizationId: 42, storeId: "store_a" },
      keyring,
      suppressionKey,
    } as unknown as Parameters<typeof fetchShopifyIdentityEvidence>[0];

    await expect(fetchShopifyIdentityEvidence(invalidParams)).rejects.toThrow(
      "Invalid Shopify identity evidence input",
    );
    expect(graphql).not.toHaveBeenCalled();
  });

  it("degrades provider failures without exposing provider text", async () => {
    const providerText = "Access denied for customer field: sensitive-detail";
    const graphql = mockGraphql().mockRejectedValue(new Error(providerText));

    const result = await fetchShopifyIdentityEvidence({
      graphql,
      shopifyOrderId: "gid://shopify/Order/1",
      scope: { organizationId: "org_a", storeId: "store_a" },
      keyring,
      suppressionKey,
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "protected_identity_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(providerText);
  });

  it("degrades missing, wrong-order, and malformed protected responses", async () => {
    const responses = [
      { node: null },
      {
        node: {
          id: "gid://shopify/Order/2",
          email: "person@example.com",
          customer: null,
        },
      },
      {
        node: {
          id: "gid://shopify/Order/1",
          email: 42,
          customer: null,
        },
      },
    ];

    for (const response of responses) {
      const graphql = mockGraphql().mockResolvedValue(response);
      await expect(
        fetchShopifyIdentityEvidence({
          graphql,
          shopifyOrderId: "gid://shopify/Order/1",
          scope: { organizationId: "org_a", storeId: "store_a" },
          keyring,
          suppressionKey,
        }),
      ).resolves.toEqual({
        status: "unavailable",
        reason: "protected_identity_unavailable",
      });
    }
  });
});

describe("probeShopifyEvidenceCapabilities", () => {
  it("keeps raw scope handles in memory and outside the persisted Trigger boundary", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "trigger/shopify-evidence-sync.ts"),
      "utf8",
    );
    expect(source).not.toContain("capabilities.scopes");
    expect(source).not.toContain("scopes:");
    expect(source).not.toContain("logger.info(capabilities");
  });

  it("distinguishes exact order, historical, and identity scope handles", async () => {
    const graphql = mockGraphql().mockResolvedValue({
      currentAppInstallation: {
        accessScopes: [
          { handle: "read_orders" },
          { handle: "read_all_orders" },
          { handle: "read_customers" },
          { handle: "read_orders_extra" },
        ],
      },
    });

    await expect(probeShopifyEvidenceCapabilities(graphql)).resolves.toEqual({
      orderScope: "available",
      historicalOrders: "available",
      identityScope: "declared",
      scopes: [
        "read_orders",
        "read_all_orders",
        "read_customers",
        "read_orders_extra",
      ],
    });
    expect(String(graphql.mock.calls[0][0])).toContain(
      "currentAppInstallation",
    );
    expect(String(graphql.mock.calls[0][0])).not.toContain("lineItems");
    expect(String(graphql.mock.calls[0][0])).not.toContain("email");
  });

  it("reports missing read_all_orders as unavailable without throwing", async () => {
    const graphql = mockGraphql().mockResolvedValue({
      currentAppInstallation: {
        accessScopes: [{ handle: "read_orders" }],
      },
    });

    await expect(probeShopifyEvidenceCapabilities(graphql)).resolves.toEqual({
      orderScope: "available",
      historicalOrders: "unavailable",
      identityScope: "missing",
      scopes: ["read_orders"],
    });
  });

  it("does not treat read_customers as proof that identity is readable", async () => {
    const graphql = mockGraphql().mockResolvedValue({
      currentAppInstallation: {
        accessScopes: [{ handle: "read_customers" }],
      },
    });

    await expect(probeShopifyEvidenceCapabilities(graphql)).resolves.toEqual({
      orderScope: "unavailable",
      historicalOrders: "unavailable",
      identityScope: "declared",
      scopes: ["read_customers"],
    });
  });

  it("fails closed for resolved missing installation and malformed scopes", async () => {
    const graphqlFunctions = [
      mockGraphql().mockResolvedValue({
        currentAppInstallation: null,
      }),
      mockGraphql().mockResolvedValue({
        currentAppInstallation: { accessScopes: [{ handle: 42 }, null] },
      }),
    ];

    for (const graphql of graphqlFunctions) {
      await expect(probeShopifyEvidenceCapabilities(graphql)).resolves.toEqual({
        orderScope: "unavailable",
        historicalOrders: "unavailable",
        identityScope: "missing",
        scopes: [],
      });
    }
  });

  it("fails closed for explicit provider access denial without leaking details", async () => {
    const sensitiveText = "Access denied: protected provider detail";
    const accessErrors = [
      new Error(sensitiveText),
      Object.assign(new Error("opaque GraphQL denial"), {
        name: "ShopifyGraphqlError",
        errors: [
          {
            message: "protected scope detail",
            extensions: { code: "ACCESS_DENIED" },
          },
        ],
      }),
      Object.assign(new Error("opaque HTTP response"), {
        status: 403,
        statusText: "Forbidden",
      }),
    ];

    for (const accessError of accessErrors) {
      const result = await probeShopifyEvidenceCapabilities(
        mockGraphql().mockRejectedValue(accessError),
      );
      expect(result).toEqual({
        orderScope: "unavailable",
        historicalOrders: "unavailable",
        identityScope: "missing",
        scopes: [],
      });
      expect(JSON.stringify(result)).not.toContain(sensitiveText);
    }
  });

  it.each([
    "network reset with private endpoint",
    "request timed out with secret response",
    "request timed out after 403 ms",
    "getaddrinfo ENOTFOUND forbidden.example",
    "upstream 500 body mentioned Unauthorized user state",
    "Shopify Admin API returned 503 private body",
    "generic remote failure private body",
  ])("sanitizes and rethrows transient probe failure: %s", async (providerText) => {
    let failure: unknown;
    try {
      await probeShopifyEvidenceCapabilities(
        mockGraphql().mockRejectedValue(new Error(providerText)),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RetryableShopifyEvidenceRequestError);
    expect(failure).toMatchObject({
      message: "Shopify evidence request failed",
    });
    expect(failure).not.toHaveProperty("cause");
    expect(serializableErrorFields(failure as Error)).not.toContain(
      providerText,
    );
  });
});
