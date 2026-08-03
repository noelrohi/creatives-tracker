import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  assertValidIanaTimezone,
  assertValidStoreDay,
  deriveShopifyEvidenceWindow,
  type HalfOpenWindow,
  type ShopifyEvidenceMode,
} from "@/lib/evidence-window";
import type { IdentityCryptoKeyChecks, IdentityScope } from "@/lib/identity-hmac";
import type {
  CompleteShopifyLineSet,
  NormalizedShopifyIdentityEvidence,
} from "@/lib/shopify-evidence-admin";
import {
  identityCryptoPolicies,
  identityErasureSuppressions,
  identityMatchingKeyBindings,
  shopifyEvidenceRunIdentityObservations,
  shopifyEvidenceRunObservations,
  shopifyEvidenceSyncRuns,
  shopifyOrderLines,
  sourceIdentityHmacs,
} from "@/schema/shopify-evidence";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";

export type EvidenceOrderCursor = {
  orderCreatedAt: Date;
  id: string;
};

export type EvidenceOrderBatch = {
  orders: Array<{
    id: string;
    shopifyOrderId: string;
    orderCreatedAt: Date;
  }>;
  nextCursor: EvidenceOrderCursor | null;
};

export type ShopifyEvidenceRunCounts = {
  ordersRead: number;
  ordersEnriched: number;
  ordersPartial: number;
  ordersUnavailable: number;
  warnings: number;
  failures: number;
};

export type ShopifyEvidenceRunProgress = {
  counts: ShopifyEvidenceRunCounts;
  identityCapability: "unknown" | "available" | "unavailable";
  lineCompleteness: "unknown" | "complete" | "partial" | "unavailable";
};

export type ShopifyEvidenceStartDisposition =
  | {
      kind: "running";
      identityCapability: "unknown" | "unavailable";
    }
  | {
      kind: "terminal_unavailable";
      identityCapability: "unknown" | "unavailable";
      counts: ShopifyEvidenceRunCounts;
      errorCode: "required_order_scope_unavailable";
    };

export const SHOPIFY_EVIDENCE_STALE_AFTER_MS = 20 * 60 * 1000;

type EvidenceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type EvidenceExecutor = typeof db | EvidenceTransaction;

const EVIDENCE_COUNT_KEYS = [
  "ordersRead",
  "ordersEnriched",
  "ordersPartial",
  "ordersUnavailable",
  "warnings",
  "failures",
] as const;

const IDENTITY_TRANSITIONS = {
  unknown: ["unknown", "available", "unavailable"],
  available: ["available", "unavailable"],
  unavailable: ["unavailable"],
} as const;

const LINE_TRANSITIONS = {
  unknown: ["unknown", "complete", "partial", "unavailable"],
  complete: ["complete", "partial"],
  partial: ["partial"],
  unavailable: ["unavailable"],
} as const;

const SAFE_FINISH_ERRORS = new Set([
  "required_order_scope_unavailable",
  "incomplete_line_set",
  "protected_identity_unavailable",
  "evidence_batch_failed",
]);

const SAFE_PERSISTED_ERRORS = new Set([
  ...SAFE_FINISH_ERRORS,
  "start_retries_exhausted",
  "batch_retries_exhausted",
  "lease_expired",
]);

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
}

function assertValidWindow(window: HalfOpenWindow): void {
  assertValidDate(window.from, "Evidence window start");
  assertValidDate(window.to, "Evidence window end");
  if (window.from.getTime() >= window.to.getTime()) {
    throw new Error("Evidence window must be half-open");
  }
}

function assertValidCursor(cursor: EvidenceOrderCursor, label: string): void {
  assertValidDate(cursor.orderCreatedAt, `${label} orderCreatedAt`);
  if (typeof cursor.id !== "string" || cursor.id.length === 0) {
    throw new Error(`${label} id is invalid`);
  }
}

function encodeEvidenceOrderCursor(cursor: EvidenceOrderCursor): string {
  assertValidCursor(cursor, "Shopify evidence cursor");
  return Buffer.from(
    JSON.stringify({
      orderCreatedAt: cursor.orderCreatedAt.toISOString(),
      id: cursor.id,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeEvidenceOrderCursor(encoded: string): EvidenceOrderCursor {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
      throw new Error("non-canonical encoding");
    }
    const input = JSON.parse(decoded) as Record<string, unknown> | null;
    if (
      !input ||
      Object.keys(input).length !== 2 ||
      typeof input.orderCreatedAt !== "string" ||
      typeof input.id !== "string"
    ) {
      throw new Error("invalid cursor shape");
    }
    const cursor = {
      orderCreatedAt: new Date(input.orderCreatedAt),
      id: input.id,
    };
    assertValidCursor(cursor, "Persisted Shopify evidence cursor");
    if (cursor.orderCreatedAt.toISOString() !== input.orderCreatedAt) {
      throw new Error("non-canonical cursor timestamp");
    }
    return cursor;
  } catch {
    throw new Error("Shopify evidence persisted cursor is invalid");
  }
}

function assertForwardEvidenceCursor(
  expected: EvidenceOrderCursor | null,
  next: EvidenceOrderCursor,
): void {
  assertValidCursor(next, "Next Shopify evidence cursor");
  if (expected) assertValidCursor(expected, "Expected Shopify evidence cursor");
  if (
    expected &&
    (next.orderCreatedAt.getTime() < expected.orderCreatedAt.getTime() ||
      (next.orderCreatedAt.getTime() === expected.orderCreatedAt.getTime() &&
        next.id <= expected.id))
  ) {
    throw new Error("Shopify evidence cursor must advance");
  }
}

function currentCounts(row: ShopifyEvidenceRunCounts): ShopifyEvidenceRunCounts {
  return Object.fromEntries(
    EVIDENCE_COUNT_KEYS.map((key) => [key, row[key]]),
  ) as ShopifyEvidenceRunCounts;
}

function assertNondecreasingEvidenceCounts(
  current: ShopifyEvidenceRunCounts,
  next: ShopifyEvidenceRunCounts,
): void {
  for (const key of EVIDENCE_COUNT_KEYS) {
    if (
      !Number.isSafeInteger(next[key]) ||
      next[key] < 0 ||
      next[key] < current[key]
    ) {
      throw new Error("Shopify evidence counts cannot decrease");
    }
  }
}

function assertEvidenceStateTransitions(
  current: Omit<ShopifyEvidenceRunProgress, "counts">,
  next: ShopifyEvidenceRunProgress,
): void {
  if (
    !IDENTITY_TRANSITIONS[current.identityCapability].includes(
      next.identityCapability as never,
    ) ||
    !LINE_TRANSITIONS[current.lineCompleteness].includes(
      next.lineCompleteness as never,
    )
  ) {
    throw new Error("Shopify evidence state transition is invalid");
  }
}

function assertExactEvidenceProgress(
  current: ShopifyEvidenceRunCounts &
    Omit<ShopifyEvidenceRunProgress, "counts">,
  next: ShopifyEvidenceRunProgress,
  errorMessage: string,
): void {
  if (
    EVIDENCE_COUNT_KEYS.some((key) => current[key] !== next.counts[key]) ||
    current.identityCapability !== next.identityCapability ||
    current.lineCompleteness !== next.lineCompleteness
  ) {
    throw new Error(errorMessage);
  }
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBytes.length === rightBytes.length;
}

function cryptoPolicyConflict(): never {
  throw new Error("identity_crypto_policy_conflict");
}

function validateIdentityCryptoKeyChecks(
  keyChecks: IdentityCryptoKeyChecks,
): { matchingVersion: string; matchingCheck: string; suppressionVersion: string; suppressionCheck: string } {
  if (
    typeof keyChecks !== "object" ||
    keyChecks === null ||
    !Array.isArray(keyChecks.matching) ||
    keyChecks.matching.length !== 1 ||
    typeof keyChecks.matching[0]?.keyVersion !== "string" ||
    keyChecks.matching[0].keyVersion.length === 0 ||
    typeof keyChecks.matching[0]?.keyCheck !== "string" ||
    keyChecks.matching[0].keyCheck.length === 0 ||
    typeof keyChecks.suppression !== "object" ||
    keyChecks.suppression === null ||
    typeof keyChecks.suppression.keyVersion !== "string" ||
    keyChecks.suppression.keyVersion.length === 0 ||
    typeof keyChecks.suppression.keyCheck !== "string" ||
    keyChecks.suppression.keyCheck.length === 0
  ) {
    return cryptoPolicyConflict();
  }
  return {
    matchingVersion: keyChecks.matching[0].keyVersion,
    matchingCheck: keyChecks.matching[0].keyCheck,
    suppressionVersion: keyChecks.suppression.keyVersion,
    suppressionCheck: keyChecks.suppression.keyCheck,
  };
}

async function lockEvidenceStore(
  executor: EvidenceExecutor,
  scope: IdentityScope,
): Promise<void> {
  const [store] = await executor
    .select({ id: shopifyStores.id })
    .from(shopifyStores)
    .where(
      and(
        eq(shopifyStores.organizationId, scope.organizationId),
        eq(shopifyStores.id, scope.storeId),
      ),
    )
    .limit(1)
    .for("update");
  if (!store) throw new Error("Shopify evidence store is outside this scope");
}

export async function loadEvidenceStore(scope: IdentityScope) {
  const [store] = await db
    .select({
      id: shopifyStores.id,
      organizationId: shopifyStores.organizationId,
      shopDomain: shopifyStores.shopDomain,
      ianaTimezone: shopifyStores.ianaTimezone,
      currency: shopifyStores.currency,
    })
    .from(shopifyStores)
    .where(
      and(
        eq(shopifyStores.id, scope.storeId),
        eq(shopifyStores.organizationId, scope.organizationId),
      ),
    )
    .limit(1);
  if (!store) throw new Error("Shopify evidence store binding was not found");
  return store;
}

export async function resolveConfiguredEvidenceStore(shopDomain: string) {
  const normalizedDomain = shopDomain.trim().toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(
      normalizedDomain,
    )
  ) {
    throw new Error("Configured Shopify evidence domain is invalid");
  }
  const matches = await db
    .select({
      id: shopifyStores.id,
      organizationId: shopifyStores.organizationId,
      shopDomain: shopifyStores.shopDomain,
      ianaTimezone: shopifyStores.ianaTimezone,
    })
    .from(shopifyStores)
    .where(sql`lower(btrim(${shopifyStores.shopDomain})) = ${normalizedDomain}`)
    .limit(2);
  if (matches.length !== 1) {
    throw new Error(
      "Expected exactly one configured Shopify evidence store",
    );
  }
  const store = matches[0];
  assertValidIanaTimezone(store.ianaTimezone);
  return store;
}

export async function listEvidenceOrderBatch(
  scope: IdentityScope,
  window: HalfOpenWindow,
  cursor: EvidenceOrderCursor | null,
  requestedLimit = 25,
): Promise<EvidenceOrderBatch> {
  assertValidWindow(window);
  if (!Number.isFinite(requestedLimit)) {
    throw new Error("Evidence batch limit is invalid");
  }
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 100);
  if (cursor) assertValidCursor(cursor, "Evidence order cursor");
  const cursorWhere = cursor
    ? or(
        gt(shopifyOrders.orderCreatedAt, cursor.orderCreatedAt),
        and(
          eq(shopifyOrders.orderCreatedAt, cursor.orderCreatedAt),
          gt(shopifyOrders.id, cursor.id),
        ),
      )
    : undefined;
  const rows = await db
    .select({
      id: shopifyOrders.id,
      shopifyOrderId: shopifyOrders.shopifyOrderId,
      orderCreatedAt: shopifyOrders.orderCreatedAt,
    })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, scope.organizationId),
        eq(shopifyOrders.storeId, scope.storeId),
        gte(shopifyOrders.orderCreatedAt, window.from),
        lt(shopifyOrders.orderCreatedAt, window.to),
        cursorWhere,
      ),
    )
    .orderBy(asc(shopifyOrders.orderCreatedAt), asc(shopifyOrders.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const orders = rows.slice(0, limit);
  const last = orders.at(-1);
  return {
    orders,
    nextCursor:
      hasMore && last
        ? { orderCreatedAt: last.orderCreatedAt, id: last.id }
        : null,
  };
}

export async function countEvidenceOrders(
  scope: IdentityScope,
  window: HalfOpenWindow,
): Promise<number> {
  assertValidWindow(window);
  const [row] = await db
    .select({ value: count() })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, scope.organizationId),
        eq(shopifyOrders.storeId, scope.storeId),
        gte(shopifyOrders.orderCreatedAt, window.from),
        lt(shopifyOrders.orderCreatedAt, window.to),
      ),
    );
  const value = Number(row?.value ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Evidence order count is invalid");
  }
  return value;
}

async function ensureIdentityCryptoPolicyWithExecutor(
  scope: IdentityScope,
  keyChecks: IdentityCryptoKeyChecks,
  executor: EvidenceExecutor,
): Promise<void> {
  const checks = validateIdentityCryptoKeyChecks(keyChecks);
  await executor
    .insert(identityMatchingKeyBindings)
    .values({
      organizationId: scope.organizationId,
      storeId: scope.storeId,
      keyVersion: checks.matchingVersion,
      keyCheck: checks.matchingCheck,
    })
    .onConflictDoNothing();

  const [binding] = await executor
    .select({ keyCheck: identityMatchingKeyBindings.keyCheck })
    .from(identityMatchingKeyBindings)
    .where(
      and(
        eq(identityMatchingKeyBindings.organizationId, scope.organizationId),
        eq(identityMatchingKeyBindings.storeId, scope.storeId),
        eq(identityMatchingKeyBindings.keyVersion, checks.matchingVersion),
      ),
    )
    .limit(1);
  if (!binding || !constantTimeTextEqual(binding.keyCheck, checks.matchingCheck)) {
    return cryptoPolicyConflict();
  }

  await executor
    .insert(identityCryptoPolicies)
    .values({
      organizationId: scope.organizationId,
      storeId: scope.storeId,
      matchingCurrentVersion: checks.matchingVersion,
      matchingCurrentKeyCheck: checks.matchingCheck,
      suppressionVersion: checks.suppressionVersion,
      suppressionKeyCheck: checks.suppressionCheck,
    })
    .onConflictDoNothing();

  await validateExistingIdentityCryptoPolicyWithExecutor(
    scope,
    keyChecks,
    executor,
  );
}

async function validateExistingIdentityCryptoPolicyWithExecutor(
  scope: IdentityScope,
  keyChecks: IdentityCryptoKeyChecks,
  executor: EvidenceExecutor,
): Promise<void> {
  const checks = validateIdentityCryptoKeyChecks(keyChecks);
  const [binding] = await executor
    .select({ keyCheck: identityMatchingKeyBindings.keyCheck })
    .from(identityMatchingKeyBindings)
    .where(
      and(
        eq(identityMatchingKeyBindings.organizationId, scope.organizationId),
        eq(identityMatchingKeyBindings.storeId, scope.storeId),
        eq(identityMatchingKeyBindings.keyVersion, checks.matchingVersion),
      ),
    )
    .limit(1);
  if (!binding || !constantTimeTextEqual(binding.keyCheck, checks.matchingCheck)) {
    return cryptoPolicyConflict();
  }

  const [policy] = await executor
    .select()
    .from(identityCryptoPolicies)
    .where(
      and(
        eq(identityCryptoPolicies.organizationId, scope.organizationId),
        eq(identityCryptoPolicies.storeId, scope.storeId),
      ),
    )
    .limit(1);
  if (
    !policy ||
    policy.matchingPreviousVersion !== null ||
    policy.matchingPreviousKeyCheck !== null ||
    policy.matchingCurrentVersion !== checks.matchingVersion ||
    policy.suppressionVersion !== checks.suppressionVersion ||
    !constantTimeTextEqual(
      policy.matchingCurrentKeyCheck,
      checks.matchingCheck,
    ) ||
    !constantTimeTextEqual(policy.suppressionKeyCheck, checks.suppressionCheck)
  ) {
    return cryptoPolicyConflict();
  }
}

export async function ensureIdentityCryptoPolicy(input: {
  scope: IdentityScope;
  keyChecks: IdentityCryptoKeyChecks;
  executor?: EvidenceExecutor;
}): Promise<void> {
  if (input.executor) {
    await ensureIdentityCryptoPolicyWithExecutor(
      input.scope,
      input.keyChecks,
      input.executor,
    );
    return;
  }
  await db.transaction(async (tx) => {
    await lockEvidenceStore(tx, input.scope);
    await ensureIdentityCryptoPolicyWithExecutor(input.scope, input.keyChecks, tx);
  });
}

async function resolveScopedOrder(
  executor: EvidenceExecutor,
  scope: IdentityScope,
  shopifyOrderId: string,
  internalOrderId?: string,
  lock = false,
) {
  let query = executor
    .select({
      id: shopifyOrders.id,
      shopifyOrderId: shopifyOrders.shopifyOrderId,
      orderCreatedAt: shopifyOrders.orderCreatedAt,
    })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, scope.organizationId),
        eq(shopifyOrders.storeId, scope.storeId),
        eq(shopifyOrders.shopifyOrderId, shopifyOrderId),
        internalOrderId ? eq(shopifyOrders.id, internalOrderId) : undefined,
      ),
    )
    .limit(1);
  if (lock) query = query.for("update") as typeof query;
  const [order] = await query;
  if (!order) throw new Error("Scoped Shopify evidence order was not found");
  return order;
}

async function replaceCompleteLineSetWithExecutor(
  executor: EvidenceExecutor,
  scope: IdentityScope,
  orderId: string,
  evidence: CompleteShopifyLineSet,
): Promise<void> {
  if (
    evidence.completeness !== "complete" ||
    !(evidence.orderUpdatedAt instanceof Date) ||
    Number.isNaN(evidence.orderUpdatedAt.getTime()) ||
    !Array.isArray(evidence.lines)
  ) {
    throw new Error("Shopify evidence line set is not complete");
  }
  await executor.delete(shopifyOrderLines).where(
    and(
      eq(shopifyOrderLines.organizationId, scope.organizationId),
      eq(shopifyOrderLines.storeId, scope.storeId),
      eq(shopifyOrderLines.orderId, orderId),
    ),
  );
  if (evidence.lines.length === 0) return;
  await executor.insert(shopifyOrderLines).values(
    evidence.lines.map((line) => ({
      organizationId: scope.organizationId,
      storeId: scope.storeId,
      orderId,
      shopifyLineItemId: line.shopifyLineItemId,
      shopifyProductId: line.shopifyProductId,
      shopifyVariantId: line.shopifyVariantId,
      sku: line.sku,
      productTitle: line.productTitle,
      variantTitle: line.variantTitle,
      quantity: line.quantity,
      sourcePosition: line.sourcePosition,
      parentOrderUpdatedAt: evidence.orderUpdatedAt,
    })),
  );
}

export async function replaceCompleteShopifyLineSet(
  scope: IdentityScope,
  evidence: CompleteShopifyLineSet,
): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await resolveScopedOrder(
      tx,
      scope,
      evidence.shopifyOrderId,
      undefined,
      true,
    );
    await replaceCompleteLineSetWithExecutor(tx, scope, order.id, evidence);
  });
}

type IdentityPersistenceResult = {
  disposition: "available" | "suppressed" | "unavailable";
  identityHmacId: string | null;
};

function identityEvidenceInvalid(): never {
  throw new Error("shopify_identity_evidence_invalid");
}

function assertAvailableIdentityEvidence(
  evidence: Extract<NormalizedShopifyIdentityEvidence, { status: "available" }>,
): void {
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    typeof evidence.keyChecks !== "object" ||
    evidence.keyChecks === null ||
    !Array.isArray(evidence.keyChecks.matching) ||
    evidence.keyChecks.matching.length !== 1 ||
    typeof evidence.keyChecks.matching[0]?.keyVersion !== "string" ||
    evidence.keyChecks.matching[0].keyVersion.length === 0 ||
    typeof evidence.keyChecks.matching[0]?.keyCheck !== "string" ||
    evidence.keyChecks.matching[0].keyCheck.length === 0 ||
    typeof evidence.keyChecks.suppression !== "object" ||
    evidence.keyChecks.suppression === null ||
    typeof evidence.keyChecks.suppression.keyVersion !== "string" ||
    evidence.keyChecks.suppression.keyVersion.length === 0 ||
    typeof evidence.keyChecks.suppression.keyCheck !== "string" ||
    evidence.keyChecks.suppression.keyCheck.length === 0 ||
    (evidence.shopifyCustomerId !== null &&
      (typeof evidence.shopifyCustomerId !== "string" ||
        evidence.shopifyCustomerId.length === 0)) ||
    !Array.isArray(evidence.digests) ||
    evidence.digests.length > 1 ||
    !Array.isArray(evidence.suppressionCandidates) ||
    !Array.isArray(evidence.evaluatedKeyVersions) ||
    evidence.evaluatedKeyVersions.length !== 1 ||
    evidence.evaluatedKeyVersions[0] !==
      evidence.keyChecks.matching[0]?.keyVersion ||
    evidence.digests.some(
      (digest) =>
        typeof digest !== "object" ||
        digest === null ||
        digest.keyVersion !== evidence.keyChecks.matching[0]?.keyVersion ||
        typeof digest.digest !== "string" ||
        digest.digest.length === 0 ||
        digest.rotationState !== "active",
    ) ||
    evidence.suppressionCandidates.some(
      (candidate) =>
        typeof candidate !== "object" ||
        candidate === null ||
        (candidate.kind !== "email" &&
          candidate.kind !== "shopify_customer_id") ||
        candidate.keyVersion !== evidence.keyChecks.suppression.keyVersion ||
        typeof candidate.digest !== "string" ||
        candidate.digest.length === 0,
    ) ||
    evidence.suppressionCandidates.some(
      (candidate, index) =>
        evidence.suppressionCandidates.findIndex(
          (other) =>
            other.kind === candidate.kind &&
            other.keyVersion === candidate.keyVersion &&
            other.digest === candidate.digest,
        ) !== index,
    )
  ) {
    return identityEvidenceInvalid();
  }
  const emailCandidates = evidence.suppressionCandidates.filter(
    (candidate) => candidate.kind === "email",
  ).length;
  const customerCandidates = evidence.suppressionCandidates.filter(
    (candidate) => candidate.kind === "shopify_customer_id",
  ).length;
  if (
    emailCandidates !== (evidence.digests.length === 1 ? 1 : 0) ||
    customerCandidates !== (evidence.shopifyCustomerId === null ? 0 : 1)
  ) {
    return identityEvidenceInvalid();
  }
}

async function suppressionExists(
  executor: EvidenceExecutor,
  scope: IdentityScope,
  evidence: Extract<NormalizedShopifyIdentityEvidence, { status: "available" }>,
): Promise<boolean> {
  if (evidence.suppressionCandidates.length === 0) return false;
  const candidates = evidence.suppressionCandidates.map((candidate) =>
    and(
      eq(identityErasureSuppressions.kind, candidate.kind),
      eq(identityErasureSuppressions.keyVersion, candidate.keyVersion),
      eq(identityErasureSuppressions.digest, candidate.digest),
    ),
  );
  const [hit] = await executor
    .select({ id: identityErasureSuppressions.id })
    .from(identityErasureSuppressions)
    .where(
      and(
        eq(identityErasureSuppressions.organizationId, scope.organizationId),
        eq(identityErasureSuppressions.storeId, scope.storeId),
        or(...candidates),
      ),
    )
    .limit(1);
  return Boolean(hit);
}

async function clearOrderIdentity(
  executor: EvidenceExecutor,
  scope: IdentityScope,
  orderId: string,
): Promise<void> {
  await executor.execute(sql`
    update shopify_order
    set shopify_customer_id = null
    where organization_id = ${scope.organizationId}
      and store_id = ${scope.storeId}
      and id = ${orderId}
  `);
  await executor.delete(sourceIdentityHmacs).where(
    and(
      eq(sourceIdentityHmacs.organizationId, scope.organizationId),
      eq(sourceIdentityHmacs.storeId, scope.storeId),
      eq(sourceIdentityHmacs.shopifyOrderId, orderId),
      eq(sourceIdentityHmacs.sourceKind, "shopify_order"),
    ),
  );
}

async function persistAvailableIdentityWithExecutor(
  executor: EvidenceExecutor,
  scope: IdentityScope,
  orderId: string,
  evidence: Extract<NormalizedShopifyIdentityEvidence, { status: "available" }>,
): Promise<IdentityPersistenceResult> {
  assertAvailableIdentityEvidence(evidence);
  if (await suppressionExists(executor, scope, evidence)) {
    await clearOrderIdentity(executor, scope, orderId);
    return { disposition: "suppressed", identityHmacId: null };
  }

  await executor.execute(sql`
    update shopify_order
    set shopify_customer_id = ${evidence.shopifyCustomerId}
    where organization_id = ${scope.organizationId}
      and store_id = ${scope.storeId}
      and id = ${orderId}
  `);

  const existing =
    evidence.evaluatedKeyVersions.length === 0
      ? []
      : await executor
          .select({
            id: sourceIdentityHmacs.id,
            keyVersion: sourceIdentityHmacs.keyVersion,
            digest: sourceIdentityHmacs.digest,
            rotationState: sourceIdentityHmacs.rotationState,
          })
          .from(sourceIdentityHmacs)
          .where(
            and(
              eq(sourceIdentityHmacs.organizationId, scope.organizationId),
              eq(sourceIdentityHmacs.storeId, scope.storeId),
              eq(sourceIdentityHmacs.shopifyOrderId, orderId),
              eq(sourceIdentityHmacs.sourceKind, "shopify_order"),
              inArray(
                sourceIdentityHmacs.keyVersion,
                evidence.evaluatedKeyVersions,
              ),
            ),
          )
          .for("update");
  const existingByVersion = new Map(existing.map((row) => [row.keyVersion, row]));
  const digestByVersion = new Map(
    evidence.digests.map((digest) => [digest.keyVersion, digest]),
  );
  const rowIdByVersion = new Map<string, string>();

  for (const keyVersion of evidence.evaluatedKeyVersions) {
    const current = existingByVersion.get(keyVersion);
    const next = digestByVersion.get(keyVersion);
    if (!next) {
      if (current) {
        await executor
          .delete(sourceIdentityHmacs)
          .where(eq(sourceIdentityHmacs.id, current.id));
      }
      continue;
    }
    if (
      current &&
      constantTimeTextEqual(current.digest, next.digest) &&
      current.rotationState === next.rotationState
    ) {
      rowIdByVersion.set(keyVersion, current.id);
      continue;
    }
    if (current) {
      await executor
        .delete(sourceIdentityHmacs)
        .where(eq(sourceIdentityHmacs.id, current.id));
    }
    const [inserted] = await executor
      .insert(sourceIdentityHmacs)
      .values({
        organizationId: scope.organizationId,
        storeId: scope.storeId,
        sourceKind: "shopify_order",
        shopifyOrderId: orderId,
        keyVersion: next.keyVersion,
        digest: next.digest,
        rotationState: next.rotationState,
      })
      .returning({ id: sourceIdentityHmacs.id });
    if (!inserted) throw new Error("Shopify identity persistence failed");
    rowIdByVersion.set(keyVersion, inserted.id);
  }

  const checks = validateIdentityCryptoKeyChecks(evidence.keyChecks);
  return {
    disposition: "available",
    identityHmacId: rowIdByVersion.get(checks.matchingVersion) ?? null,
  };
}

export async function persistShopifyIdentityEvidence(
  scope: IdentityScope,
  shopifyOrderId: string,
  evidence: NormalizedShopifyIdentityEvidence,
): Promise<IdentityPersistenceResult> {
  if (evidence.status === "unavailable") {
    return { disposition: "unavailable", identityHmacId: null };
  }
  assertAvailableIdentityEvidence(evidence);
  return db.transaction(async (tx) => {
    await lockEvidenceStore(tx, scope);
    const order = await resolveScopedOrder(
      tx,
      scope,
      shopifyOrderId,
      undefined,
      true,
    );
    await ensureIdentityCryptoPolicyWithExecutor(scope, evidence.keyChecks, tx);
    return persistAvailableIdentityWithExecutor(
      tx,
      scope,
      order.id,
      evidence,
    );
  });
}

type CommitIdentityEvidence =
  | NormalizedShopifyIdentityEvidence
  | { status: "not_refreshed" };

export type CommitShopifyEvidenceOrderInput = {
  scope: IdentityScope;
  evidenceRunId: string;
  orderId: string;
  shopifyOrderId: string;
  expectedCursor: EvidenceOrderCursor | null;
  nextCursor: EvidenceOrderCursor;
  lines: CompleteShopifyLineSet | null;
  lineDisposition: "complete" | "preserved_partial";
  identity: CommitIdentityEvidence;
  progress: ShopifyEvidenceRunProgress;
  now?: Date;
};

export type CommitShopifyEvidenceOrderResult = {
  committedCursor: EvidenceOrderCursor;
  observedContentChecksum: string;
  lineDisposition: "complete" | "preserved_partial";
  identityDisposition: "available" | "unavailable" | "not_refreshed" | "suppressed";
  identityHmacId: string | null;
};

function canonicalContentChecksum(input: {
  order: {
    id: string;
    shopifyOrderId: string;
    orderCreatedAt: Date;
  };
  lines: Array<{
    shopifyLineItemId: string;
    shopifyProductId: string | null;
    shopifyVariantId: string | null;
    sku: string | null;
    quantity: number;
  }>;
  lineDisposition: "complete" | "preserved_partial";
  identityDisposition: "available" | "unavailable" | "not_refreshed" | "suppressed";
}): string {
  const sortPart = (value: string | number | null): string => {
    if (value === null) return "0:";
    const text = String(value);
    return `${typeof value === "number" ? "1" : "2"}:${Buffer.byteLength(text, "utf8")}:${text}`;
  };
  const lines = [...input.lines]
    .map((line) => ({
      shopifyLineItemId: line.shopifyLineItemId,
      shopifyProductId: line.shopifyProductId ?? null,
      shopifyVariantId: line.shopifyVariantId ?? null,
      sku: line.sku ?? null,
      quantity: line.quantity,
    }))
    .sort((left, right) => {
      const leftKey = [
        sortPart(left.shopifyLineItemId),
        sortPart(left.shopifyProductId),
        sortPart(left.shopifyVariantId),
        sortPart(left.sku),
        sortPart(left.quantity),
      ]
        .join("\u0000");
      const rightKey = [
        sortPart(right.shopifyLineItemId),
        sortPart(right.shopifyProductId),
        sortPart(right.shopifyVariantId),
        sortPart(right.sku),
        sortPart(right.quantity),
      ].join("\u0000");
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const canonical = JSON.stringify({
    version: 1,
    order: {
      id: input.order.id,
      shopifyOrderId: input.order.shopifyOrderId,
      orderCreatedAt: input.order.orderCreatedAt.toISOString(),
    },
    lines,
    lineDisposition: input.lineDisposition,
    identityDisposition: input.identityDisposition,
  });
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

async function loadMatcherVisibleLines(
  executor: EvidenceExecutor,
  scope: IdentityScope,
  orderId: string,
) {
  return executor
    .select({
      shopifyLineItemId: shopifyOrderLines.shopifyLineItemId,
      shopifyProductId: shopifyOrderLines.shopifyProductId,
      shopifyVariantId: shopifyOrderLines.shopifyVariantId,
      sku: shopifyOrderLines.sku,
      quantity: shopifyOrderLines.quantity,
    })
    .from(shopifyOrderLines)
    .where(
      and(
        eq(shopifyOrderLines.organizationId, scope.organizationId),
        eq(shopifyOrderLines.storeId, scope.storeId),
        eq(shopifyOrderLines.orderId, orderId),
      ),
    );
}

async function loadLockedRunningRun(
  executor: EvidenceExecutor,
  scope: IdentityScope,
  runId: string,
) {
  const [run] = await executor
    .select({
      id: shopifyEvidenceSyncRuns.id,
      cursor: shopifyEvidenceSyncRuns.cursor,
      status: shopifyEvidenceSyncRuns.status,
      ordersRead: shopifyEvidenceSyncRuns.ordersRead,
      ordersEnriched: shopifyEvidenceSyncRuns.ordersEnriched,
      ordersPartial: shopifyEvidenceSyncRuns.ordersPartial,
      ordersUnavailable: shopifyEvidenceSyncRuns.ordersUnavailable,
      warnings: shopifyEvidenceSyncRuns.warnings,
      failures: shopifyEvidenceSyncRuns.failures,
      identityCapability: shopifyEvidenceSyncRuns.identityCapability,
      lineCompleteness: shopifyEvidenceSyncRuns.lineCompleteness,
      requestedFrom: shopifyEvidenceSyncRuns.requestedFrom,
      requestedTo: shopifyEvidenceSyncRuns.requestedTo,
    })
    .from(shopifyEvidenceSyncRuns)
    .where(
      and(
        eq(shopifyEvidenceSyncRuns.id, runId),
        eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
        eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
        eq(shopifyEvidenceSyncRuns.status, "running"),
      ),
    )
    .limit(1)
    .for("update");
  if (!run) throw new Error("Shopify evidence run is not active in this scope");
  return run;
}

export async function commitShopifyEvidenceOrder(
  input: CommitShopifyEvidenceOrderInput,
): Promise<CommitShopifyEvidenceOrderResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "Shopify evidence commit time");
  assertForwardEvidenceCursor(input.expectedCursor, input.nextCursor);
  if (
    (input.lineDisposition === "complete" && !input.lines) ||
    (input.lineDisposition === "preserved_partial" && input.lines !== null)
  ) {
    throw new Error("Shopify evidence line disposition is invalid");
  }
  if (input.lines && input.lines.shopifyOrderId !== input.shopifyOrderId) {
    throw new Error("Shopify evidence line order identity changed");
  }
  if (input.identity.status === "available") {
    assertAvailableIdentityEvidence(input.identity);
  }

  return db.transaction(async (tx) => {
    await lockEvidenceStore(tx, input.scope);
    const run = await loadLockedRunningRun(tx, input.scope, input.evidenceRunId);
    const expectedEncoded = input.expectedCursor
      ? encodeEvidenceOrderCursor(input.expectedCursor)
      : null;
    const nextEncoded = encodeEvidenceOrderCursor(input.nextCursor);
    const replay = run.cursor === nextEncoded;
    if (run.cursor !== expectedEncoded && !replay) {
      throw new Error("Shopify evidence cursor compare-and-set failed");
    }
    if (replay) {
      assertExactEvidenceProgress(
        run,
        input.progress,
        "Shopify evidence replay progress conflicts",
      );
    } else {
      assertNondecreasingEvidenceCounts(currentCounts(run), input.progress.counts);
      assertEvidenceStateTransitions(run, input.progress);
    }
    const order = await resolveScopedOrder(
      tx,
      input.scope,
      input.shopifyOrderId,
      input.orderId,
      true,
    );
    if (
      input.nextCursor.id !== order.id ||
      input.nextCursor.orderCreatedAt.getTime() !==
        order.orderCreatedAt.getTime()
    ) {
      throw new Error("Shopify evidence cursor does not identify its locked order");
    }
    if (
      order.orderCreatedAt.getTime() < run.requestedFrom.getTime() ||
      order.orderCreatedAt.getTime() >= run.requestedTo.getTime()
    ) {
      throw new Error("Shopify evidence order is outside the Shopify evidence run window");
    }

    if (replay) {
      const [observation] = await tx
        .select({
          lineDisposition: shopifyEvidenceRunObservations.lineDisposition,
          identityDisposition:
            shopifyEvidenceRunObservations.identityDisposition,
          observedContentChecksum:
            shopifyEvidenceRunObservations.observedContentChecksum,
        })
        .from(shopifyEvidenceRunObservations)
        .where(
          and(
            eq(
              shopifyEvidenceRunObservations.organizationId,
              input.scope.organizationId,
            ),
            eq(shopifyEvidenceRunObservations.storeId, input.scope.storeId),
            eq(
              shopifyEvidenceRunObservations.evidenceRunId,
              input.evidenceRunId,
            ),
            eq(shopifyEvidenceRunObservations.orderId, order.id),
          ),
        )
        .limit(1)
        .for("update");
      if (!observation) {
        throw new Error("Shopify evidence observation replay conflicts");
      }

      const suppliedIdentityDisposition =
        input.identity.status === "available"
          ? "available"
          : input.identity.status;
      const identityDispositionMatches =
        suppliedIdentityDisposition === observation.identityDisposition ||
        (suppliedIdentityDisposition === "available" &&
          observation.identityDisposition === "suppressed");
      if (
        observation.lineDisposition !== input.lineDisposition ||
        !identityDispositionMatches
      ) {
        throw new Error("Shopify evidence observation replay conflicts");
      }

      const replayLines = input.lines
        ? input.lines.lines
        : await loadMatcherVisibleLines(tx, input.scope, order.id);
      const replayChecksum = canonicalContentChecksum({
        order,
        lines: replayLines,
        lineDisposition: input.lineDisposition,
        identityDisposition: observation.identityDisposition as
          CommitShopifyEvidenceOrderResult["identityDisposition"],
      });
      if (
        !constantTimeTextEqual(
          observation.observedContentChecksum,
          replayChecksum,
        )
      ) {
        throw new Error("Shopify evidence observation replay conflicts");
      }

      const [liveIdentityLink] = await tx
        .select({
          identityHmacId: shopifyEvidenceRunIdentityObservations.identityHmacId,
          keyVersion: sourceIdentityHmacs.keyVersion,
          digest: sourceIdentityHmacs.digest,
          rotationState: sourceIdentityHmacs.rotationState,
        })
        .from(shopifyEvidenceRunIdentityObservations)
        .innerJoin(
          sourceIdentityHmacs,
          and(
            eq(
              sourceIdentityHmacs.id,
              shopifyEvidenceRunIdentityObservations.identityHmacId,
            ),
            eq(sourceIdentityHmacs.organizationId, input.scope.organizationId),
            eq(sourceIdentityHmacs.storeId, input.scope.storeId),
            eq(sourceIdentityHmacs.shopifyOrderId, order.id),
          ),
        )
        .where(
          and(
            eq(
              shopifyEvidenceRunIdentityObservations.organizationId,
              input.scope.organizationId,
            ),
            eq(
              shopifyEvidenceRunIdentityObservations.storeId,
              input.scope.storeId,
            ),
            eq(
              shopifyEvidenceRunIdentityObservations.evidenceRunId,
              input.evidenceRunId,
            ),
            eq(shopifyEvidenceRunIdentityObservations.orderId, order.id),
          ),
        )
        .limit(1)
        .for("update");

      if (input.identity.status === "available") {
        await validateExistingIdentityCryptoPolicyWithExecutor(
          input.scope,
          input.identity.keyChecks,
          tx,
        );
      }
      if (liveIdentityLink) {
        const suppliedDigest =
          input.identity.status === "available" ? input.identity.digests[0] : null;
        if (
          observation.identityDisposition !== "available" ||
          !suppliedDigest ||
          suppliedDigest.keyVersion !== liveIdentityLink.keyVersion ||
          suppliedDigest.rotationState !== liveIdentityLink.rotationState ||
          !constantTimeTextEqual(suppliedDigest.digest, liveIdentityLink.digest)
        ) {
          throw new Error("Shopify evidence identity observation replay conflicts");
        }
      }

      const heartbeat = await tx
        .update(shopifyEvidenceSyncRuns)
        .set({ heartbeatAt: now })
        .where(
          and(
            eq(shopifyEvidenceSyncRuns.id, run.id),
            eq(shopifyEvidenceSyncRuns.organizationId, input.scope.organizationId),
            eq(shopifyEvidenceSyncRuns.storeId, input.scope.storeId),
            eq(shopifyEvidenceSyncRuns.status, "running"),
            eq(shopifyEvidenceSyncRuns.cursor, nextEncoded),
          ),
        )
        .returning({ id: shopifyEvidenceSyncRuns.id });
      if (heartbeat.length !== 1) {
        throw new Error("Shopify evidence replay heartbeat failed");
      }
      return {
        committedCursor: input.nextCursor,
        observedContentChecksum: observation.observedContentChecksum,
        lineDisposition: observation.lineDisposition as
          CommitShopifyEvidenceOrderResult["lineDisposition"],
        identityDisposition: observation.identityDisposition as
          CommitShopifyEvidenceOrderResult["identityDisposition"],
        identityHmacId: liveIdentityLink?.identityHmacId ?? null,
      };
    }

    if (input.identity.status === "available") {
      await ensureIdentityCryptoPolicyWithExecutor(
        input.scope,
        input.identity.keyChecks,
        tx,
      );
    }
    if (input.lines) {
      await replaceCompleteLineSetWithExecutor(
        tx,
        input.scope,
        order.id,
        input.lines,
      );
    }

    let identityDisposition: CommitShopifyEvidenceOrderResult["identityDisposition"];
    let identityHmacId: string | null = null;
    if (input.identity.status === "available") {
      const persisted = await persistAvailableIdentityWithExecutor(
        tx,
        input.scope,
        order.id,
        input.identity,
      );
      identityDisposition = persisted.disposition;
      identityHmacId = persisted.identityHmacId;
    } else if (input.identity.status === "unavailable") {
      identityDisposition = "unavailable";
    } else {
      identityDisposition = "not_refreshed";
    }

    const [projection] = await tx
      .select({
        id: shopifyOrders.id,
        shopifyOrderId: shopifyOrders.shopifyOrderId,
        orderCreatedAt: shopifyOrders.orderCreatedAt,
      })
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, input.scope.organizationId),
          eq(shopifyOrders.storeId, input.scope.storeId),
          eq(shopifyOrders.id, order.id),
        ),
      )
      .limit(1);
    if (!projection) throw new Error("Shopify evidence order projection vanished");
    const lines = await loadMatcherVisibleLines(tx, input.scope, order.id);
    const observedContentChecksum = canonicalContentChecksum({
      order: projection,
      lines,
      lineDisposition: input.lineDisposition,
      identityDisposition,
    });

    const [existingObservation] = await tx
      .select({
        id: shopifyEvidenceRunObservations.id,
        lineDisposition: shopifyEvidenceRunObservations.lineDisposition,
        identityDisposition: shopifyEvidenceRunObservations.identityDisposition,
        observedContentChecksum:
          shopifyEvidenceRunObservations.observedContentChecksum,
      })
      .from(shopifyEvidenceRunObservations)
      .where(
        and(
          eq(
            shopifyEvidenceRunObservations.organizationId,
            input.scope.organizationId,
          ),
          eq(shopifyEvidenceRunObservations.storeId, input.scope.storeId),
          eq(
            shopifyEvidenceRunObservations.evidenceRunId,
            input.evidenceRunId,
          ),
          eq(shopifyEvidenceRunObservations.orderId, order.id),
        ),
      )
      .limit(1)
      .for("update");
    if (existingObservation) {
      if (
        existingObservation.lineDisposition !== input.lineDisposition ||
        existingObservation.identityDisposition !== identityDisposition ||
        !constantTimeTextEqual(
          existingObservation.observedContentChecksum,
          observedContentChecksum,
        )
      ) {
        throw new Error("Shopify evidence observation replay conflicts");
      }
    } else {
      await tx.insert(shopifyEvidenceRunObservations).values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        evidenceRunId: input.evidenceRunId,
        orderId: order.id,
        lineDisposition: input.lineDisposition,
        identityDisposition,
        observedContentChecksum,
        observedAt: now,
      });
    }

    const [existingIdentityObservation] = await tx
      .select({ id: shopifyEvidenceRunIdentityObservations.id, identityHmacId: shopifyEvidenceRunIdentityObservations.identityHmacId })
      .from(shopifyEvidenceRunIdentityObservations)
      .where(
        and(
          eq(shopifyEvidenceRunIdentityObservations.organizationId, input.scope.organizationId),
          eq(shopifyEvidenceRunIdentityObservations.storeId, input.scope.storeId),
          eq(shopifyEvidenceRunIdentityObservations.evidenceRunId, input.evidenceRunId),
          eq(shopifyEvidenceRunIdentityObservations.orderId, order.id),
        ),
      )
      .limit(1)
      .for("update");
    if (identityHmacId) {
      if (existingIdentityObservation) {
        if (existingIdentityObservation.identityHmacId !== identityHmacId) {
          throw new Error("Shopify evidence identity observation replay conflicts");
        }
      } else {
        await tx.insert(shopifyEvidenceRunIdentityObservations).values({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          evidenceRunId: input.evidenceRunId,
          orderId: order.id,
          identityHmacId,
          observedAt: now,
        });
      }
    } else if (existingIdentityObservation) {
      throw new Error("Shopify evidence identity observation replay conflicts");
    }

    if (!replay) {
      const updated = await tx
        .update(shopifyEvidenceSyncRuns)
        .set({
          cursor: nextEncoded,
          heartbeatAt: now,
          ...input.progress.counts,
          identityCapability: input.progress.identityCapability,
          lineCompleteness: input.progress.lineCompleteness,
        })
        .where(
          and(
            eq(shopifyEvidenceSyncRuns.id, run.id),
            eq(shopifyEvidenceSyncRuns.organizationId, input.scope.organizationId),
            eq(shopifyEvidenceSyncRuns.storeId, input.scope.storeId),
            eq(shopifyEvidenceSyncRuns.status, "running"),
            expectedEncoded === null
              ? isNull(shopifyEvidenceSyncRuns.cursor)
              : eq(shopifyEvidenceSyncRuns.cursor, expectedEncoded),
          ),
        )
        .returning({ id: shopifyEvidenceSyncRuns.id });
      if (updated.length !== 1) {
        throw new Error("Shopify evidence checkpoint failed");
      }
    }

    return {
      committedCursor: input.nextCursor,
      observedContentChecksum,
      lineDisposition: input.lineDisposition,
      identityDisposition,
      identityHmacId,
    };
  });
}

type PersistedEvidenceRun = typeof shopifyEvidenceSyncRuns.$inferSelect;

function decodePersistedEvidenceRun(run: PersistedEvidenceRun) {
  if (
    run.id.length === 0 ||
    run.startTriggerRunId.length === 0 ||
    run.organizationId.length === 0 ||
    run.storeId.length === 0 ||
    run.firstBatchTriggerRunId === ""
  ) {
    throw new Error("Shopify evidence persisted trigger ID is invalid");
  }
  if (run.mode !== "initial_90d" && run.mode !== "incremental_7d") {
    throw new Error("Shopify evidence persisted mode is invalid");
  }
  const mode: ShopifyEvidenceMode = run.mode;
  assertValidIanaTimezone(run.storeTimezone);
  assertValidStoreDay(run.anchorStoreDay);
  assertValidWindow({ from: run.requestedFrom, to: run.requestedTo });
  const expectedWindow = deriveShopifyEvidenceWindow({
    mode,
    anchorStoreDay: run.anchorStoreDay,
    timeZone: run.storeTimezone,
  });
  if (
    expectedWindow.from.getTime() !== run.requestedFrom.getTime() ||
    expectedWindow.to.getTime() !== run.requestedTo.getTime()
  ) {
    throw new Error("Shopify evidence persisted window is invalid");
  }
  if (
    run.status !== "running" &&
    run.status !== "success" &&
    run.status !== "partial" &&
    run.status !== "failed"
  ) {
    throw new Error("Shopify evidence persisted status is invalid");
  }
  if (
    run.identityCapability !== "unknown" &&
    run.identityCapability !== "available" &&
    run.identityCapability !== "unavailable"
  ) {
    throw new Error("Shopify evidence persisted identity state is invalid");
  }
  if (
    run.lineCompleteness !== "unknown" &&
    run.lineCompleteness !== "complete" &&
    run.lineCompleteness !== "partial" &&
    run.lineCompleteness !== "unavailable"
  ) {
    throw new Error("Shopify evidence persisted line state is invalid");
  }
  if (run.error !== null && !SAFE_PERSISTED_ERRORS.has(run.error)) {
    throw new Error("Shopify evidence persisted error code is invalid");
  }
  assertValidDate(run.startedAt, "Shopify evidence persisted start time");
  assertValidDate(run.heartbeatAt, "Shopify evidence persisted heartbeat");
  if (run.finishedAt) {
    assertValidDate(run.finishedAt, "Shopify evidence persisted finish time");
  }
  if (
    (run.status === "running" &&
      (run.finishedAt !== null || run.error !== null)) ||
    (run.status !== "running" && run.finishedAt === null)
  ) {
    throw new Error("Shopify evidence persisted lifecycle is invalid");
  }
  const counts = currentCounts(run);
  assertNondecreasingEvidenceCounts(
    {
      ordersRead: 0,
      ordersEnriched: 0,
      ordersPartial: 0,
      ordersUnavailable: 0,
      warnings: 0,
      failures: 0,
    },
    counts,
  );
  const cursor = run.cursor ? decodeEvidenceOrderCursor(run.cursor) : null;
  if (
    cursor &&
    (cursor.orderCreatedAt.getTime() < run.requestedFrom.getTime() ||
      cursor.orderCreatedAt.getTime() >= run.requestedTo.getTime())
  ) {
    throw new Error("Shopify evidence persisted cursor is outside its window");
  }
  return {
    ...run,
    mode,
    scope: {
      organizationId: run.organizationId,
      storeId: run.storeId,
    },
    window: { from: run.requestedFrom, to: run.requestedTo },
    cursor,
    counts,
  };
}

export async function loadShopifyEvidenceRun(runId: string) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Shopify evidence run ID is invalid");
  }
  const [run] = await db
    .select()
    .from(shopifyEvidenceSyncRuns)
    .where(eq(shopifyEvidenceSyncRuns.id, runId))
    .limit(1);
  return run ? decodePersistedEvidenceRun(run) : null;
}

export async function loadEvidenceRunByStartTriggerId(
  startTriggerRunId: string,
) {
  if (typeof startTriggerRunId !== "string" || startTriggerRunId.length === 0) {
    throw new Error("Shopify evidence start trigger ID is invalid");
  }
  const [run] = await db
    .select()
    .from(shopifyEvidenceSyncRuns)
    .where(eq(shopifyEvidenceSyncRuns.startTriggerRunId, startTriggerRunId))
    .limit(1);
  return run ? decodePersistedEvidenceRun(run) : null;
}

function assertSameEvidenceStart(
  existing: PersistedEvidenceRun,
  params: {
    scope: IdentityScope;
    mode: ShopifyEvidenceMode;
    storeTimezone: string;
    anchorStoreDay: string;
    window: HalfOpenWindow;
  },
): void {
  if (
    existing.organizationId !== params.scope.organizationId ||
    existing.storeId !== params.scope.storeId ||
    existing.mode !== params.mode ||
    existing.storeTimezone !== params.storeTimezone ||
    existing.anchorStoreDay !== params.anchorStoreDay ||
    existing.requestedFrom.getTime() !== params.window.from.getTime() ||
    existing.requestedTo.getTime() !== params.window.to.getTime()
  ) {
    throw new Error("Shopify evidence start idempotency conflict");
  }
}

function assertStartDisposition(
  disposition: ShopifyEvidenceStartDisposition,
): void {
  if (
    disposition.kind !== "running" &&
    disposition.kind !== "terminal_unavailable"
  ) {
    throw new Error("Shopify evidence start disposition is invalid");
  }
  if (
    disposition.identityCapability !== "unknown" &&
    disposition.identityCapability !== "unavailable"
  ) {
    throw new Error("Shopify evidence start disposition is invalid");
  }
  if (disposition.kind === "terminal_unavailable") {
    assertNondecreasingEvidenceCounts(
      {
        ordersRead: 0,
        ordersEnriched: 0,
        ordersPartial: 0,
        ordersUnavailable: 0,
        warnings: 0,
        failures: 0,
      },
      disposition.counts,
    );
  }
}

export async function reconcileShopifyEvidenceStoreForStart(
  scope: IdentityScope,
  now: Date,
): Promise<{ expiredRunId: string | null }> {
  assertValidDate(now, "Shopify evidence lease reconciliation time");
  return db.transaction(async (tx) => {
    await lockEvidenceStore(tx, scope);
    const [active] = await tx
      .select({ id: shopifyEvidenceSyncRuns.id })
      .from(shopifyEvidenceSyncRuns)
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
          eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
          eq(shopifyEvidenceSyncRuns.status, "running"),
        ),
      )
      .limit(1);
    if (!active) return { expiredRunId: null };
    const recovery = await failExpiredShopifyEvidenceRun(
      scope,
      active.id,
      now,
      tx,
    );
    if (!recovery.changed) {
      throw new Error("A live Shopify evidence run already owns this store");
    }
    return { expiredRunId: active.id };
  });
}

export async function startShopifyEvidenceRun(params: {
  startTriggerRunId: string;
  scope: IdentityScope;
  mode: ShopifyEvidenceMode;
  storeTimezone: string;
  anchorStoreDay: string;
  window: HalfOpenWindow;
  disposition: ShopifyEvidenceStartDisposition;
  now: Date;
}): Promise<{
  id: string;
  status: "running" | "success" | "partial" | "failed";
  firstBatchTriggerRunId: string | null;
  replayed: boolean;
}> {
  if (params.mode !== "initial_90d" && params.mode !== "incremental_7d") {
    throw new Error("Unsupported Shopify evidence mode");
  }
  if (
    typeof params.startTriggerRunId !== "string" ||
    params.startTriggerRunId.length === 0
  ) {
    throw new Error("Shopify evidence start trigger ID is invalid");
  }
  assertValidDate(params.now, "Shopify evidence start time");
  assertStartDisposition(params.disposition);
  assertValidStoreDay(params.anchorStoreDay);
  assertValidIanaTimezone(params.storeTimezone);
  assertValidWindow(params.window);
  const expectedWindow = deriveShopifyEvidenceWindow({
    mode: params.mode,
    anchorStoreDay: params.anchorStoreDay,
    timeZone: params.storeTimezone,
  });
  if (
    params.window.from.getTime() !== expectedWindow.from.getTime() ||
    params.window.to.getTime() !== expectedWindow.to.getTime()
  ) {
    throw new Error("Shopify evidence window does not match its store-day anchor");
  }
  const terminal = params.disposition.kind === "terminal_unavailable";

  return db.transaction(async (tx) => {
    await lockEvidenceStore(tx, params.scope);
    const [existing] = await tx
      .select()
      .from(shopifyEvidenceSyncRuns)
      .where(
        eq(shopifyEvidenceSyncRuns.startTriggerRunId, params.startTriggerRunId),
      )
      .limit(1);
    if (existing) {
      assertSameEvidenceStart(existing, params);
      return {
        id: existing.id,
        status: existing.status,
        firstBatchTriggerRunId: existing.firstBatchTriggerRunId,
        replayed: true,
      };
    }

    const [active] = await tx
      .select({ id: shopifyEvidenceSyncRuns.id })
      .from(shopifyEvidenceSyncRuns)
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.organizationId, params.scope.organizationId),
          eq(shopifyEvidenceSyncRuns.storeId, params.scope.storeId),
          eq(shopifyEvidenceSyncRuns.status, "running"),
        ),
      )
      .limit(1);
    if (active) {
      const recovery = await failExpiredShopifyEvidenceRun(
        params.scope,
        active.id,
        params.now,
        tx,
      );
      if (!recovery.changed) {
        throw new Error("A live Shopify evidence run already owns this store");
      }
    }

    const counts =
      params.disposition.kind === "terminal_unavailable"
        ? params.disposition.counts
        : null;
    const [inserted] = await tx
      .insert(shopifyEvidenceSyncRuns)
      .values({
        startTriggerRunId: params.startTriggerRunId,
        organizationId: params.scope.organizationId,
        storeId: params.scope.storeId,
        mode: params.mode,
        storeTimezone: params.storeTimezone,
        anchorStoreDay: params.anchorStoreDay,
        requestedFrom: params.window.from,
        requestedTo: params.window.to,
        identityCapability: params.disposition.identityCapability,
        status: terminal ? "partial" : "running",
        lineCompleteness: terminal ? "unavailable" : "unknown",
        ...(counts ?? {}),
        warnings: terminal ? Math.max(1, counts?.warnings ?? 0) : 0,
        error: terminal ? "required_order_scope_unavailable" : null,
        heartbeatAt: params.now,
        startedAt: params.now,
        finishedAt: terminal ? params.now : null,
      })
      .returning({
        id: shopifyEvidenceSyncRuns.id,
        status: shopifyEvidenceSyncRuns.status,
        firstBatchTriggerRunId: shopifyEvidenceSyncRuns.firstBatchTriggerRunId,
      });
    if (!inserted) throw new Error("Shopify evidence run insert failed");
    return { ...inserted, replayed: false };
  });
}

export async function recordFirstBatchTriggerRunId(params: {
  scope: IdentityScope;
  runId: string;
  triggerRunId: string;
}): Promise<void> {
  if (!params.triggerRunId) {
    throw new Error("Shopify evidence first-batch trigger ID is invalid");
  }
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: shopifyEvidenceSyncRuns.id,
        status: shopifyEvidenceSyncRuns.status,
        firstBatchTriggerRunId:
          shopifyEvidenceSyncRuns.firstBatchTriggerRunId,
      })
      .from(shopifyEvidenceSyncRuns)
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.id, params.runId),
          eq(
            shopifyEvidenceSyncRuns.organizationId,
            params.scope.organizationId,
          ),
          eq(shopifyEvidenceSyncRuns.storeId, params.scope.storeId),
        ),
      )
      .limit(1)
      .for("update");
    if (
      !current ||
      (current.firstBatchTriggerRunId !== null &&
        current.firstBatchTriggerRunId !== params.triggerRunId)
    ) {
      throw new Error("Shopify evidence first-batch handoff conflicts");
    }
    const rows = await tx
      .update(shopifyEvidenceSyncRuns)
      .set({
        firstBatchTriggerRunId: params.triggerRunId,
        ...(current.status === "running" ? { heartbeatAt: new Date() } : {}),
      })
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.id, current.id),
          eq(
            shopifyEvidenceSyncRuns.organizationId,
            params.scope.organizationId,
          ),
          eq(shopifyEvidenceSyncRuns.storeId, params.scope.storeId),
          current.firstBatchTriggerRunId === null
            ? isNull(shopifyEvidenceSyncRuns.firstBatchTriggerRunId)
            : eq(
                shopifyEvidenceSyncRuns.firstBatchTriggerRunId,
                params.triggerRunId,
              ),
        ),
      )
      .returning({ id: shopifyEvidenceSyncRuns.id });
    if (rows.length !== 1) {
      throw new Error("Shopify evidence first-batch handoff conflicts");
    }
  });
}

async function renewHeartbeatWithExecutor(
  scope: IdentityScope,
  runId: string,
  now: Date,
  executor: EvidenceExecutor,
): Promise<void> {
  const run = await loadLockedRunningRun(executor, scope, runId);
  const updated = await executor
    .update(shopifyEvidenceSyncRuns)
    .set({ heartbeatAt: now })
    .where(
      and(
        eq(shopifyEvidenceSyncRuns.id, run.id),
        eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
        eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
        eq(shopifyEvidenceSyncRuns.status, "running"),
      ),
    )
    .returning({ id: shopifyEvidenceSyncRuns.id });
  if (updated.length !== 1) throw new Error("Shopify evidence heartbeat failed");
}

export async function renewShopifyEvidenceRunHeartbeat(
  scope: IdentityScope,
  runId: string,
  now: Date,
  executor?: EvidenceExecutor,
): Promise<void> {
  assertValidDate(now, "Shopify evidence heartbeat time");
  if (executor) {
    await renewHeartbeatWithExecutor(scope, runId, now, executor);
    return;
  }
  await db.transaction((tx) => renewHeartbeatWithExecutor(scope, runId, now, tx));
}

export async function checkpointShopifyEvidenceRun(
  scope: IdentityScope,
  runId: string,
  expectedCursor: EvidenceOrderCursor | null,
  nextCursor: EvidenceOrderCursor,
  progress: ShopifyEvidenceRunProgress,
): Promise<void> {
  assertForwardEvidenceCursor(expectedCursor, nextCursor);
  await db.transaction(async (tx) => {
    const current = await loadLockedRunningRun(tx, scope, runId);
    const expectedEncoded = expectedCursor
      ? encodeEvidenceOrderCursor(expectedCursor)
      : null;
    if (current.cursor !== expectedEncoded) {
      throw new Error("Shopify evidence cursor compare-and-set failed");
    }
    assertNondecreasingEvidenceCounts(currentCounts(current), progress.counts);
    assertEvidenceStateTransitions(current, progress);
    const updated = await tx
      .update(shopifyEvidenceSyncRuns)
      .set({
        cursor: encodeEvidenceOrderCursor(nextCursor),
        heartbeatAt: new Date(),
        ...progress.counts,
        identityCapability: progress.identityCapability,
        lineCompleteness: progress.lineCompleteness,
      })
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.id, current.id),
          eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
          eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
          eq(shopifyEvidenceSyncRuns.status, "running"),
        ),
      )
      .returning({ id: shopifyEvidenceSyncRuns.id });
    if (updated.length !== 1) throw new Error("Shopify evidence checkpoint failed");
  });
}

export async function finishShopifyEvidenceRun(params: {
  scope: IdentityScope;
  runId: string;
  expectedCursor: EvidenceOrderCursor | null;
  status: "success" | "partial" | "failed";
  progress: ShopifyEvidenceRunProgress;
  error?: string | null;
  now?: Date;
}): Promise<void> {
  if (!(["success", "partial", "failed"] as const).includes(params.status)) {
    throw new Error("Shopify evidence finish status is invalid");
  }
  if (params.error != null && !SAFE_FINISH_ERRORS.has(params.error)) {
    throw new Error("Shopify evidence finish error code is invalid");
  }
  const now = params.now ?? new Date();
  assertValidDate(now, "Shopify evidence finish time");
  await db.transaction(async (tx) => {
    const current = await loadLockedRunningRun(tx, params.scope, params.runId);
    const expectedEncoded = params.expectedCursor
      ? encodeEvidenceOrderCursor(params.expectedCursor)
      : null;
    if (current.cursor !== expectedEncoded) {
      throw new Error("Shopify evidence cursor compare-and-set failed");
    }
    assertExactEvidenceProgress(
      current,
      params.progress,
      "Shopify evidence finish progress conflicts",
    );
    const updated = await tx
      .update(shopifyEvidenceSyncRuns)
      .set({
        status: params.status,
        ...params.progress.counts,
        identityCapability: params.progress.identityCapability,
        lineCompleteness: params.progress.lineCompleteness,
        error: params.error ?? null,
        heartbeatAt: now,
        finishedAt: now,
      })
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.id, current.id),
          eq(shopifyEvidenceSyncRuns.organizationId, params.scope.organizationId),
          eq(shopifyEvidenceSyncRuns.storeId, params.scope.storeId),
          eq(shopifyEvidenceSyncRuns.status, "running"),
        ),
      )
      .returning({ id: shopifyEvidenceSyncRuns.id });
    if (updated.length !== 1) throw new Error("Shopify evidence finish failed");
  });
}

export async function failShopifyEvidenceRunAfterRetryExhaustion(
  scope: IdentityScope,
  runId: string,
  stage: "start" | "batch",
): Promise<{ changed: boolean }> {
  if (stage !== "start" && stage !== "batch") {
    throw new Error("Shopify evidence retry stage is invalid");
  }
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: shopifyEvidenceSyncRuns.id,
        status: shopifyEvidenceSyncRuns.status,
        failures: shopifyEvidenceSyncRuns.failures,
      })
      .from(shopifyEvidenceSyncRuns)
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.id, runId),
          eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
          eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) throw new Error("Shopify evidence run is outside this scope");
    if (current.status !== "running") return { changed: false };
    const updated = await tx
      .update(shopifyEvidenceSyncRuns)
      .set({
        status: "failed",
        failures: current.failures + 1,
        error:
          stage === "start"
            ? "start_retries_exhausted"
            : "batch_retries_exhausted",
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(shopifyEvidenceSyncRuns.id, current.id),
          eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
          eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
          eq(shopifyEvidenceSyncRuns.status, "running"),
        ),
      )
      .returning({ id: shopifyEvidenceSyncRuns.id });
    if (updated.length !== 1) {
      throw new Error("Shopify evidence retry-exhaustion finalization raced");
    }
    return { changed: true };
  });
}

async function failExpiredWithExecutor(
  scope: IdentityScope,
  runId: string,
  now: Date,
  executor: EvidenceExecutor,
): Promise<{ changed: boolean }> {
  const [current] = await executor
    .select({
      id: shopifyEvidenceSyncRuns.id,
      status: shopifyEvidenceSyncRuns.status,
      heartbeatAt: shopifyEvidenceSyncRuns.heartbeatAt,
      failures: shopifyEvidenceSyncRuns.failures,
    })
    .from(shopifyEvidenceSyncRuns)
    .where(
      and(
        eq(shopifyEvidenceSyncRuns.id, runId),
        eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
        eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
      ),
    )
    .limit(1)
    .for("update");
  if (!current) throw new Error("Shopify evidence run is outside this scope");
  if (current.status !== "running") return { changed: false };
  if (
    current.heartbeatAt.getTime() >
    now.getTime() - SHOPIFY_EVIDENCE_STALE_AFTER_MS
  ) {
    return { changed: false };
  }
  const updated = await executor
    .update(shopifyEvidenceSyncRuns)
    .set({
      status: "failed",
      failures: current.failures + 1,
      error: "lease_expired",
      finishedAt: now,
    })
    .where(
      and(
        eq(shopifyEvidenceSyncRuns.id, current.id),
        eq(shopifyEvidenceSyncRuns.organizationId, scope.organizationId),
        eq(shopifyEvidenceSyncRuns.storeId, scope.storeId),
        eq(shopifyEvidenceSyncRuns.status, "running"),
      ),
    )
    .returning({ id: shopifyEvidenceSyncRuns.id });
  if (updated.length !== 1) {
    throw new Error("Shopify evidence stale-run finalization raced");
  }
  return { changed: true };
}

export async function failExpiredShopifyEvidenceRun(
  scope: IdentityScope,
  runId: string,
  now: Date,
  executor?: EvidenceExecutor,
): Promise<{ changed: boolean }> {
  assertValidDate(now, "Shopify evidence stale-run time");
  if (executor) return failExpiredWithExecutor(scope, runId, now, executor);
  return db.transaction((tx) => failExpiredWithExecutor(scope, runId, now, tx));
}
