import "server-only";

import type { HalfOpenWindow } from "@/lib/evidence-window";
import {
  computeIdentityCryptoKeyChecks,
  type ErasureSuppressionKey,
  type IdentityCryptoKeyChecks,
  type IdentityHmacKeyring,
  type IdentityScope,
} from "@/lib/identity-hmac";
import {
  isRetryableShopifyLineFailure,
  type CompleteShopifyLineSet,
  type NormalizedShopifyIdentityEvidence,
  type ShopifyGraphql,
} from "@/lib/shopify-evidence-admin";
import type {
  EvidenceOrderBatch,
  EvidenceOrderCursor,
  ShopifyEvidenceRunCounts,
} from "@/lib/shopify-evidence-store";

export type ShopifyEvidenceBatchPayload = IdentityScope &
  HalfOpenWindow & {
    runId: string;
    cursor: EvidenceOrderCursor | null;
    counts: ShopifyEvidenceRunCounts;
    identityCapability: "unknown" | "available" | "unavailable";
    lineCompleteness: "unknown" | "complete" | "partial" | "unavailable";
  };

type ShopifyEvidenceCheckpointProgress = {
  counts: ShopifyEvidenceRunCounts;
  identityCapability: "unknown" | "available" | "unavailable";
  lineCompleteness: "unknown" | "complete" | "partial" | "unavailable";
};

type ShopifyEvidenceBatchProgress = ShopifyEvidenceCheckpointProgress & {
  committedCursor: EvidenceOrderCursor | null;
};

export type ShopifyEvidenceBatchResult =
  | (ShopifyEvidenceBatchProgress & {
      kind: "continue";
      nextCursor: EvidenceOrderCursor;
    })
  | (ShopifyEvidenceBatchProgress & {
      kind: "terminal";
      status: "success" | "partial";
      nextCursor: null;
    });

export type ShopifyEvidenceRunnerDependencies = {
  configuredShopDomain: string;
  loadKeyring: () => IdentityHmacKeyring;
  loadSuppressionKey: () => ErasureSuppressionKey;
  ensureCryptoPolicy: (input: {
    scope: IdentityScope;
    keyChecks: IdentityCryptoKeyChecks;
  }) => Promise<void>;
  loadStore: (scope: IdentityScope) => Promise<{ shopDomain: string }>;
  graphql: ShopifyGraphql;
  listOrderBatch: (
    scope: IdentityScope,
    window: HalfOpenWindow,
    cursor: EvidenceOrderCursor | null,
  ) => Promise<EvidenceOrderBatch>;
  fetchLines: (
    graphql: ShopifyGraphql,
    shopifyOrderId: string,
  ) => Promise<CompleteShopifyLineSet>;
  fetchIdentity: (params: {
    graphql: ShopifyGraphql;
    shopifyOrderId: string;
    scope: IdentityScope;
    keyring: IdentityHmacKeyring;
    suppressionKey: ErasureSuppressionKey;
  }) => Promise<NormalizedShopifyIdentityEvidence>;
  commitOrder: (input: {
    scope: IdentityScope;
    evidenceRunId: string;
    orderId: string;
    shopifyOrderId: string;
    expectedCursor: EvidenceOrderCursor | null;
    nextCursor: EvidenceOrderCursor;
    lines: CompleteShopifyLineSet | null;
    lineDisposition: "complete" | "preserved_partial";
    identity:
      | NormalizedShopifyIdentityEvidence
      | { status: "not_refreshed" };
    progress: ShopifyEvidenceCheckpointProgress;
  }) => Promise<{
    observedContentChecksum: string;
    identityHmacId: string | null;
  }>;
};

export async function runShopifyEvidenceBatch(
  payload: ShopifyEvidenceBatchPayload,
  deps: ShopifyEvidenceRunnerDependencies,
): Promise<ShopifyEvidenceBatchResult> {
  if (payload.lineCompleteness === "partial") {
    return {
      kind: "terminal",
      status: "partial",
      nextCursor: null,
      committedCursor: payload.cursor,
      counts: { ...payload.counts },
      identityCapability: payload.identityCapability,
      lineCompleteness: payload.lineCompleteness,
    };
  }

  const keyring = deps.loadKeyring();
  const suppressionKey = deps.loadSuppressionKey();
  const scope: IdentityScope = {
    organizationId: payload.organizationId,
    storeId: payload.storeId,
  };
  const store = await deps.loadStore(scope);
  if (
    store.shopDomain.trim().toLowerCase() !==
    deps.configuredShopDomain.trim().toLowerCase()
  ) {
    throw new Error("configured Shopify domain does not match the scoped store");
  }
  await deps.ensureCryptoPolicy({
    scope,
    keyChecks: computeIdentityCryptoKeyChecks({
      scope,
      keyring,
      suppressionKey,
    }),
  });

  const batch = await deps.listOrderBatch(
    scope,
    { from: payload.from, to: payload.to },
    payload.cursor,
  );
  const counts = { ...payload.counts };
  let identityCapability = payload.identityCapability;
  let lineCompleteness: ShopifyEvidenceCheckpointProgress["lineCompleteness"] =
    payload.lineCompleteness;
  let lastCommittedCursor = payload.cursor;

  for (const order of batch.orders) {
    counts.ordersRead += 1;
    const nextCommittedCursor = {
      orderCreatedAt: order.orderCreatedAt,
      id: order.id,
    };
    let lines: CompleteShopifyLineSet | null = null;
    let lineDisposition: "complete" | "preserved_partial" = "complete";
    let identity:
      | NormalizedShopifyIdentityEvidence
      | { status: "not_refreshed" } = { status: "not_refreshed" };
    let stopPartial = false;

    try {
      lines = await deps.fetchLines(deps.graphql, order.shopifyOrderId);
    } catch (error) {
      if (isRetryableShopifyLineFailure(error)) throw error;
      lineDisposition = "preserved_partial";
      identity = { status: "not_refreshed" };
      counts.ordersPartial += 1;
      counts.failures += 1;
      lineCompleteness = "partial";
      stopPartial = true;
    }

    if (!stopPartial) {
      counts.ordersEnriched += 1;
      if (lineCompleteness === "unknown") lineCompleteness = "complete";
      identity =
        identityCapability === "unavailable"
          ? {
              status: "unavailable",
              reason: "protected_identity_unavailable",
            }
          : await deps.fetchIdentity({
              graphql: deps.graphql,
              shopifyOrderId: order.shopifyOrderId,
              scope,
              keyring,
              suppressionKey,
            });
      if (identity.status === "unavailable") {
        identityCapability = "unavailable";
        counts.ordersPartial += 1;
        counts.ordersUnavailable += 1;
        counts.warnings += 1;
      } else if (identityCapability === "unknown") {
        identityCapability = "available";
      }
    }

    await deps.commitOrder({
      scope,
      evidenceRunId: payload.runId,
      orderId: order.id,
      shopifyOrderId: order.shopifyOrderId,
      expectedCursor: lastCommittedCursor,
      nextCursor: nextCommittedCursor,
      lines,
      lineDisposition,
      identity,
      progress: { counts, identityCapability, lineCompleteness },
    });
    lastCommittedCursor = nextCommittedCursor;

    if (stopPartial) {
      return {
        kind: "terminal",
        status: "partial",
        nextCursor: null,
        committedCursor: lastCommittedCursor,
        counts,
        identityCapability,
        lineCompleteness,
      };
    }
  }

  if (batch.nextCursor) {
    return {
      kind: "continue",
      nextCursor: batch.nextCursor,
      committedCursor: lastCommittedCursor,
      counts,
      identityCapability,
      lineCompleteness,
    };
  }

  return {
    kind: "terminal",
    status: "success",
    nextCursor: null,
    committedCursor: lastCommittedCursor,
    counts,
    identityCapability,
    lineCompleteness,
  };
}
