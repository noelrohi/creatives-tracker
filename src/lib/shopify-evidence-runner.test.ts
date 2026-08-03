import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  IncompleteShopifyLineSetError,
  type CompleteShopifyLineSet,
  type NormalizedShopifyIdentityEvidence,
  type ShopifyGraphql,
} from "@/lib/shopify-evidence-admin";
import {
  computeIdentityCryptoKeyChecks,
  type ErasureSuppressionKey,
  type IdentityHmacKeyring,
} from "@/lib/identity-hmac";
import {
  runShopifyEvidenceBatch,
  type ShopifyEvidenceRunnerDependencies,
} from "@/lib/shopify-evidence-runner";
import type {
  EvidenceOrderBatch,
  EvidenceOrderCursor,
} from "@/lib/shopify-evidence-store";

const NOW = new Date("2026-07-31T01:00:00Z");
const ZERO_COUNTS = {
  ordersRead: 0,
  ordersEnriched: 0,
  ordersPartial: 0,
  ordersUnavailable: 0,
  warnings: 0,
  failures: 0,
};
const PAYLOAD = {
  organizationId: "org_a",
  storeId: "store_a",
  from: new Date("2026-05-02T00:00:00Z"),
  to: new Date("2026-08-01T00:00:00Z"),
  runId: "run_a",
  cursor: null,
  counts: ZERO_COUNTS,
  identityCapability: "unknown" as const,
  lineCompleteness: "unknown" as const,
};
const ORDER = {
  id: "order_internal_1",
  shopifyOrderId: "gid://shopify/Order/1",
  orderCreatedAt: NOW,
};
const ORDER_CURSOR = {
  orderCreatedAt: NOW,
  id: ORDER.id,
};
const KEYRING: IdentityHmacKeyring = {
  current: { version: "matching-v2", secret: new Uint8Array(32).fill(1) },
};
const ROTATING_KEYRING: IdentityHmacKeyring = {
  current: KEYRING.current,
  previous: { version: "matching-v1", secret: new Uint8Array(32).fill(2) },
};
const SUPPRESSION_KEY: ErasureSuppressionKey = {
  version: "erasure-v1",
  secret: new Uint8Array(32).fill(3),
};

type GraphqlMockFunction = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<unknown>;
type ShopifyGraphqlMock = ReturnType<typeof vi.fn<GraphqlMockFunction>> &
  ShopifyGraphql;

type MakeDepsOptions = {
  storedDomain?: string;
  configuredShopDomain?: string;
  keyring?: IdentityHmacKeyring;
  keyringError?: Error;
  suppressionKey?: ErasureSuppressionKey;
  suppressionKeyError?: Error;
  cryptoPolicyError?: Error;
  lineError?: Error;
  identityStatus?: NormalizedShopifyIdentityEvidence["status"];
  identityError?: Error;
  orders?: EvidenceOrderBatch["orders"];
  nextCursor?: EvidenceOrderCursor | null;
  commitError?: Error;
};

function completeLines(shopifyOrderId: string): CompleteShopifyLineSet {
  return {
    completeness: "complete",
    shopifyOrderId,
    orderUpdatedAt: NOW,
    lines: [
      {
        shopifyLineItemId: `${shopifyOrderId}/LineItem/1`,
        shopifyProductId: "gid://shopify/Product/1",
        shopifyVariantId: "gid://shopify/ProductVariant/1",
        sku: "SKU-1",
        productTitle: "Product one",
        variantTitle: "Default",
        quantity: 1,
        sourcePosition: 0,
      },
    ],
  };
}

function availableIdentity(
  keyring = KEYRING,
  suppressionKey = SUPPRESSION_KEY,
): NormalizedShopifyIdentityEvidence {
  return {
    status: "available",
    shopifyCustomerId: "gid://shopify/Customer/1",
    digests: [
      {
        keyVersion: keyring.current.version,
        digest: "matching-digest",
        rotationState: "active",
      },
    ],
    suppressionCandidates: [
      {
        kind: "email",
        keyVersion: suppressionKey.version,
        digest: "email-suppression-digest",
      },
      {
        kind: "shopify_customer_id",
        keyVersion: suppressionKey.version,
        digest: "customer-suppression-digest",
      },
    ],
    keyChecks: computeIdentityCryptoKeyChecks({
      scope: {
        organizationId: PAYLOAD.organizationId,
        storeId: PAYLOAD.storeId,
      },
      keyring,
      suppressionKey,
    }),
    evaluatedKeyVersions: [keyring.current.version],
  };
}

function makeDeps(options: MakeDepsOptions = {}) {
  const keyring = options.keyring ?? KEYRING;
  const suppressionKey = options.suppressionKey ?? SUPPRESSION_KEY;
  const graphql = vi.fn<GraphqlMockFunction>() as ShopifyGraphqlMock;
  const loadKeyring = vi.fn(() => {
    if (options.keyringError) throw options.keyringError;
    return keyring;
  });
  const loadSuppressionKey = vi.fn(() => {
    if (options.suppressionKeyError) throw options.suppressionKeyError;
    return suppressionKey;
  });
  const ensureCryptoPolicy = vi.fn<
    ShopifyEvidenceRunnerDependencies["ensureCryptoPolicy"]
  >(async ({ keyChecks }) => {
    if (options.cryptoPolicyError) throw options.cryptoPolicyError;
    if (keyChecks.matching.length !== 1) {
      throw new Error("identity_crypto_policy_conflict");
    }
  });
  const loadStore = vi.fn(async () => ({
    shopDomain: options.storedDomain ?? "store.myshopify.com",
  }));
  const listOrderBatch = vi.fn(async (): Promise<EvidenceOrderBatch> => ({
    orders: options.orders ?? [ORDER],
    nextCursor: options.nextCursor ?? null,
  }));
  const fetchLines = vi.fn(async (_graphql, shopifyOrderId: string) => {
    if (options.lineError) throw options.lineError;
    return completeLines(shopifyOrderId);
  });
  const fetchIdentity = vi.fn(async () => {
    if (options.identityError) throw options.identityError;
    return options.identityStatus === "unavailable"
      ? ({
          status: "unavailable",
          reason: "protected_identity_unavailable",
        } as const)
      : availableIdentity(keyring, suppressionKey);
  });
  const commitOrder = vi.fn<ShopifyEvidenceRunnerDependencies["commitOrder"]>(
    async () => {
      if (options.commitError) throw options.commitError;
      return {
        observedContentChecksum: "content-checksum",
        identityHmacId: "identity_hmac_1",
      };
    },
  );

  return {
    configuredShopDomain:
      options.configuredShopDomain ?? "store.myshopify.com",
    loadKeyring,
    loadSuppressionKey,
    ensureCryptoPolicy,
    loadStore,
    graphql,
    listOrderBatch,
    fetchLines,
    fetchIdentity,
    commitOrder,
  } satisfies ShopifyEvidenceRunnerDependencies;
}

function expectNoEvidenceCallsOrWrites(
  deps: ReturnType<typeof makeDeps>,
): void {
  expect(deps.graphql).not.toHaveBeenCalled();
  expect(deps.listOrderBatch).not.toHaveBeenCalled();
  expect(deps.fetchLines).not.toHaveBeenCalled();
  expect(deps.fetchIdentity).not.toHaveBeenCalled();
  expect(deps.commitOrder).not.toHaveBeenCalled();
}

describe("runShopifyEvidenceBatch", () => {
  it("returns committed partial progress without reopening dependencies after a crash", async () => {
    const committedCursor = {
      orderCreatedAt: new Date("2026-07-30T01:00:00Z"),
      id: "order_internal_0",
    };
    const counts = {
      ordersRead: 8,
      ordersEnriched: 7,
      ordersPartial: 2,
      ordersUnavailable: 1,
      warnings: 1,
      failures: 1,
    };
    const deps = makeDeps({
      keyringError: new Error("later key configuration changed"),
    });

    const result = await runShopifyEvidenceBatch(
      {
        ...PAYLOAD,
        cursor: committedCursor,
        counts,
        identityCapability: "available",
        lineCompleteness: "partial",
      },
      deps,
    );

    expect(result).toEqual({
      kind: "terminal",
      status: "partial",
      nextCursor: null,
      committedCursor,
      counts,
      identityCapability: "available",
      lineCompleteness: "partial",
    });
    expect(result.counts).not.toBe(counts);
    expect(deps.loadKeyring).not.toHaveBeenCalled();
    expect(deps.loadSuppressionKey).not.toHaveBeenCalled();
    expect(deps.loadStore).not.toHaveBeenCalled();
    expect(deps.ensureCryptoPolicy).not.toHaveBeenCalled();
    expectNoEvidenceCallsOrWrites(deps);
  });

  it("stays isolated from monetary Shopify ingestion", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/shopify-evidence-runner.ts"),
      "utf8",
    );

    for (const forbiddenBoundary of [
      "ingestOrderNodes",
      "stampBuckets",
      "upsertShopifyStore",
      "startSyncRun",
      "finishSyncRun",
      "shopifyOrders.netSales",
      "shopifyRefunds",
    ]) {
      expect(source).not.toContain(forbiddenBoundary);
    }
  });

  it("fails a domain mismatch before a remote call or write", async () => {
    const deps = makeDeps({ storedDomain: "other.myshopify.com" });
    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
      "configured Shopify domain does not match the scoped store",
    );
    expect(deps.ensureCryptoPolicy).not.toHaveBeenCalled();
    expectNoEvidenceCallsOrWrites(deps);
  });

  it("compares configured and stored domains case-insensitively after trimming", async () => {
    const deps = makeDeps({
      configuredShopDomain: "  STORE.MYSHOPIFY.COM ",
      storedDomain: " store.myshopify.com ",
    });

    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).resolves.toMatchObject({
      kind: "terminal",
      status: "success",
    });
    expect(deps.commitOrder).toHaveBeenCalledOnce();
  });

  it("fails invalid HMAC configuration before a remote call or write", async () => {
    const deps = makeDeps({
      keyringError: new Error("IDENTITY_HMAC_SECRET is required"),
    });
    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
      "IDENTITY_HMAC_SECRET is required",
    );
    expect(deps.loadSuppressionKey).not.toHaveBeenCalled();
    expect(deps.loadStore).not.toHaveBeenCalled();
    expectNoEvidenceCallsOrWrites(deps);
  });

  it("fails invalid suppression configuration before a remote call or write", async () => {
    const deps = makeDeps({
      suppressionKeyError: new Error(
        "IDENTITY_ERASURE_HMAC_SECRET is required",
      ),
    });

    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
      "IDENTITY_ERASURE_HMAC_SECRET is required",
    );
    expect(deps.loadStore).not.toHaveBeenCalled();
    expectNoEvidenceCallsOrWrites(deps);
  });

  it.each([
    ["current", ROTATING_KEYRING.current.secret],
    ["previous", ROTATING_KEYRING.previous!.secret],
  ])(
    "rejects suppression-root reuse against the %s matching root before policy or evidence calls",
    async (_label, secret) => {
      const deps = makeDeps({
        keyring: ROTATING_KEYRING,
        suppressionKey: {
          version: "erasure-v1",
          secret: secret.slice(),
        },
      });

      await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
        "Identity HMAC root key material must be independent",
      );
      expect(deps.ensureCryptoPolicy).not.toHaveBeenCalled();
      expectNoEvidenceCallsOrWrites(deps);
    },
  );

  it("fails a stored key-check mismatch before an order page or provider call", async () => {
    const deps = makeDeps({
      cryptoPolicyError: new Error(
        "Identity crypto key version is already bound to different key material",
      ),
    });

    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
      "Identity crypto key version is already bound to different key material",
    );
    expect(deps.ensureCryptoPolicy).toHaveBeenCalledOnce();
    expectNoEvidenceCallsOrWrites(deps);
  });

  it("rejects a valid previous matching key before an order page or provider call", async () => {
    const deps = makeDeps({ keyring: ROTATING_KEYRING });

    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
      "identity_crypto_policy_conflict",
    );
    expect(deps.ensureCryptoPolicy).toHaveBeenCalledOnce();
    expectNoEvidenceCallsOrWrites(deps);
  });

  it("derives non-secret key checks for the exact tenant before reading orders", async () => {
    const deps = makeDeps();

    await runShopifyEvidenceBatch(PAYLOAD, deps);

    expect(deps.ensureCryptoPolicy).toHaveBeenCalledWith({
      scope: {
        organizationId: PAYLOAD.organizationId,
        storeId: PAYLOAD.storeId,
      },
      keyChecks: computeIdentityCryptoKeyChecks({
        scope: {
          organizationId: PAYLOAD.organizationId,
          storeId: PAYLOAD.storeId,
        },
        keyring: KEYRING,
        suppressionKey: SUPPRESSION_KEY,
      }),
    });
    expect(
      deps.ensureCryptoPolicy.mock.invocationCallOrder[0],
    ).toBeLessThan(deps.listOrderBatch.mock.invocationCallOrder[0]);
  });

  it("persists complete lines when protected identity is unavailable", async () => {
    const deps = makeDeps({ identityStatus: "unavailable" });
    const result = await runShopifyEvidenceBatch(PAYLOAD, deps);
    expect(deps.commitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        lineDisposition: "complete",
        identity: {
          status: "unavailable",
          reason: "protected_identity_unavailable",
        },
      }),
    );
    expect(result.counts.ordersEnriched).toBe(1);
    expect(result.counts.ordersPartial).toBe(1);
    expect(result.counts.ordersUnavailable).toBe(1);
    expect(result.counts.warnings).toBe(1);
    expect(result.identityCapability).toBe("unavailable");
    expect(result.lineCompleteness).toBe("complete");
  });

  it("skips protected identity GraphQL when the capability probe already denied it", async () => {
    const deps = makeDeps();
    const result = await runShopifyEvidenceBatch(
      { ...PAYLOAD, identityCapability: "unavailable" },
      deps,
    );
    expect(deps.fetchIdentity).not.toHaveBeenCalled();
    expect(deps.commitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          status: "unavailable",
          reason: "protected_identity_unavailable",
        },
      }),
    );
    expect(result.counts.ordersUnavailable).toBe(1);
  });

  it("counts every unavailable identity without undoing complete lines", async () => {
    const secondOrder = {
      id: "order_internal_2",
      shopifyOrderId: "gid://shopify/Order/2",
      orderCreatedAt: new Date("2026-07-31T02:00:00Z"),
    };
    const deps = makeDeps({ orders: [ORDER, secondOrder] });
    const result = await runShopifyEvidenceBatch(
      { ...PAYLOAD, identityCapability: "unavailable" },
      deps,
    );

    expect(deps.fetchIdentity).not.toHaveBeenCalled();
    expect(deps.commitOrder).toHaveBeenCalledTimes(2);
    expect(
      deps.commitOrder.mock.calls.map(([input]) => input.lineDisposition),
    ).toEqual(["complete", "complete"]);
    expect(result.counts).toEqual({
      ordersRead: 2,
      ordersEnriched: 2,
      ordersPartial: 2,
      ordersUnavailable: 2,
      warnings: 2,
      failures: 0,
    });
  });

  it("preserves prior evidence and stops only for a deterministic incomplete set", async () => {
    const providerMessage = "Shopify line cursor did not advance";
    const deps = makeDeps({
      lineError: new IncompleteShopifyLineSetError(providerMessage),
    });
    const result = await runShopifyEvidenceBatch(PAYLOAD, deps);
    expect(deps.fetchIdentity).not.toHaveBeenCalled();
    expect(deps.commitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: null,
        lineDisposition: "preserved_partial",
        identity: { status: "not_refreshed" },
      }),
    );
    expect(JSON.stringify(deps.commitOrder.mock.calls[0][0])).not.toContain(
      providerMessage,
    );
    expect(result).toMatchObject({
      kind: "terminal",
      status: "partial",
      nextCursor: null,
      committedCursor: { orderCreatedAt: NOW, id: "order_internal_1" },
      counts: {
        ordersRead: 1,
        ordersEnriched: 0,
        ordersPartial: 1,
        ordersUnavailable: 0,
        warnings: 0,
        failures: 1,
      },
      lineCompleteness: "partial",
    });
  });

  it("does not inspect later orders after committing a preserved-partial terminal", async () => {
    const laterOrder = {
      id: "order_internal_2",
      shopifyOrderId: "gid://shopify/Order/2",
      orderCreatedAt: new Date("2026-07-31T02:00:00Z"),
    };
    const deps = makeDeps({
      lineError: new IncompleteShopifyLineSetError("incomplete"),
      orders: [ORDER, laterOrder],
      nextCursor: {
        orderCreatedAt: laterOrder.orderCreatedAt,
        id: laterOrder.id,
      },
    });

    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).resolves.toMatchObject({
      kind: "terminal",
      status: "partial",
      committedCursor: ORDER_CURSOR,
    });
    expect(deps.fetchLines).toHaveBeenCalledOnce();
    expect(deps.commitOrder).toHaveBeenCalledOnce();
  });

  it("rethrows a retryable line failure so the task replays from its committed cursor", async () => {
    const deps = makeDeps({ lineError: new Error("network reset") });
    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
      "network reset",
    );
    expect(deps.fetchIdentity).not.toHaveBeenCalled();
    expect(deps.commitOrder).not.toHaveBeenCalled();
  });

  it("rethrows identity failures without advancing the cursor", async () => {
    const deps = makeDeps({ identityError: new Error("identity request reset") });

    await expect(runShopifyEvidenceBatch(PAYLOAD, deps)).rejects.toThrow(
      "identity request reset",
    );
    expect(deps.commitOrder).not.toHaveBeenCalled();
  });

  it("returns the exact committed continuation cursor", async () => {
    const deps = makeDeps({ nextCursor: ORDER_CURSOR });
    const result = await runShopifyEvidenceBatch(PAYLOAD, deps);
    expect(result.kind).toBe("continue");
    expect(result.nextCursor).toEqual({
      orderCreatedAt: NOW,
      id: "order_internal_1",
    });
    expect(deps.commitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          organizationId: PAYLOAD.organizationId,
          storeId: PAYLOAD.storeId,
        },
        evidenceRunId: PAYLOAD.runId,
        expectedCursor: null,
        nextCursor: { orderCreatedAt: NOW, id: "order_internal_1" },
        progress: {
          counts: result.counts,
          identityCapability: result.identityCapability,
          lineCompleteness: result.lineCompleteness,
        },
      }),
    );
  });

  it("returns a terminal success with finish state only when no page remains", async () => {
    const result = await runShopifyEvidenceBatch(
      PAYLOAD,
      makeDeps({ nextCursor: null }),
    );
    expect(result).toMatchObject({
      kind: "terminal",
      status: "success",
      nextCursor: null,
      committedCursor: { orderCreatedAt: NOW, id: "order_internal_1" },
      lineCompleteness: "complete",
    });
  });

  it("finishes an empty order window without remote calls, writes, or count changes", async () => {
    const committedCursor = {
      orderCreatedAt: new Date("2026-07-30T01:00:00Z"),
      id: "order_internal_0",
    };
    const counts = {
      ordersRead: 7,
      ordersEnriched: 6,
      ordersPartial: 2,
      ordersUnavailable: 1,
      warnings: 1,
      failures: 1,
    };
    const deps = makeDeps({ orders: [], nextCursor: null });

    const result = await runShopifyEvidenceBatch(
      { ...PAYLOAD, cursor: committedCursor, counts },
      deps,
    );

    expect(result).toEqual({
      kind: "terminal",
      status: "success",
      nextCursor: null,
      committedCursor,
      counts,
      identityCapability: "unknown",
      lineCompleteness: "unknown",
    });
    expect(deps.fetchLines).not.toHaveBeenCalled();
    expect(deps.fetchIdentity).not.toHaveBeenCalled();
    expect(deps.commitOrder).not.toHaveBeenCalled();
  });

  it("preserves cumulative counts and advances expected cursors across multiple orders", async () => {
    const priorCursor = {
      orderCreatedAt: new Date("2026-07-30T01:00:00Z"),
      id: "order_internal_0",
    };
    const secondOrder = {
      id: "order_internal_2",
      shopifyOrderId: "gid://shopify/Order/2",
      orderCreatedAt: new Date("2026-07-31T02:00:00Z"),
    };
    const nextCursor = {
      orderCreatedAt: secondOrder.orderCreatedAt,
      id: secondOrder.id,
    };
    const initialCounts = {
      ordersRead: 5,
      ordersEnriched: 4,
      ordersPartial: 1,
      ordersUnavailable: 1,
      warnings: 1,
      failures: 0,
    };
    const deps = makeDeps({
      orders: [ORDER, secondOrder],
      nextCursor,
    });

    const result = await runShopifyEvidenceBatch(
      {
        ...PAYLOAD,
        cursor: priorCursor,
        counts: initialCounts,
        identityCapability: "available",
        lineCompleteness: "complete",
      },
      deps,
    );

    expect(result).toMatchObject({
      kind: "continue",
      nextCursor,
      committedCursor: nextCursor,
      counts: {
        ordersRead: 7,
        ordersEnriched: 6,
        ordersPartial: 1,
        ordersUnavailable: 1,
        warnings: 1,
        failures: 0,
      },
      identityCapability: "available",
      lineCompleteness: "complete",
    });
    expect(initialCounts).toEqual({
      ordersRead: 5,
      ordersEnriched: 4,
      ordersPartial: 1,
      ordersUnavailable: 1,
      warnings: 1,
      failures: 0,
    });
    expect(deps.commitOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedCursor: priorCursor,
        nextCursor: ORDER_CURSOR,
      }),
    );
    expect(deps.commitOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedCursor: ORDER_CURSOR,
        nextCursor,
      }),
    );
  });

  it("does not report progress when the atomic commit fails and retries from the supplied state", async () => {
    const commitError = new Error("commit compare-and-set failed");
    const failedDeps = makeDeps({ commitError });

    await expect(runShopifyEvidenceBatch(PAYLOAD, failedDeps)).rejects.toBe(
      commitError,
    );
    expect(PAYLOAD.counts).toEqual(ZERO_COUNTS);

    const retryDeps = makeDeps();
    const result = await runShopifyEvidenceBatch(PAYLOAD, retryDeps);
    expect(retryDeps.commitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCursor: null,
        progress: expect.objectContaining({
          counts: {
            ordersRead: 1,
            ordersEnriched: 1,
            ordersPartial: 0,
            ordersUnavailable: 0,
            warnings: 0,
            failures: 0,
          },
        }),
      }),
    );
    expect(result.committedCursor).toEqual(ORDER_CURSOR);
  });
});
