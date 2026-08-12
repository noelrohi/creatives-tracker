import { idempotencyKeys, logger, metadata, task, tasks } from "@trigger.dev/sdk";
import { getShopifyShopDomain, shopifyGraphql } from "@/lib/shopify-admin";
import {
  fetchCompleteShopifyOrderLines,
  fetchShopifyIdentityEvidence,
  probeShopifyEvidenceCapabilities,
} from "@/lib/shopify-evidence-admin";
import {
  commitShopifyEvidenceOrder,
  countEvidenceOrders,
  ensureIdentityCryptoPolicy,
  failExpiredShopifyEvidenceRun,
  failShopifyEvidenceRunAfterRetryExhaustion,
  finishShopifyEvidenceRun,
  listEvidenceOrderBatch,
  loadEvidenceRunByStartTriggerId,
  loadEvidenceStore,
  loadShopifyEvidenceRun,
  reconcileShopifyEvidenceStoreForStart,
  recordFirstBatchTriggerRunId,
  renewShopifyEvidenceRunHeartbeat,
  resolveConfiguredEvidenceStore,
  startShopifyEvidenceRun,
  type EvidenceOrderCursor,
} from "@/lib/shopify-evidence-store";
import {
  runShopifyEvidenceBatch,
  type ShopifyEvidenceBatchPayload,
  type ShopifyEvidenceBatchResult,
} from "@/lib/shopify-evidence-runner";
import {
  deriveShopifyEvidenceWindow,
  formatStoreDayAtInstant,
  type ShopifyEvidenceMode,
} from "@/lib/evidence-window";
import {
  computeIdentityCryptoKeyChecks,
  parseErasureSuppressionKey,
  parseIdentityHmacKeyring,
} from "@/lib/identity-hmac";
import { ATTRIBUTION_TASK_RETRY } from "./retry";

const SHOPIFY_EVIDENCE_QUEUE = {
  name: "shopify-evidence",
  concurrencyLimit: 1,
};

const IDEMPOTENCY_KEY_TTL = "7d";

export type ShopifyEvidenceStartPayload = {
  mode: ShopifyEvidenceMode;
};

export type ShopifyEvidenceContinuationPayload = {
  runId: string;
};

export type ShopifyEvidenceStartResult = {
  evidenceRunId: string;
  triggerRunId: string;
  terminal: boolean;
};

export function assertExactEvidenceStartPayload(
  value: unknown,
): asserts value is ShopifyEvidenceStartPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    Array.isArray(input) ||
    (input.mode !== "initial_90d" && input.mode !== "incremental_7d") ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Shopify evidence start accepts only an approved mode");
  }
}

export function assertExactEvidenceContinuationPayload(
  value: unknown,
): asserts value is ShopifyEvidenceContinuationPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    Array.isArray(input) ||
    typeof input.runId !== "string" ||
    input.runId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Shopify evidence continuation accepts only a run ID");
  }
}

function cursorsEqual(
  left: EvidenceOrderCursor | null,
  right: EvidenceOrderCursor | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.id === right.id &&
    left.orderCreatedAt.getTime() === right.orderCreatedAt.getTime()
  );
}

function continuationKey(runId: string, cursor: EvidenceOrderCursor): string {
  return `shopify-evidence:batch:${runId}:${cursor.orderCreatedAt.toISOString()}:${cursor.id}`;
}

async function enqueueBatch(
  payload: ShopifyEvidenceContinuationPayload,
  key: string,
) {
  const idempotencyKey = await idempotencyKeys.create(key, {
    scope: "global",
  });
  return tasks.trigger("shopify-evidence-batch", payload, {
    idempotencyKey,
    idempotencyKeyTTL: IDEMPOTENCY_KEY_TTL,
  });
}

export type ShopifyEvidenceBatchOrchestrationDependencies = {
  loadRun: typeof loadShopifyEvidenceRun;
  renewHeartbeat: typeof renewShopifyEvidenceRunHeartbeat;
  runBatch: (
    payload: ShopifyEvidenceBatchPayload,
  ) => Promise<ShopifyEvidenceBatchResult>;
  enqueue: typeof enqueueBatch;
  finishRun: typeof finishShopifyEvidenceRun;
  setMetadata: (key: string, value: string) => void;
};

function productionBatchDependencies(): ShopifyEvidenceBatchOrchestrationDependencies {
  return {
    loadRun: loadShopifyEvidenceRun,
    renewHeartbeat: renewShopifyEvidenceRunHeartbeat,
    runBatch: (batchPayload) =>
      runShopifyEvidenceBatch(batchPayload, {
        configuredShopDomain: getShopifyShopDomain(),
        loadKeyring: parseIdentityHmacKeyring,
        loadSuppressionKey: parseErasureSuppressionKey,
        ensureCryptoPolicy: ensureIdentityCryptoPolicy,
        loadStore: loadEvidenceStore,
        graphql: shopifyGraphql,
        listOrderBatch: listEvidenceOrderBatch,
        fetchLines: fetchCompleteShopifyOrderLines,
        fetchIdentity: fetchShopifyIdentityEvidence,
        commitOrder: commitShopifyEvidenceOrder,
      }),
    enqueue: enqueueBatch,
    finishRun: finishShopifyEvidenceRun,
    setMetadata: (key, value) => {
      metadata.set(key, value);
    },
  };
}

export async function executeShopifyEvidenceBatch(
  payload: ShopifyEvidenceContinuationPayload,
  now = new Date(),
  deps = productionBatchDependencies(),
) {
  assertExactEvidenceContinuationPayload(payload);
  const run = await deps.loadRun(payload.runId);
  if (!run) throw new Error("Shopify evidence run was not found");
  if (run.status !== "running") {
    throw new Error("Shopify evidence continuation requires a running run");
  }

  const expectedWindow = deriveShopifyEvidenceWindow({
    mode: run.mode,
    anchorStoreDay: run.anchorStoreDay,
    timeZone: run.storeTimezone,
  });
  if (
    expectedWindow.from.getTime() !== run.window.from.getTime() ||
    expectedWindow.to.getTime() !== run.window.to.getTime()
  ) {
    throw new Error("Shopify evidence persisted window is invalid");
  }

  const scope = run.scope;
  await deps.renewHeartbeat(scope, run.id, now);
  deps.setMetadata("evidenceRunId", run.id);
  deps.setMetadata("status", "enriching");
  const result = await deps.runBatch({
    ...scope,
    ...run.window,
    runId: run.id,
    cursor: run.cursor,
    counts: run.counts,
    identityCapability: run.identityCapability,
    lineCompleteness: run.lineCompleteness,
  });

  if (result.kind === "continue") {
    if (!cursorsEqual(result.nextCursor, result.committedCursor)) {
      throw new Error("Shopify evidence continuation cursor conflicts");
    }
    await deps.enqueue(
      { runId: run.id },
      continuationKey(run.id, result.nextCursor),
    );
    deps.setMetadata("status", "continued");
    return { kind: "continue" as const, runId: run.id };
  }

  await deps.finishRun({
    scope,
    runId: run.id,
    expectedCursor: result.committedCursor,
    status: result.status,
    progress: {
      counts: result.counts,
      identityCapability: result.identityCapability,
      lineCompleteness: result.lineCompleteness,
    },
    error: result.status === "partial" ? "incomplete_line_set" : null,
    now,
  });
  deps.setMetadata("status", result.status);
  return { kind: "terminal" as const, runId: run.id, status: result.status };
}

export type ShopifyEvidenceStartOrchestrationDependencies = {
  loadByStartTriggerId: typeof loadEvidenceRunByStartTriggerId;
  loadRun: typeof loadShopifyEvidenceRun;
  failExpiredRun: typeof failExpiredShopifyEvidenceRun;
  captureSecretPolicy: () => (
    scope: { organizationId: string; storeId: string },
  ) => void;
  getConfiguredDomain: () => string;
  resolveStore: typeof resolveConfiguredEvidenceStore;
  reconcileStore: typeof reconcileShopifyEvidenceStoreForStart;
  probeCapabilities: typeof probeShopifyEvidenceCapabilities;
  countOrders: typeof countEvidenceOrders;
  startRun: typeof startShopifyEvidenceRun;
  enqueue: typeof enqueueBatch;
  recordFirstBatch: typeof recordFirstBatchTriggerRunId;
  logTerminal: (input: { evidenceRunId: string; status: string }) => void;
};

function productionStartDependencies(): ShopifyEvidenceStartOrchestrationDependencies {
  return {
    loadByStartTriggerId: loadEvidenceRunByStartTriggerId,
    loadRun: loadShopifyEvidenceRun,
    failExpiredRun: failExpiredShopifyEvidenceRun,
    captureSecretPolicy: () => {
      const keyring = parseIdentityHmacKeyring();
      const suppressionKey = parseErasureSuppressionKey();
      return (scope) => {
        computeIdentityCryptoKeyChecks({ scope, keyring, suppressionKey });
      };
    },
    getConfiguredDomain: getShopifyShopDomain,
    resolveStore: resolveConfiguredEvidenceStore,
    reconcileStore: reconcileShopifyEvidenceStoreForStart,
    probeCapabilities: () =>
      probeShopifyEvidenceCapabilities(shopifyGraphql),
    countOrders: countEvidenceOrders,
    startRun: startShopifyEvidenceRun,
    enqueue: enqueueBatch,
    recordFirstBatch: recordFirstBatchTriggerRunId,
    logTerminal: (input) => {
      logger.info("Shopify evidence start is terminal", input);
    },
  };
}

async function handoffFirstBatch(
  scope: { organizationId: string; storeId: string },
  evidenceRunId: string,
  deps: Pick<
    ShopifyEvidenceStartOrchestrationDependencies,
    "enqueue" | "recordFirstBatch"
  >,
): Promise<void> {
  const handle = await deps.enqueue(
    { runId: evidenceRunId },
    `shopify-evidence:first:${evidenceRunId}`,
  );
  await deps.recordFirstBatch({
    scope,
    runId: evidenceRunId,
    triggerRunId: handle.id,
  });
}

function startResult(
  evidenceRunId: string,
  triggerRunId: string,
  terminal: boolean,
): ShopifyEvidenceStartResult {
  return { evidenceRunId, triggerRunId, terminal };
}

const BATCH_PROVEN_TERMINAL_ERRORS = new Set([
  "incomplete_line_set",
  "batch_retries_exhausted",
  "evidence_batch_failed",
]);

function shouldRepairFirstBatchHandoff(run: {
  status: string;
  error: string | null;
}): boolean {
  return (
    run.status === "running" ||
    run.status === "success" ||
    (run.error !== null && BATCH_PROVEN_TERMINAL_ERRORS.has(run.error))
  );
}

async function finishExistingStart(
  run: NonNullable<Awaited<ReturnType<typeof loadShopifyEvidenceRun>>>,
  payload: ShopifyEvidenceStartPayload,
  triggerRunId: string,
  deps: ShopifyEvidenceStartOrchestrationDependencies,
): Promise<ShopifyEvidenceStartResult> {
  if (run.mode !== payload.mode) {
    throw new Error("Shopify evidence start idempotency conflict");
  }
  let authoritative = run;
  if (
    !authoritative.firstBatchTriggerRunId &&
    shouldRepairFirstBatchHandoff(authoritative)
  ) {
    await handoffFirstBatch(authoritative.scope, authoritative.id, deps);
    const reloaded = await deps.loadRun(authoritative.id);
    if (!reloaded) throw new Error("Shopify evidence run was not found");
    authoritative = reloaded;
  }
  return startResult(
    authoritative.id,
    triggerRunId,
    authoritative.status !== "running",
  );
}

export async function executeShopifyEvidenceStart(
  payload: ShopifyEvidenceStartPayload,
  triggerRunId: string,
  now = new Date(),
  deps = productionStartDependencies(),
): Promise<ShopifyEvidenceStartResult> {
  assertExactEvidenceStartPayload(payload);
  if (typeof triggerRunId !== "string" || triggerRunId.length === 0) {
    throw new Error("Shopify evidence start trigger ID is invalid");
  }

  const existing = await deps.loadByStartTriggerId(triggerRunId);
  if (existing) {
    if (existing.mode !== payload.mode) {
      throw new Error("Shopify evidence start idempotency conflict");
    }
    if (existing.status !== "running") {
      return finishExistingStart(existing, payload, triggerRunId, deps);
    }
    await deps.failExpiredRun(existing.scope, existing.id, now);
    const authoritative = await deps.loadRun(existing.id);
    if (!authoritative) throw new Error("Shopify evidence run was not found");
    return finishExistingStart(
      authoritative,
      payload,
      triggerRunId,
      deps,
    );
  }

  const validateSecretPolicy = deps.captureSecretPolicy();
  const store = await deps.resolveStore(deps.getConfiguredDomain());
  const scope = {
    organizationId: store.organizationId,
    storeId: store.id,
  };
  validateSecretPolicy(scope);
  await deps.reconcileStore(scope, now);

  const anchorStoreDay = formatStoreDayAtInstant(now, store.ianaTimezone);
  const window = deriveShopifyEvidenceWindow({
    mode: payload.mode,
    anchorStoreDay,
    timeZone: store.ianaTimezone,
  });
  const capabilities = await deps.probeCapabilities(shopifyGraphql);
  const identityCapability =
    capabilities.identityScope === "declared" ? "unknown" : "unavailable";
  const orderAccessAvailable =
    capabilities.orderScope === "available" &&
    (payload.mode !== "initial_90d" ||
      capabilities.historicalOrders === "available");

  let disposition: Parameters<typeof startShopifyEvidenceRun>[0]["disposition"];
  if (orderAccessAvailable) {
    disposition = { kind: "running", identityCapability };
  } else {
    const eligibleOrders = await deps.countOrders(scope, window);
    disposition = {
      kind: "terminal_unavailable",
      identityCapability,
      counts: {
        ordersRead: 0,
        ordersEnriched: 0,
        ordersPartial: 0,
        ordersUnavailable: eligibleOrders,
        warnings: 1,
        failures: 0,
      },
      errorCode: "required_order_scope_unavailable",
    };
  }

  const inserted = await deps.startRun({
    startTriggerRunId: triggerRunId,
    scope,
    mode: payload.mode,
    storeTimezone: store.ianaTimezone,
    anchorStoreDay,
    window,
    disposition,
    now,
  });
  if (inserted.status !== "running") {
    deps.logTerminal({
      evidenceRunId: inserted.id,
      status: inserted.status,
    });
    return startResult(inserted.id, triggerRunId, true);
  }
  if (!inserted.firstBatchTriggerRunId) {
    await handoffFirstBatch(scope, inserted.id, deps);
  }
  const reloaded = await deps.loadRun(inserted.id);
  if (!reloaded) throw new Error("Shopify evidence run was not found");
  return startResult(reloaded.id, triggerRunId, reloaded.status !== "running");
}

export async function handleShopifyEvidenceBatchTerminalFailure(
  payload: ShopifyEvidenceContinuationPayload,
  deps: Pick<
    ShopifyEvidenceBatchOrchestrationDependencies,
    "loadRun"
  > & {
    failRun: typeof failShopifyEvidenceRunAfterRetryExhaustion;
  } = {
    loadRun: loadShopifyEvidenceRun,
    failRun: failShopifyEvidenceRunAfterRetryExhaustion,
  },
): Promise<void> {
  assertExactEvidenceContinuationPayload(payload);
  const run = await deps.loadRun(payload.runId);
  if (!run) return;
  await deps.failRun(run.scope, run.id, "batch");
}

export async function handleShopifyEvidenceStartTerminalFailure(
  payload: ShopifyEvidenceStartPayload,
  startTriggerRunId: string,
  deps: {
    loadByStartTriggerId: typeof loadEvidenceRunByStartTriggerId;
    failRun: typeof failShopifyEvidenceRunAfterRetryExhaustion;
  } = {
    loadByStartTriggerId: loadEvidenceRunByStartTriggerId,
    failRun: failShopifyEvidenceRunAfterRetryExhaustion,
  },
): Promise<void> {
  assertExactEvidenceStartPayload(payload);
  const run = await deps.loadByStartTriggerId(startTriggerRunId);
  if (!run) return;
  await deps.failRun(run.scope, run.id, "start");
}

export const shopifyEvidenceBatchTask = task<
  "shopify-evidence-batch",
  ShopifyEvidenceContinuationPayload
>({
  id: "shopify-evidence-batch",
  retry: ATTRIBUTION_TASK_RETRY,
  queue: SHOPIFY_EVIDENCE_QUEUE,
  maxDuration: 600,
  onFailure: async ({ payload }) => {
    await handleShopifyEvidenceBatchTerminalFailure(payload);
  },
  run: async (payload: ShopifyEvidenceContinuationPayload) =>
    executeShopifyEvidenceBatch(payload),
});

export const shopifyEvidenceStartTask = task<
  "shopify-evidence-start",
  ShopifyEvidenceStartPayload,
  ShopifyEvidenceStartResult
>({
  id: "shopify-evidence-start",
  retry: ATTRIBUTION_TASK_RETRY,
  queue: SHOPIFY_EVIDENCE_QUEUE,
  maxDuration: 600,
  onFailure: async ({ payload, ctx }) => {
    await handleShopifyEvidenceStartTerminalFailure(payload, ctx.run.id);
  },
  run: async (payload: ShopifyEvidenceStartPayload, { ctx }) =>
    executeShopifyEvidenceStart(payload, ctx.run.id),
});
