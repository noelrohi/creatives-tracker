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
import {
  assertExactEvidenceContinuationPayload,
  assertExactEvidenceStartPayload,
  executeShopifyEvidenceBatch,
  executeShopifyEvidenceStart,
  handleShopifyEvidenceBatchTerminalFailure,
  handleShopifyEvidenceStartTerminalFailure,
  type ShopifyEvidenceBatchOrchestrationDependencies,
  type ShopifyEvidenceStartOrchestrationDependencies,
} from "../../trigger/shopify-evidence-sync";

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

const ORCHESTRATION_CURSOR = {
  orderCreatedAt: new Date("2026-07-30T01:00:00.000Z"),
  id: "order_internal_1",
};

function orchestrationRun(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "evidence_run_1",
    startTriggerRunId: "trigger_start_1",
    firstBatchTriggerRunId: "trigger_batch_1",
    organizationId: "org_a",
    storeId: "store_a",
    mode: "incremental_7d" as const,
    storeTimezone: "UTC",
    anchorStoreDay: "2026-07-31",
    requestedFrom: new Date("2026-07-25T00:00:00.000Z"),
    requestedTo: new Date("2026-08-01T00:00:00.000Z"),
    cursor: ORCHESTRATION_CURSOR,
    status: "running" as const,
    identityCapability: "available" as const,
    lineCompleteness: "complete" as const,
    ordersRead: 4,
    ordersEnriched: 4,
    ordersPartial: 0,
    ordersUnavailable: 0,
    warnings: 0,
    failures: 0,
    error: null,
    heartbeatAt: new Date("2026-07-31T23:55:00.000Z"),
    startedAt: new Date("2026-07-31T23:50:00.000Z"),
    finishedAt: null,
    scope: { organizationId: "org_a", storeId: "store_a" },
    window: {
      from: new Date("2026-07-25T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
    },
    counts: {
      ordersRead: 4,
      ordersEnriched: 4,
      ordersPartial: 0,
      ordersUnavailable: 0,
      warnings: 0,
      failures: 0,
    },
    ...overrides,
  };
}

function batchOrchestrationDeps(input: {
  run?: ReturnType<typeof orchestrationRun> | null;
  result?: Awaited<ReturnType<typeof runShopifyEvidenceBatch>>;
} = {}) {
  const run = input.run === undefined ? orchestrationRun() : input.run;
  const result =
    input.result ??
    ({
      kind: "terminal",
      status: "success",
      nextCursor: null,
      committedCursor: ORCHESTRATION_CURSOR,
      counts: orchestrationRun().counts,
      identityCapability: "available",
      lineCompleteness: "complete",
    } as const);
  const mocks = {
    loadRun: vi.fn(async () => run),
    renewHeartbeat: vi.fn(async () => undefined),
    runBatch: vi.fn(async () => result),
    enqueue: vi.fn(async () => ({ id: "next_trigger" })),
    finishRun: vi.fn(async () => undefined),
    setMetadata: vi.fn(),
  };
  return {
    mocks,
    deps: mocks as unknown as ShopifyEvidenceBatchOrchestrationDependencies,
  };
}

function startOrchestrationDeps(input: {
  existing?: ReturnType<typeof orchestrationRun> | null;
  reloaded?: ReturnType<typeof orchestrationRun> | null;
  expired?: boolean;
  capabilities?: {
    orderScope: "available" | "unavailable";
    historicalOrders: "available" | "unavailable";
    identityScope: "declared" | "missing";
    scopes: string[];
  };
  insertedStatus?: "running" | "success" | "partial" | "failed";
} = {}) {
  const existing = input.existing ?? null;
  const reloaded =
    input.reloaded === undefined ? orchestrationRun() : input.reloaded;
  const validateSecretPolicy = vi.fn();
  const mocks = {
    loadByStartTriggerId: vi.fn(async () => existing),
    loadRun: vi.fn(async () => reloaded),
    failExpiredRun: vi.fn(async () => ({ changed: input.expired ?? false })),
    captureSecretPolicy: vi.fn(() => validateSecretPolicy),
    validateSecretPolicy,
    getConfiguredDomain: vi.fn(() => "store-a.myshopify.com"),
    resolveStore: vi.fn(async () => ({
      id: "store_a",
      organizationId: "org_a",
      shopDomain: "store-a.myshopify.com",
      ianaTimezone: "UTC",
    })),
    reconcileStore: vi.fn(async () => ({ expiredRunId: null })),
    probeCapabilities: vi.fn(
      async () =>
        input.capabilities ?? {
          orderScope: "available" as const,
          historicalOrders: "available" as const,
          identityScope: "declared" as const,
          scopes: ["read_orders", "read_all_orders", "read_customers"],
        },
    ),
    countOrders: vi.fn(async () => 3),
    startRun: vi.fn(async () => ({
      id: "evidence_run_1",
      status: input.insertedStatus ?? ("running" as const),
      firstBatchTriggerRunId: null,
      replayed: false,
    })),
    enqueue: vi.fn(async () => ({ id: "trigger_batch_1" })),
    recordFirstBatch: vi.fn(async () => undefined),
    logTerminal: vi.fn(),
  };
  return {
    mocks,
    deps: mocks as unknown as ShopifyEvidenceStartOrchestrationDependencies,
  };
}

describe("Shopify evidence Trigger orchestration", () => {
  it("accepts only exact allowlisted start and continuation payloads", () => {
    expect(() => assertExactEvidenceStartPayload({ mode: "initial_90d" })).not.toThrow();
    expect(() =>
      assertExactEvidenceStartPayload({
        mode: "initial_90d",
        organizationId: "org_a",
      }),
    ).toThrow("only an approved mode");
    expect(() => assertExactEvidenceStartPayload({ mode: "all_time" })).toThrow();
    expect(() => assertExactEvidenceContinuationPayload({ runId: "run_1" })).not.toThrow();
    for (const payload of [
      { runId: "run_1", cursor: null },
      { runId: "run_1", from: "2026-01-01" },
      { runId: "" },
      null,
    ]) {
      expect(() => assertExactEvidenceContinuationPayload(payload)).toThrow(
        "only a run ID",
      );
    }
  });

  it("reloads continuation authority and renews heartbeat before runner work", async () => {
    const { deps, mocks } = batchOrchestrationDeps();
    const now = new Date("2026-08-01T00:00:00.000Z");
    await executeShopifyEvidenceBatch({ runId: "evidence_run_1" }, now, deps);
    expect(mocks.loadRun).toHaveBeenCalledWith("evidence_run_1");
    expect(mocks.renewHeartbeat).toHaveBeenCalledWith(
      { organizationId: "org_a", storeId: "store_a" },
      "evidence_run_1",
      now,
    );
    expect(mocks.renewHeartbeat.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runBatch.mock.invocationCallOrder[0],
    );
    expect(mocks.runBatch).toHaveBeenCalledWith({
      organizationId: "org_a",
      storeId: "store_a",
      from: new Date("2026-07-25T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
      runId: "evidence_run_1",
      cursor: ORCHESTRATION_CURSOR,
      counts: orchestrationRun().counts,
      identityCapability: "available",
      lineCompleteness: "complete",
    });
  });

  it("rejects a persisted window with the wrong floor before heartbeat or remote work", async () => {
    const run = orchestrationRun({
      window: {
        from: new Date("2026-07-24T00:00:00.000Z"),
        to: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    const { deps, mocks } = batchOrchestrationDeps({ run });
    await expect(
      executeShopifyEvidenceBatch({ runId: run.id }, NOW, deps),
    ).rejects.toThrow("persisted window is invalid");
    expect(mocks.renewHeartbeat).not.toHaveBeenCalled();
    expect(mocks.runBatch).not.toHaveBeenCalled();
  });

  it("rejects a persisted window beyond the anchor next-midnight before any work", async () => {
    const run = orchestrationRun({
      window: {
        from: new Date("2026-07-25T00:00:00.000Z"),
        to: new Date("2026-08-01T00:00:00.001Z"),
      },
    });
    const { deps, mocks } = batchOrchestrationDeps({ run });

    await expect(
      executeShopifyEvidenceBatch({ runId: run.id }, NOW, deps),
    ).rejects.toThrow("persisted window is invalid");
    expect(mocks.renewHeartbeat).not.toHaveBeenCalled();
    expect(mocks.runBatch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.finishRun).not.toHaveBeenCalled();
  });

  it("enqueues one stable cursor-qualified continuation without finishing", async () => {
    const result = {
      kind: "continue" as const,
      nextCursor: ORCHESTRATION_CURSOR,
      committedCursor: { ...ORCHESTRATION_CURSOR },
      counts: orchestrationRun().counts,
      identityCapability: "available" as const,
      lineCompleteness: "complete" as const,
    };
    const { deps, mocks } = batchOrchestrationDeps({ result });
    await expect(
      executeShopifyEvidenceBatch({ runId: "evidence_run_1" }, NOW, deps),
    ).resolves.toEqual({ kind: "continue", runId: "evidence_run_1" });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { runId: "evidence_run_1" },
      "shopify-evidence:batch:evidence_run_1:2026-07-30T01:00:00.000Z:order_internal_1",
    );
    expect(mocks.finishRun).not.toHaveBeenCalled();
  });

  it("fails closed when the runner continuation differs from its committed cursor", async () => {
    const { deps, mocks } = batchOrchestrationDeps({
      result: {
        kind: "continue",
        nextCursor: ORCHESTRATION_CURSOR,
        committedCursor: { ...ORCHESTRATION_CURSOR, id: "different" },
        counts: orchestrationRun().counts,
        identityCapability: "available",
        lineCompleteness: "complete",
      },
    });
    await expect(
      executeShopifyEvidenceBatch({ runId: "evidence_run_1" }, NOW, deps),
    ).rejects.toThrow("cursor conflicts");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.finishRun).not.toHaveBeenCalled();
  });

  it("finishes once with exact terminal progress and preserves unknown empty-window completeness", async () => {
    const counts = orchestrationRun().counts;
    const { deps, mocks } = batchOrchestrationDeps({
      run: orchestrationRun({
        cursor: null,
        lineCompleteness: "unknown",
        counts,
      }),
      result: {
        kind: "terminal",
        status: "success",
        nextCursor: null,
        committedCursor: null,
        counts,
        identityCapability: "available",
        lineCompleteness: "unknown",
      },
    });
    await executeShopifyEvidenceBatch({ runId: "evidence_run_1" }, NOW, deps);
    expect(mocks.finishRun).toHaveBeenCalledTimes(1);
    expect(mocks.finishRun).toHaveBeenCalledWith({
      scope: { organizationId: "org_a", storeId: "store_a" },
      runId: "evidence_run_1",
      expectedCursor: null,
      status: "success",
      progress: {
        counts,
        identityCapability: "available",
        lineCompleteness: "unknown",
      },
      error: null,
      now: NOW,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("derives a new start only after secret validation store reconciliation and capability probe", async () => {
    const { deps, mocks } = startOrchestrationDeps();
    await executeShopifyEvidenceStart(
      { mode: "incremental_7d" },
      "trigger_start_1",
      new Date("2026-07-31T23:59:00.000Z"),
      deps,
    );
    expect(mocks.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        startTriggerRunId: "trigger_start_1",
        scope: { organizationId: "org_a", storeId: "store_a" },
        mode: "incremental_7d",
        storeTimezone: "UTC",
        anchorStoreDay: "2026-07-31",
        window: {
          from: new Date("2026-07-25T00:00:00.000Z"),
          to: new Date("2026-08-01T00:00:00.000Z"),
        },
        disposition: { kind: "running", identityCapability: "unknown" },
      }),
    );
    expect(mocks.reconcileStore.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.probeCapabilities.mock.invocationCallOrder[0],
    );
    expect(mocks.captureSecretPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveStore.mock.invocationCallOrder[0],
    );
    expect(mocks.resolveStore.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.validateSecretPolicy.mock.invocationCallOrder[0],
    );
    expect(mocks.validateSecretPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reconcileStore.mock.invocationCallOrder[0],
    );
    expect(mocks.probeCapabilities.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startRun.mock.invocationCallOrder[0],
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { runId: "evidence_run_1" },
      "shopify-evidence:first:evidence_run_1",
    );
  });

  it("performs no database write or provider call when secret validation fails", async () => {
    const { deps, mocks } = startOrchestrationDeps();
    mocks.captureSecretPolicy.mockImplementation(() => {
      throw new Error("invalid private key environment");
    });
    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).rejects.toThrow("invalid private key environment");
    expect(mocks.resolveStore).not.toHaveBeenCalled();
    expect(mocks.reconcileStore).not.toHaveBeenCalled();
    expect(mocks.probeCapabilities).not.toHaveBeenCalled();
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it("uses one secret snapshot across configured-store resolution", async () => {
    const { deps, mocks } = startOrchestrationDeps();
    let activeSecretSet = "keys-a";
    const observedSecretSets: string[] = [];
    mocks.captureSecretPolicy.mockImplementation(() => {
      const capturedSecretSet = activeSecretSet;
      observedSecretSets.push(`validated:${capturedSecretSet}`);
      return vi.fn(() => {
        observedSecretSets.push(`policy:${capturedSecretSet}`);
      });
    });
    mocks.resolveStore.mockImplementation(async () => {
      activeSecretSet = "keys-b";
      return {
        id: "store_a",
        organizationId: "org_a",
        shopDomain: "store-a.myshopify.com",
        ianaTimezone: "UTC",
      };
    });

    await executeShopifyEvidenceStart(
      { mode: "incremental_7d" },
      "trigger_secret_snapshot",
      NOW,
      deps,
    );

    expect(observedSecretSets).toEqual([
      "validated:keys-a",
      "policy:keys-a",
    ]);
  });

  it("leaves no run when the capability probe has a retryable failure", async () => {
    const { deps, mocks } = startOrchestrationDeps();
    mocks.probeCapabilities.mockRejectedValue(
      new Error("sanitized retryable capability failure"),
    );
    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).rejects.toThrow("sanitized retryable capability failure");
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("requires read_orders for incremental mode even when historical access exists", async () => {
    const { deps, mocks } = startOrchestrationDeps({
      capabilities: {
        orderScope: "unavailable",
        historicalOrders: "available",
        identityScope: "declared",
        scopes: ["read_all_orders", "read_customers"],
      },
      insertedStatus: "partial",
    });
    await executeShopifyEvidenceStart(
      { mode: "incremental_7d" },
      "trigger_no_orders",
      NOW,
      deps,
    );
    expect(mocks.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: expect.objectContaining({
          kind: "terminal_unavailable",
          identityCapability: "unknown",
        }),
      }),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("finishes initial mode as measurable terminal unavailable without enqueue", async () => {
    const { deps, mocks } = startOrchestrationDeps({
      capabilities: {
        orderScope: "available",
        historicalOrders: "unavailable",
        identityScope: "missing",
        scopes: ["read_orders"],
      },
      insertedStatus: "partial",
    });
    await expect(
      executeShopifyEvidenceStart(
        { mode: "initial_90d" },
        "trigger_denied",
        NOW,
        deps,
      ),
    ).resolves.toEqual({
      evidenceRunId: "evidence_run_1",
      triggerRunId: "trigger_denied",
      terminal: true,
    });
    expect(mocks.countOrders).toHaveBeenCalledTimes(1);
    expect(mocks.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: {
          kind: "terminal_unavailable",
          identityCapability: "unavailable",
          counts: {
            ordersRead: 0,
            ordersEnriched: 0,
            ordersPartial: 0,
            ordersUnavailable: 3,
            warnings: 1,
            failures: 0,
          },
          errorCode: "required_order_scope_unavailable",
        },
      }),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("reuses a terminal start without secrets probes dates or handoff", async () => {
    const terminal = orchestrationRun({ status: "partial" as const });
    const { deps, mocks } = startOrchestrationDeps({ existing: terminal });
    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).resolves.toEqual({
      evidenceRunId: "evidence_run_1",
      triggerRunId: "trigger_start_1",
      terminal: true,
    });
    expect(mocks.captureSecretPolicy).not.toHaveBeenCalled();
    expect(mocks.probeCapabilities).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("reaps an expired replay without inventing a child and repairs a live missing handoff", async () => {
    const missingHandoff = orchestrationRun({ firstBatchTriggerRunId: null });
    const expiredTerminal = orchestrationRun({
      firstBatchTriggerRunId: null,
      status: "failed" as const,
      error: "lease_expired",
      finishedAt: NOW,
    });
    const expired = startOrchestrationDeps({
      existing: missingHandoff,
      reloaded: expiredTerminal,
      expired: true,
    });
    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        expired.deps,
      ),
    ).resolves.toMatchObject({ terminal: true });
    expect(expired.mocks.enqueue).not.toHaveBeenCalled();
    expect(expired.mocks.recordFirstBatch).not.toHaveBeenCalled();

    const live = startOrchestrationDeps({
      existing: missingHandoff,
      reloaded: missingHandoff,
    });
    await executeShopifyEvidenceStart(
      { mode: "incremental_7d" },
      "trigger_start_1",
      NOW,
      live.deps,
    );
    expect(live.mocks.enqueue).toHaveBeenCalledWith(
      { runId: "evidence_run_1" },
      "shopify-evidence:first:evidence_run_1",
    );
    expect(live.mocks.recordFirstBatch).toHaveBeenCalledWith({
      scope: { organizationId: "org_a", storeId: "store_a" },
      runId: "evidence_run_1",
      triggerRunId: "trigger_batch_1",
    });
    expect(live.mocks.probeCapabilities).not.toHaveBeenCalled();
  });

  it("reloads after lease finalization and repairs terminal traceability from authoritative scope", async () => {
    const initiallyRunning = orchestrationRun({
      firstBatchTriggerRunId: null,
      scope: { organizationId: "stale_org", storeId: "stale_store" },
    });
    const concurrentlyTerminal = orchestrationRun({
      firstBatchTriggerRunId: null,
      status: "success" as const,
      finishedAt: NOW,
    });
    const { deps, mocks } = startOrchestrationDeps({
      existing: initiallyRunning,
      reloaded: concurrentlyTerminal,
      expired: false,
    });

    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).resolves.toEqual({
      evidenceRunId: "evidence_run_1",
      triggerRunId: "trigger_start_1",
      terminal: true,
    });
    expect(mocks.loadRun).toHaveBeenCalledWith("evidence_run_1");
    expect(mocks.loadRun.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enqueue.mock.invocationCallOrder[0],
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { runId: "evidence_run_1" },
      "shopify-evidence:first:evidence_run_1",
    );
    expect(mocks.recordFirstBatch).toHaveBeenCalledWith({
      scope: { organizationId: "org_a", storeId: "store_a" },
      runId: "evidence_run_1",
      triggerRunId: "trigger_batch_1",
    });
    expect(mocks.probeCapabilities).not.toHaveBeenCalled();
  });

  it("repairs a terminal crash-ambiguous missing handoff but not capability denial", async () => {
    const terminalMissingHandoff = orchestrationRun({
      firstBatchTriggerRunId: null,
      status: "success" as const,
      finishedAt: NOW,
    });
    const crash = startOrchestrationDeps({
      existing: terminalMissingHandoff,
      reloaded: terminalMissingHandoff,
    });
    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        crash.deps,
      ),
    ).resolves.toMatchObject({ terminal: true });
    expect(crash.mocks.enqueue).toHaveBeenCalledWith(
      { runId: "evidence_run_1" },
      "shopify-evidence:first:evidence_run_1",
    );
    expect(crash.mocks.recordFirstBatch).toHaveBeenCalledTimes(1);

    const unavailable = orchestrationRun({
      firstBatchTriggerRunId: null,
      status: "partial" as const,
      lineCompleteness: "unavailable" as const,
      error: "required_order_scope_unavailable",
      finishedAt: NOW,
    });
    const denied = startOrchestrationDeps({ existing: unavailable });
    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_denied",
        NOW,
        denied.deps,
      ),
    ).resolves.toMatchObject({ terminal: true });
    expect(denied.mocks.enqueue).not.toHaveBeenCalled();
    expect(denied.mocks.recordFirstBatch).not.toHaveBeenCalled();
  });

  it("does not invent a child for start retry exhaustion", async () => {
    const terminal = orchestrationRun({
      firstBatchTriggerRunId: null,
      status: "failed" as const,
      error: "start_retries_exhausted",
      finishedAt: NOW,
    });
    const { deps, mocks } = startOrchestrationDeps({ existing: terminal });

    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).resolves.toMatchObject({ terminal: true });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.recordFirstBatch).not.toHaveBeenCalled();
    expect(mocks.probeCapabilities).not.toHaveBeenCalled();
  });

  it("does not repair another terminal state without batch proof", async () => {
    const terminal = orchestrationRun({
      firstBatchTriggerRunId: null,
      status: "partial" as const,
      error: "protected_identity_unavailable",
      finishedAt: NOW,
    });
    const { deps, mocks } = startOrchestrationDeps({ existing: terminal });

    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).resolves.toMatchObject({ terminal: true });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.recordFirstBatch).not.toHaveBeenCalled();
  });

  it.each([
    { status: "partial" as const, error: "incomplete_line_set" },
    { status: "failed" as const, error: "batch_retries_exhausted" },
    { status: "failed" as const, error: "evidence_batch_failed" },
  ])("repairs a missing handoff for batch-proven $error", async (terminal) => {
    const run = orchestrationRun({
      firstBatchTriggerRunId: null,
      status: terminal.status,
      error: terminal.error,
      finishedAt: NOW,
    });
    const { deps, mocks } = startOrchestrationDeps({
      existing: run,
      reloaded: run,
    });

    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).resolves.toMatchObject({ terminal: true });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { runId: "evidence_run_1" },
      "shopify-evidence:first:evidence_run_1",
    );
    expect(mocks.recordFirstBatch).toHaveBeenCalledTimes(1);
  });

  it("reuses one run after a crash immediately after insertion before trigger", async () => {
    const missingHandoff = orchestrationRun({ firstBatchTriggerRunId: null });
    const { deps, mocks } = startOrchestrationDeps({
      reloaded: missingHandoff,
    });
    mocks.loadByStartTriggerId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(missingHandoff);
    mocks.enqueue
      .mockRejectedValueOnce(new Error("simulated crash after insertion"))
      .mockResolvedValueOnce({ id: "trigger_batch_1" });

    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).rejects.toThrow("simulated crash after insertion");
    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).resolves.toMatchObject({ evidenceRunId: "evidence_run_1" });
    expect(mocks.startRun).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenNthCalledWith(
      1,
      { runId: "evidence_run_1" },
      "shopify-evidence:first:evidence_run_1",
    );
    expect(mocks.enqueue).toHaveBeenNthCalledWith(
      2,
      { runId: "evidence_run_1" },
      "shopify-evidence:first:evidence_run_1",
    );
  });

  it("reuses one idempotent child after trigger succeeds before handoff CAS returns", async () => {
    const missingHandoff = orchestrationRun({ firstBatchTriggerRunId: null });
    const { deps, mocks } = startOrchestrationDeps({
      existing: missingHandoff,
      reloaded: missingHandoff,
    });
    mocks.recordFirstBatch
      .mockRejectedValueOnce(new Error("simulated crash before start return"))
      .mockResolvedValueOnce(undefined);

    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).rejects.toThrow("simulated crash before start return");
    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).resolves.toMatchObject({ evidenceRunId: "evidence_run_1" });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue.mock.calls[0]).toEqual(mocks.enqueue.mock.calls[1]);
    expect(mocks.recordFirstBatch).toHaveBeenNthCalledWith(2, {
      scope: { organizationId: "org_a", storeId: "store_a" },
      runId: "evidence_run_1",
      triggerRunId: "trigger_batch_1",
    });
  });

  it("repairs traceability when the child terminalizes between trigger and start retry", async () => {
    const runningMissingHandoff = orchestrationRun({
      firstBatchTriggerRunId: null,
    });
    const terminalMissingHandoff = orchestrationRun({
      firstBatchTriggerRunId: null,
      status: "success" as const,
      finishedAt: NOW,
    });
    const { deps, mocks } = startOrchestrationDeps({
      existing: runningMissingHandoff,
      reloaded: terminalMissingHandoff,
    });
    mocks.loadByStartTriggerId
      .mockResolvedValueOnce(runningMissingHandoff)
      .mockResolvedValueOnce(terminalMissingHandoff);
    mocks.loadRun
      .mockResolvedValueOnce(runningMissingHandoff)
      .mockResolvedValueOnce(terminalMissingHandoff);
    mocks.recordFirstBatch
      .mockRejectedValueOnce(new Error("simulated crash before handoff CAS"))
      .mockResolvedValueOnce(undefined);

    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).rejects.toThrow("simulated crash before handoff CAS");
    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).resolves.toEqual({
      evidenceRunId: "evidence_run_1",
      triggerRunId: "trigger_start_1",
      terminal: true,
    });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue.mock.calls[0]).toEqual(mocks.enqueue.mock.calls[1]);
    expect(mocks.recordFirstBatch).toHaveBeenCalledTimes(2);
    expect(mocks.probeCapabilities).not.toHaveBeenCalled();
  });

  it("resumes a retried batch from the freshly reloaded cursor and counts", async () => {
    const firstRun = orchestrationRun();
    const resumedCursor = {
      orderCreatedAt: new Date("2026-07-30T02:00:00.000Z"),
      id: "order_internal_2",
    };
    const resumedCounts = {
      ...firstRun.counts,
      ordersRead: 5,
      ordersEnriched: 5,
    };
    const resumedRun = orchestrationRun({
      cursor: resumedCursor,
      counts: resumedCounts,
    });
    const { deps, mocks } = batchOrchestrationDeps();
    mocks.loadRun
      .mockResolvedValueOnce(firstRun)
      .mockResolvedValueOnce(resumedRun);
    mocks.runBatch
      .mockRejectedValueOnce(new Error("retryable later-order failure"))
      .mockResolvedValueOnce({
        kind: "terminal",
        status: "success",
        nextCursor: null,
        committedCursor: resumedCursor,
        counts: resumedCounts,
        identityCapability: "available",
        lineCompleteness: "complete",
      });

    await expect(
      executeShopifyEvidenceBatch({ runId: "evidence_run_1" }, NOW, deps),
    ).rejects.toThrow("retryable later-order failure");
    await executeShopifyEvidenceBatch(
      { runId: "evidence_run_1" },
      NOW,
      deps,
    );
    expect(mocks.runBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: resumedCursor,
        counts: resumedCounts,
      }),
    );
    expect(mocks.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ expectedCursor: resumedCursor }),
    );
  });

  it("keeps a live completed handoff intact without enqueueing or probing", async () => {
    const existing = orchestrationRun({
      firstBatchTriggerRunId: "already_handed_off",
    });
    const { deps, mocks } = startOrchestrationDeps({ existing });
    await executeShopifyEvidenceStart(
      { mode: "incremental_7d" },
      "trigger_start_1",
      NOW,
      deps,
    );
    expect(mocks.failExpiredRun).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.probeCapabilities).not.toHaveBeenCalled();
  });

  it("fails a stable start ID reused with another mode before side effects", async () => {
    const existing = orchestrationRun({ mode: "initial_90d" as const });
    const { deps, mocks } = startOrchestrationDeps({ existing });
    await expect(
      executeShopifyEvidenceStart(
        { mode: "incremental_7d" },
        "trigger_start_1",
        NOW,
        deps,
      ),
    ).rejects.toThrow("idempotency conflict");
    expect(mocks.failExpiredRun).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("uses only persisted scope in terminal failure hooks and tolerates no inserted start", async () => {
    const loadRun = vi.fn(async () => orchestrationRun());
    const failRun = vi.fn(async () => ({ changed: true }));
    await handleShopifyEvidenceBatchTerminalFailure(
      { runId: "evidence_run_1" },
      {
        loadRun: loadRun as never,
        failRun: failRun as never,
      },
    );
    expect(failRun).toHaveBeenCalledWith(
      { organizationId: "org_a", storeId: "store_a" },
      "evidence_run_1",
      "batch",
    );

    const loadByStartTriggerId = vi.fn(async () => null);
    await handleShopifyEvidenceStartTerminalFailure(
      { mode: "incremental_7d" },
      "missing-trigger",
      {
        loadByStartTriggerId: loadByStartTriggerId as never,
        failRun: failRun as never,
      },
    );
    expect(loadByStartTriggerId).toHaveBeenCalledWith("missing-trigger");
    expect(failRun).toHaveBeenCalledTimes(1);
  });

  it("applies fixed start and batch retry-exhaustion stages on hook replay", async () => {
    const loadRun = vi.fn(async () => orchestrationRun());
    const loadByStartTriggerId = vi.fn(async () => orchestrationRun());
    const failRun = vi
      .fn()
      .mockResolvedValueOnce({ changed: true })
      .mockResolvedValue({ changed: false });
    const batchDeps = {
      loadRun: loadRun as never,
      failRun: failRun as never,
    };
    await handleShopifyEvidenceBatchTerminalFailure(
      { runId: "evidence_run_1" },
      batchDeps,
    );
    await handleShopifyEvidenceBatchTerminalFailure(
      { runId: "evidence_run_1" },
      batchDeps,
    );
    await handleShopifyEvidenceStartTerminalFailure(
      { mode: "incremental_7d" },
      "trigger_start_1",
      {
        loadByStartTriggerId: loadByStartTriggerId as never,
        failRun: failRun as never,
      },
    );
    expect(failRun.mock.calls).toEqual([
      [{ organizationId: "org_a", storeId: "store_a" }, "evidence_run_1", "batch"],
      [{ organizationId: "org_a", storeId: "store_a" }, "evidence_run_1", "batch"],
      [{ organizationId: "org_a", storeId: "store_a" }, "evidence_run_1", "start"],
    ]);
  });
});

describe("Shopify evidence Trigger orchestration boundary", () => {
  const triggerSource = () =>
    readFileSync(
      path.resolve(process.cwd(), "trigger/shopify-evidence-sync.ts"),
      "utf8",
    );

  it("keeps the Trigger wrapper outside monetary ingestion", () => {
    const source = triggerSource();
    expect(source).not.toContain("ingestOrderNodes");
    expect(source).not.toContain("stampBuckets");
    expect(source).not.toContain("upsertShopifyStore");
    expect(source).not.toContain("startSyncRun");
    expect(source).not.toContain("finishSyncRun");
  });

  it("exports separate bounded start and continuation tasks without a schedule", () => {
    const source = triggerSource();
    expect(source).toContain('id: "shopify-evidence-start"');
    expect(source).toContain('id: "shopify-evidence-batch"');
    expect(source.match(/maxDuration: 600/g)).toHaveLength(2);
    expect(source.match(/retry: ATTRIBUTION_TASK_RETRY/g)).toHaveLength(2);
    expect(source.match(/onFailure:/g)).toHaveLength(2);
    expect(source).not.toContain("schedules.");
  });

  it("uses global idempotency keys with an explicit seven-day TTL", () => {
    const source = triggerSource();
    expect(source.match(/scope: "global"/g)).toHaveLength(1);
    expect(source).toContain('const IDEMPOTENCY_KEY_TTL = "7d"');
    expect(source).toContain("idempotencyKeyTTL: IDEMPOTENCY_KEY_TTL");
    expect(source).toContain("shopify-evidence:first:");
    expect(source).toContain("shopify-evidence:batch:");
  });

  it("keeps all persisted authority out of Trigger payloads", () => {
    const source = triggerSource();
    expect(source).toContain("Object.keys(input).length !== 1");
    expect(source).toContain("ShopifyEvidenceStartPayload");
    expect(source).toContain("ShopifyEvidenceContinuationPayload");
    for (const forbidden of [
      "organizationId:",
      "storeId:",
      "anchorStoreDay:",
      "requestedFrom:",
      "requestedTo:",
      "cursor:",
      "counts:",
    ]) {
      expect(
        source.slice(
          source.indexOf("export type ShopifyEvidenceStartPayload"),
          source.indexOf("export type ShopifyEvidenceStartResult"),
        ),
      ).not.toContain(forbidden);
    }
  });

  it("uses fixed terminal failure codes without inspecting raw errors", () => {
    const source = triggerSource();
    expect(source).toMatch(/deps\.failRun\([\s\S]*?"batch"/);
    expect(source).toMatch(/deps\.failRun\([\s\S]*?"start"/);
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("String(error)");
  });
});
