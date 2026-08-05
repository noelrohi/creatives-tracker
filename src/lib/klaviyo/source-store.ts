import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { timingSafeEqual } from "node:crypto";
import {
  computeIdentityCryptoKeyChecks,
  parseIdentityHmacKeyring,
  type ErasureSuppressionKey,
  type IdentityHmacKeyring,
} from "@/lib/identity-hmac";
import { eraseSuppressedKlaviyoEventEvidence } from "@/lib/klaviyo/privacy-match-closure";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialProvider,
} from "@/lib/klaviyo/credential-provider";
import {
  KLAVIYO_EVENT_ALIAS_FIELDS,
  KLAVIYO_ORDER_CORE_KINDS,
  assertExactOrderCoreRequestParameters,
  assertHalfOpenWindow,
  assertOrderCoreSourceContract,
} from "@/lib/klaviyo/types";
import { deriveDayInTimezone } from "@/lib/shopify-ingest";
import {
  klaviyoConnections,
  klaviyoEventAliases,
  klaviyoEventProducts,
  klaviyoEventRunObservations,
  klaviyoEvents,
  klaviyoJoinRules,
  klaviyoMetrics,
  klaviyoProbeReports,
  klaviyoSyncRuns,
} from "@/schema/klaviyo";
import { shopifyOrders, shopifyStores } from "@/schema/shopify";
import { identityMatchingKeyBindings } from "@/schema/identity-registry";
import { klaviyoEventRunIdentityObservations } from "@/schema/klaviyo-match";
import {
  identityCryptoPolicies,
  identityErasureSuppressions,
  shopifyOrderLines,
  sourceIdentityHmacs,
} from "@/schema/shopify-evidence";
import type {
  EnabledOrderCoreMetric,
  HalfOpenWindow,
  JsonValue,
  KlaviyoConnectionScope,
  KlaviyoEventAliasField,
  KlaviyoEventAliasRegistry,
  KlaviyoEventCheckpoint,
  KlaviyoMetricKind,
  NormalizedKlaviyoEvent,
  OrderCoreSourceContract,
  PropertyFingerprintEntry,
  RedactedProbeExample,
} from "@/lib/klaviyo/types";

type TransactionWork = Parameters<typeof db.transaction>[0];
export type KlaviyoStoreTransaction = Parameters<TransactionWork>[0];
type TransactionExecutor = typeof db | KlaviyoStoreTransaction;

const SAFE_SYNC_ERROR = {
  code: "KLAVIYO_SYNC_FAILED",
  message:
    "Klaviyo sync failed; inspect the provider status and configured scopes",
} as const;

const SAFE_RETRY_ERROR = {
  code: "KLAVIYO_RETRIES_EXHAUSTED",
  message: "Klaviyo task retries were exhausted",
} as const;

const SAFE_LEASE_ERROR = {
  code: "KLAVIYO_LEASE_EXPIRED",
  message: "Klaviyo task lease expired before completion",
} as const;

export const KLAVIYO_RUN_STALE_AFTER_MS = 20 * 60 * 1000;

export function sameCheckpoint(
  left: KlaviyoEventCheckpoint | null,
  right: KlaviyoEventCheckpoint | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.sourceMode === right.sourceMode &&
    left.metricKinds.length === 2 &&
    right.metricKinds.length === 2 &&
    left.metricKinds[0] === right.metricKinds[0] &&
    left.metricKinds[1] === right.metricKinds[1] &&
    left.metricIndex === right.metricIndex &&
    left.cursor === right.cursor &&
    left.page === right.page
  );
}

export function safeSyncError(_error: unknown) {
  void _error;
  return { ...SAFE_SYNC_ERROR };
}

export type ConnectionRecord = KlaviyoConnectionScope & {
  shopDomain: string;
  storeTimezone: string;
  klaviyoAccountId: string | null;
  initialSourceFrom: Date | null;
  initialSourceTo: Date | null;
  credentialReference: "reviv_environment";
  status: "pending" | "ready" | "degraded" | "disabled";
};

const connectionProjection = {
  organizationId: klaviyoConnections.organizationId,
  storeId: klaviyoConnections.storeId,
  connectionId: klaviyoConnections.id,
  shopDomain: shopifyStores.shopDomain,
  storeTimezone: shopifyStores.ianaTimezone,
  klaviyoAccountId: klaviyoConnections.klaviyoAccountId,
  initialSourceFrom: klaviyoConnections.initialSourceFrom,
  initialSourceTo: klaviyoConnections.initialSourceTo,
  credentialReference: klaviyoConnections.credentialReference,
  status: klaviyoConnections.status,
};

function scopePredicate(scope: KlaviyoConnectionScope) {
  return and(
    eq(klaviyoConnections.organizationId, scope.organizationId),
    eq(klaviyoConnections.storeId, scope.storeId),
    eq(klaviyoConnections.id, scope.connectionId),
  );
}

async function runInTransaction<T>(
  executor: TransactionExecutor,
  work: (tx: KlaviyoStoreTransaction) => Promise<T>,
): Promise<T> {
  return executor.transaction(work);
}

async function lockConnection(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
): Promise<void> {
  const [connection] = await tx
    .select({ id: klaviyoConnections.id })
    .from(klaviyoConnections)
    .where(scopePredicate(scope))
    .for("update");
  if (!connection) throw new Error("Klaviyo connection is outside this scope");
}

/**
 * Shared serialization seam for source commits and Plan 3 publication.
 * Callers must finish all provider requests before entering this transaction.
 */
export async function withKlaviyoConnectionLock<T>(
  scope: KlaviyoConnectionScope,
  work: (tx: KlaviyoStoreTransaction) => Promise<T>,
  executor: TransactionExecutor = db,
): Promise<T> {
  return runInTransaction(executor, async (tx) => {
    await lockConnection(tx, scope);
    return work(tx);
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const SAFE_GATE_ERROR = {
  code: "KLAVIYO_IDENTITY_GATE_BOOTSTRAP_FAILED",
  message:
    "Klaviyo identity write gate bootstrap failed; resolve key configuration manually",
} as const;

function gateBootstrapFailure(): never {
  throw new Error(SAFE_GATE_ERROR.message);
}

/**
 * Store→connection lock order shared by identity-bearing writers. Required
 * because a suppression hit may close Shopify-order incident results; the
 * store lock must never be acquired after the connection lock.
 */
export async function withKlaviyoStoreConnectionLock<T>(
  scope: KlaviyoConnectionScope,
  work: (tx: KlaviyoStoreTransaction) => Promise<T>,
  executor: TransactionExecutor = db,
): Promise<T> {
  return runInTransaction(executor, async (tx) => {
    const [store] = await tx
      .select({ id: shopifyStores.id })
      .from(shopifyStores)
      .where(
        and(
          eq(shopifyStores.organizationId, scope.organizationId),
          eq(shopifyStores.id, scope.storeId),
        ),
      )
      .for("update");
    if (!store) throw new Error("Klaviyo store is outside this scope");
    await lockConnection(tx, scope);
    return work(tx);
  });
}

/**
 * Explicit durable identity-write-gate bootstrap. Never called implicitly
 * by ordinary writers or rotation preparation; the Plan 3 setup/manual gate
 * invokes it once before the first identity backfill or match.
 */
export async function initializeIdentityWriteGate(input: {
  scope: KlaviyoConnectionScope;
  keyring: IdentityHmacKeyring;
  suppressionKey: ErasureSuppressionKey;
}): Promise<{ initialized: boolean }> {
  const identityScope = {
    organizationId: input.scope.organizationId,
    storeId: input.scope.storeId,
  };
  const checks = computeIdentityCryptoKeyChecks({
    scope: identityScope,
    keyring: input.keyring,
    suppressionKey: input.suppressionKey,
  });
  const environmentCurrent = checks.matching[0];

  return withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
    const [connection] = await tx
      .select({
        mode: klaviyoConnections.identityWriteMode,
        currentVersion: klaviyoConnections.identityCurrentKeyVersion,
        currentCheck: klaviyoConnections.identityCurrentKeyCheck,
        previousVersion: klaviyoConnections.identityPreviousKeyVersion,
      })
      .from(klaviyoConnections)
      .where(scopePredicate(input.scope));
    if (!connection) throw new Error("Klaviyo connection is outside this scope");

    const [policy] = await tx
      .select({
        matchingCurrentVersion: identityCryptoPolicies.matchingCurrentVersion,
        matchingCurrentKeyCheck: identityCryptoPolicies.matchingCurrentKeyCheck,
        matchingPreviousVersion: identityCryptoPolicies.matchingPreviousVersion,
        suppressionVersion: identityCryptoPolicies.suppressionVersion,
        suppressionKeyCheck: identityCryptoPolicies.suppressionKeyCheck,
      })
      .from(identityCryptoPolicies)
      .where(
        and(
          eq(identityCryptoPolicies.organizationId, identityScope.organizationId),
          eq(identityCryptoPolicies.storeId, identityScope.storeId),
        ),
      )
      .for("update");

    if (connection.currentVersion !== null) {
      // Replay of an identical bootstrap is a no-op; anything else fails.
      const identical =
        connection.mode === "current_only" &&
        connection.previousVersion === null &&
        connection.currentVersion === environmentCurrent.keyVersion &&
        constantTimeEqual(
          connection.currentCheck ?? "",
          environmentCurrent.keyCheck,
        ) &&
        policy !== undefined &&
        policy.matchingCurrentVersion === environmentCurrent.keyVersion &&
        constantTimeEqual(
          policy.matchingCurrentKeyCheck,
          environmentCurrent.keyCheck,
        );
      if (identical) return { initialized: false };
      gateBootstrapFailure();
    }

    const retainedVersions = await tx
      .selectDistinct({ keyVersion: sourceIdentityHmacs.keyVersion })
      .from(sourceIdentityHmacs)
      .where(
        and(
          eq(sourceIdentityHmacs.organizationId, identityScope.organizationId),
          eq(sourceIdentityHmacs.storeId, identityScope.storeId),
        ),
      );
    const retained = retainedVersions.map((row) => row.keyVersion);

    if (policy) {
      // Constant-time validate every environment pair against the policy.
      if (
        policy.matchingPreviousVersion !== null ||
        policy.matchingCurrentVersion !== environmentCurrent.keyVersion ||
        !constantTimeEqual(
          policy.matchingCurrentKeyCheck,
          environmentCurrent.keyCheck,
        ) ||
        policy.suppressionVersion !== checks.suppression.keyVersion ||
        !constantTimeEqual(
          policy.suppressionKeyCheck,
          checks.suppression.keyCheck,
        )
      ) {
        gateBootstrapFailure();
      }
      if (
        retained.length > 1 ||
        (retained.length === 1 && retained[0] !== policy.matchingCurrentVersion)
      ) {
        gateBootstrapFailure();
      }
    } else {
      // Without a policy, retained identity rows cannot prove key
      // possession; fail for explicit remediation.
      if (retained.length > 0) gateBootstrapFailure();
      const [existingBinding] = await tx
        .select({ keyCheck: identityMatchingKeyBindings.keyCheck })
        .from(identityMatchingKeyBindings)
        .where(
          and(
            eq(
              identityMatchingKeyBindings.organizationId,
              identityScope.organizationId,
            ),
            eq(identityMatchingKeyBindings.storeId, identityScope.storeId),
            eq(
              identityMatchingKeyBindings.keyVersion,
              environmentCurrent.keyVersion,
            ),
          ),
        );
      if (
        existingBinding &&
        !constantTimeEqual(existingBinding.keyCheck, environmentCurrent.keyCheck)
      ) {
        gateBootstrapFailure();
      }
      if (!existingBinding) {
        await tx.insert(identityMatchingKeyBindings).values({
          organizationId: identityScope.organizationId,
          storeId: identityScope.storeId,
          keyVersion: environmentCurrent.keyVersion,
          keyCheck: environmentCurrent.keyCheck,
        });
      }
      await tx.insert(identityCryptoPolicies).values({
        organizationId: identityScope.organizationId,
        storeId: identityScope.storeId,
        matchingCurrentVersion: environmentCurrent.keyVersion,
        matchingCurrentKeyCheck: environmentCurrent.keyCheck,
        suppressionVersion: checks.suppression.keyVersion,
        suppressionKeyCheck: checks.suppression.keyCheck,
      });
    }

    const updated = await tx
      .update(klaviyoConnections)
      .set({
        identityWriteMode: "current_only",
        identityCurrentKeyVersion: environmentCurrent.keyVersion,
        identityCurrentKeyCheck: environmentCurrent.keyCheck,
        identityPreviousKeyVersion: null,
        identityPreviousKeyCheck: null,
        updatedAt: new Date(),
      })
      .where(scopePredicate(input.scope))
      .returning({ id: klaviyoConnections.id });
    if (updated.length !== 1) gateBootstrapFailure();
    return { initialized: true };
  });
}

export async function ensurePilotConnection(
  organizationId: string,
  dependencies: {
    credentialProvider?: KlaviyoCredentialProvider;
    loadIdentityKeyring?: typeof parseIdentityHmacKeyring;
    database?: typeof db;
  } = {},
): Promise<ConnectionRecord> {
  const loadIdentityKeyring =
    dependencies.loadIdentityKeyring ?? parseIdentityHmacKeyring;
  const credentialProvider =
    dependencies.credentialProvider ?? new EnvironmentKlaviyoCredentialProvider();
  const database = dependencies.database ?? db;

  // Both secrets are validated before the first transaction/database query.
  loadIdentityKeyring();
  const binding = await credentialProvider.getPilotBinding();

  return database.transaction(async (tx) => {
    const [store] = await tx
      .select({
        organizationId: shopifyStores.organizationId,
        storeId: shopifyStores.id,
      })
      .from(shopifyStores)
      .where(
        and(
          eq(shopifyStores.organizationId, organizationId),
          eq(shopifyStores.shopDomain, binding.shopDomain),
        ),
      )
      .for("update");
    if (!store) {
      throw new Error(
        "Configured Reviv Shopify store was not found in this organization",
      );
    }

    await tx
      .insert(klaviyoConnections)
      .values({
        organizationId,
        storeId: store.storeId,
        status: "pending",
        authenticationMode: "environment",
        credentialReference: "reviv_environment",
      })
      .onConflictDoNothing({
        target: [
          klaviyoConnections.organizationId,
          klaviyoConnections.storeId,
        ],
      });

    const [connection] = await tx
      .select(connectionProjection)
      .from(klaviyoConnections)
      .innerJoin(shopifyStores, eq(shopifyStores.id, klaviyoConnections.storeId))
      .where(
        and(
          eq(klaviyoConnections.organizationId, organizationId),
          eq(klaviyoConnections.storeId, store.storeId),
        ),
      )
      .limit(1);
    if (!connection) throw new Error("Klaviyo connection bootstrap conflicted");
    if (
      connection.klaviyoAccountId !== null &&
      connection.klaviyoAccountId !== binding.expectedAccountId
    ) {
      throw new Error("Stored Klaviyo account does not match the Reviv binding");
    }
    return connection as ConnectionRecord;
  });
}

export async function getConnectionRecord(
  scope: KlaviyoConnectionScope,
): Promise<ConnectionRecord | null> {
  const [row] = await db
    .select(connectionProjection)
    .from(klaviyoConnections)
    .innerJoin(shopifyStores, eq(shopifyStores.id, klaviyoConnections.storeId))
    .where(scopePredicate(scope))
    .limit(1);
  return (row as ConnectionRecord | undefined) ?? null;
}

export async function resolveTaskConnection(
  connectionId: string,
): Promise<ConnectionRecord> {
  const [scope] = await db
    .select({
      organizationId: klaviyoConnections.organizationId,
      storeId: klaviyoConnections.storeId,
      connectionId: klaviyoConnections.id,
    })
    .from(klaviyoConnections)
    .where(eq(klaviyoConnections.id, connectionId))
    .limit(1);
  if (!scope) throw new Error("Klaviyo connection not found");
  const record = await getConnectionRecord(scope);
  if (!record) throw new Error("Klaviyo connection scope is invalid");
  return record;
}

export async function resolveTaskSyncRun(syncRunId: string): Promise<{
  scope: KlaviyoConnectionScope;
  operation: string;
}> {
  const [run] = await db
    .select({
      organizationId: klaviyoSyncRuns.organizationId,
      storeId: klaviyoSyncRuns.storeId,
      connectionId: klaviyoSyncRuns.connectionId,
      operation: klaviyoSyncRuns.operation,
    })
    .from(klaviyoSyncRuns)
    .where(eq(klaviyoSyncRuns.id, syncRunId))
    .limit(1);
  if (!run) throw new Error("Klaviyo sync run not found");
  return {
    scope: {
      organizationId: run.organizationId,
      storeId: run.storeId,
      connectionId: run.connectionId,
    },
    operation: run.operation,
  };
}

export async function getPilotConnectionForOrganization(
  organizationId: string,
  credentialProvider: KlaviyoCredentialProvider =
    new EnvironmentKlaviyoCredentialProvider(),
): Promise<ConnectionRecord | null> {
  const binding = await credentialProvider.getPilotBinding();
  const [scope] = await db
    .select({
      organizationId: klaviyoConnections.organizationId,
      storeId: klaviyoConnections.storeId,
      connectionId: klaviyoConnections.id,
    })
    .from(klaviyoConnections)
    .innerJoin(shopifyStores, eq(shopifyStores.id, klaviyoConnections.storeId))
    .where(
      and(
        eq(klaviyoConnections.organizationId, organizationId),
        eq(shopifyStores.shopDomain, binding.shopDomain),
      ),
    )
    .limit(1);
  return scope ? getConnectionRecord(scope) : null;
}

function emptyAliasRegistry(): KlaviyoEventAliasRegistry {
  return Object.fromEntries(
    KLAVIYO_EVENT_ALIAS_FIELDS.map((field) => [field, null]),
  ) as KlaviyoEventAliasRegistry;
}

export async function loadEnabledOrderCoreMetrics(
  scope: KlaviyoConnectionScope,
): Promise<[EnabledOrderCoreMetric, EnabledOrderCoreMetric]> {
  const metrics = await db
    .select({
      metricRowId: klaviyoMetrics.id,
      externalMetricId: klaviyoMetrics.externalMetricId,
      metricKind: klaviyoMetrics.canonicalKind,
    })
    .from(klaviyoMetrics)
    .where(
      and(
        eq(klaviyoMetrics.organizationId, scope.organizationId),
        eq(klaviyoMetrics.storeId, scope.storeId),
        eq(klaviyoMetrics.connectionId, scope.connectionId),
        eq(klaviyoMetrics.ingestionEnabled, 1),
        inArray(klaviyoMetrics.canonicalKind, [...KLAVIYO_ORDER_CORE_KINDS]),
      ),
    );

  const byKind = new Map<string, (typeof metrics)[number]>();
  for (const metric of metrics) {
    if (
      metric.metricKind === null ||
      !KLAVIYO_ORDER_CORE_KINDS.includes(metric.metricKind as never) ||
      byKind.has(metric.metricKind)
    ) {
      throw new Error("Klaviyo order-core metric binding is ambiguous");
    }
    byKind.set(metric.metricKind, metric);
  }
  if (byKind.size !== KLAVIYO_ORDER_CORE_KINDS.length) {
    throw new Error("Klaviyo order-core metric binding is incomplete");
  }

  const metricIds = metrics.map((metric) => metric.metricRowId);
  const aliases = await db
    .select({
      metricId: klaviyoEventAliases.metricId,
      canonicalField: klaviyoEventAliases.canonicalField,
      sourceProperty: klaviyoEventAliases.sourceProperty,
    })
    .from(klaviyoEventAliases)
    .where(
      and(
        eq(klaviyoEventAliases.organizationId, scope.organizationId),
        eq(klaviyoEventAliases.storeId, scope.storeId),
        eq(klaviyoEventAliases.connectionId, scope.connectionId),
        eq(klaviyoEventAliases.state, "approved"),
        inArray(klaviyoEventAliases.metricId, metricIds),
      ),
    );

  const registries = new Map<string, KlaviyoEventAliasRegistry>();
  for (const metricId of metricIds) registries.set(metricId, emptyAliasRegistry());
  for (const alias of aliases) {
    const registry = registries.get(alias.metricId);
    if (
      !registry ||
      !KLAVIYO_EVENT_ALIAS_FIELDS.includes(alias.canonicalField as never)
    ) {
      throw new Error("Klaviyo approved alias is outside the metric scope");
    }
    const field = alias.canonicalField as KlaviyoEventAliasField;
    if (registry[field] !== null) {
      throw new Error("Klaviyo approved alias field is duplicated");
    }
    registry[field] = alias.sourceProperty;
  }

  return KLAVIYO_ORDER_CORE_KINDS.map((kind) => {
    const metric = byKind.get(kind);
    if (!metric) throw new Error("Klaviyo order-core metric binding is incomplete");
    return {
      metricRowId: metric.metricRowId,
      externalMetricId: metric.externalMetricId,
      metricKind: kind,
      approvedAliases: registries.get(metric.metricRowId)!,
    };
  }) as [EnabledOrderCoreMetric, EnabledOrderCoreMetric];
}

export async function startKlaviyoSyncRun(input: {
  scope: KlaviyoConnectionScope;
  operation: "discovery" | "probe" | "events";
  triggerType: string;
  window?: HalfOpenWindow;
  checkpoint?: KlaviyoEventCheckpoint | null;
  apiRevision?: string | null;
  requestParameters?: Record<string, JsonValue>;
}) {
  if (input.window) assertHalfOpenWindow(input.window);
  if (input.operation === "events") {
    assertExactOrderCoreRequestParameters(input.requestParameters);
    if (input.checkpoint !== null && input.checkpoint !== undefined) {
      assertExactEventCheckpoint(input.checkpoint);
    }
  }
  return withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [run] = await tx
      .insert(klaviyoSyncRuns)
      .values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        connectionId: input.scope.connectionId,
        operation: input.operation,
        triggerType: input.triggerType,
        requestParameters: input.requestParameters ?? {},
        requestedFrom: input.window?.from ?? null,
        requestedTo: input.window?.to ?? null,
        checkpoint: input.checkpoint ?? null,
        apiRevision: input.apiRevision ?? null,
        status: "running",
      })
      .returning({ id: klaviyoSyncRuns.id });
    return run;
  });
}

export async function renewKlaviyoSyncRunHeartbeat(
  input: {
    scope: KlaviyoConnectionScope;
    syncRunId: string;
    operation: "discovery" | "probe" | "dimensions" | "events" | "reports";
    now: Date;
  },
  executor: TransactionExecutor = db,
): Promise<{ changed: boolean }> {
  const now = new Date(input.now.getTime());
  if (Number.isNaN(now.getTime())) throw new Error("Invalid heartbeat time");
  return runInTransaction(executor, async (tx) => {
    const [run] = await tx
      .select({
        id: klaviyoSyncRuns.id,
        status: klaviyoSyncRuns.status,
      })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, input.operation),
        ),
      )
      .for("update");
    if (!run || run.status !== "running") {
      throw new Error("Klaviyo sync run is not active for this scoped operation");
    }
    const changed = await tx
      .update(klaviyoSyncRuns)
      .set({ heartbeatAt: now })
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, input.operation),
          eq(klaviyoSyncRuns.status, "running"),
          lte(klaviyoSyncRuns.heartbeatAt, now),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (changed.length !== 1) {
      throw new Error("Klaviyo sync run heartbeat cannot move backwards");
    }
    return { changed: true };
  });
}

export async function failExpiredKlaviyoSyncRun(
  input: {
    scope: KlaviyoConnectionScope;
    syncRunId: string;
    operation: "discovery" | "probe" | "dimensions" | "events" | "reports";
    now: Date;
  },
  executor: TransactionExecutor = db,
): Promise<{ changed: boolean }> {
  const now = new Date(input.now.getTime());
  if (Number.isNaN(now.getTime())) throw new Error("Invalid lease time");
  const staleAt = new Date(now.getTime() - KLAVIYO_RUN_STALE_AFTER_MS);
  return runInTransaction(executor, async (tx) => {
    await lockConnection(tx, input.scope);
    const [run] = await tx
      .select({
        id: klaviyoSyncRuns.id,
        status: klaviyoSyncRuns.status,
      })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, input.operation),
        ),
      )
      .for("update");
    if (!run) throw new Error("Klaviyo sync run is outside this scoped operation");
    if (run.status !== "running") {
      return { changed: false };
    }
    const failed = await tx
      .update(klaviyoSyncRuns)
      .set({
        status: "failed",
        errorCode: SAFE_LEASE_ERROR.code,
        errorMessage: SAFE_LEASE_ERROR.message,
        failureCount: sql`${klaviyoSyncRuns.failureCount} + 1`,
        finishedAt: now,
      })
      .where(
        and(
          eq(klaviyoSyncRuns.id, run.id),
          eq(klaviyoSyncRuns.status, "running"),
          lte(klaviyoSyncRuns.heartbeatAt, staleAt),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    return { changed: failed.length === 1 };
  });
}

/**
 * Prepare exactly one running run for a preparation-owned operation:
 * fixed-code finalize an expired lease, reuse a live identical request, or
 * insert a fresh running row. The operation's partial unique index is the
 * race backstop when application locking regresses.
 */
export async function prepareKlaviyoOperationRun(
  input: {
    scope: KlaviyoConnectionScope;
    operation: "discovery" | "probe" | "dimensions" | "reports";
    triggerType: string;
    requestParameters?: Record<string, JsonValue>;
    now: Date;
  },
  executor: TransactionExecutor = db,
): Promise<{ syncRunId: string; reused: boolean }> {
  const now = new Date(input.now.getTime());
  if (Number.isNaN(now.getTime())) throw new Error("Invalid preparation time");
  const requestParameters = input.requestParameters ?? {};
  const staleAt = new Date(now.getTime() - KLAVIYO_RUN_STALE_AFTER_MS);
  return runInTransaction(executor, async (tx) => {
    await lockConnection(tx, input.scope);
    const [running] = await tx
      .select({
        id: klaviyoSyncRuns.id,
        heartbeatAt: klaviyoSyncRuns.heartbeatAt,
        requestParameters: klaviyoSyncRuns.requestParameters,
      })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, input.operation),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .for("update");
    if (running) {
      if (running.heartbeatAt.getTime() > staleAt.getTime()) {
        if (
          JSON.stringify(running.requestParameters) !==
          JSON.stringify(requestParameters)
        ) {
          throw new Error(
            "A different Klaviyo run is already running for this scoped operation",
          );
        }
        return { syncRunId: running.id, reused: true };
      }
      const reaped = await tx
        .update(klaviyoSyncRuns)
        .set({
          status: "failed",
          errorCode: SAFE_LEASE_ERROR.code,
          errorMessage: SAFE_LEASE_ERROR.message,
          failureCount: sql`${klaviyoSyncRuns.failureCount} + 1`,
          finishedAt: now,
        })
        .where(
          and(
            eq(klaviyoSyncRuns.id, running.id),
            eq(klaviyoSyncRuns.status, "running"),
            lte(klaviyoSyncRuns.heartbeatAt, staleAt),
          ),
        )
        .returning({ id: klaviyoSyncRuns.id });
      if (reaped.length !== 1) {
        throw new Error("Klaviyo expired run reap raced; retry preparation");
      }
    }
    const [run] = await tx
      .insert(klaviyoSyncRuns)
      .values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        connectionId: input.scope.connectionId,
        operation: input.operation,
        triggerType: input.triggerType,
        requestParameters,
        status: "running",
        heartbeatAt: now,
        startedAt: now,
      })
      .returning({ id: klaviyoSyncRuns.id });
    return { syncRunId: run.id, reused: false };
  });
}

export async function commitKlaviyoDiscovery(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  expectedAccountId: string;
  account: {
    id: string;
    name: string | null;
    timezone: string | null;
    currency: string | null;
  };
  metrics: Array<{
    externalMetricId: string;
    name: string;
    integrationName: string | null;
    integrationCategory: string | null;
    canonicalKind: KlaviyoMetricKind | null;
    ingestionEnabled: boolean;
    apiRevision: string;
  }>;
}): Promise<void> {
  if (
    new Set(input.metrics.map((metric) => metric.externalMetricId)).size !==
    input.metrics.length
  ) {
    throw new Error("Klaviyo discovery contains a duplicate external metric ID");
  }
  const enabledOrderMetrics = input.metrics.filter(
    (metric) =>
      metric.ingestionEnabled &&
      metric.canonicalKind !== null &&
      KLAVIYO_ORDER_CORE_KINDS.includes(metric.canonicalKind as never),
  );
  for (const kind of KLAVIYO_ORDER_CORE_KINDS) {
    if (enabledOrderMetrics.filter((metric) => metric.canonicalKind === kind).length !== 1) {
      throw new Error("Discovery did not provide the complete native order metric binding");
    }
  }
  if (
    new Set(enabledOrderMetrics.map((metric) => metric.externalMetricId)).size !==
    KLAVIYO_ORDER_CORE_KINDS.length
  ) {
    throw new Error("Discovery native order metric IDs must be distinct");
  }

  await withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [connection] = await tx
      .select({
        accountId: klaviyoConnections.klaviyoAccountId,
        status: klaviyoConnections.status,
      })
      .from(klaviyoConnections)
      .where(scopePredicate(input.scope));
    if (!connection) throw new Error("Klaviyo connection not found in this scope");
    if (
      input.account.id !== input.expectedAccountId ||
      (connection.accountId !== null && connection.accountId !== input.account.id)
    ) {
      throw new Error("Discovered Klaviyo account does not match the Reviv binding");
    }

    const [run] = await tx
      .select({ id: klaviyoSyncRuns.id })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.operation, "discovery"),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .for("update");
    if (!run) throw new Error("Klaviyo discovery run is not active in this scope");

    const current = await tx
      .select({
        externalMetricId: klaviyoMetrics.externalMetricId,
        canonicalKind: klaviyoMetrics.canonicalKind,
      })
      .from(klaviyoMetrics)
      .where(
        and(
          eq(klaviyoMetrics.organizationId, input.scope.organizationId),
          eq(klaviyoMetrics.storeId, input.scope.storeId),
          eq(klaviyoMetrics.connectionId, input.scope.connectionId),
          eq(klaviyoMetrics.ingestionEnabled, 1),
          inArray(klaviyoMetrics.canonicalKind, [...KLAVIYO_ORDER_CORE_KINDS]),
        ),
      );
    const previousBindings = new Map(
      current.map((metric) => [metric.canonicalKind, metric.externalMetricId]),
    );
    const nextBindings = new Map(
      enabledOrderMetrics.map((metric) => [metric.canonicalKind, metric.externalMetricId]),
    );
    const nativeOrderBindingsChanged =
      previousBindings.size > 0 &&
      KLAVIYO_ORDER_CORE_KINDS.some(
        (kind) => previousBindings.get(kind) !== nextBindings.get(kind),
      );
    const discoveredAt = new Date();

    await tx
      .update(klaviyoMetrics)
      .set({ ingestionEnabled: 0, updatedAt: discoveredAt })
      .where(
        and(
          eq(klaviyoMetrics.organizationId, input.scope.organizationId),
          eq(klaviyoMetrics.storeId, input.scope.storeId),
          eq(klaviyoMetrics.connectionId, input.scope.connectionId),
          eq(klaviyoMetrics.ingestionEnabled, 1),
        ),
      );

    if (nativeOrderBindingsChanged) {
      await tx
        .update(klaviyoEventAliases)
        .set({ state: "disabled", updatedAt: discoveredAt })
        .where(
          and(
            eq(klaviyoEventAliases.organizationId, input.scope.organizationId),
            eq(klaviyoEventAliases.storeId, input.scope.storeId),
            eq(klaviyoEventAliases.connectionId, input.scope.connectionId),
            eq(klaviyoEventAliases.state, "approved"),
          ),
        );
      await tx
        .update(klaviyoJoinRules)
        .set({ state: "disabled", updatedAt: discoveredAt })
        .where(
          and(
            eq(klaviyoJoinRules.organizationId, input.scope.organizationId),
            eq(klaviyoJoinRules.storeId, input.scope.storeId),
            eq(klaviyoJoinRules.connectionId, input.scope.connectionId),
            eq(klaviyoJoinRules.state, "approved"),
          ),
        );
      await tx
        .update(klaviyoSyncRuns)
        .set({
          status: "failed",
          errorCode: "KLAVIYO_METRIC_BINDING_CHANGED",
          errorMessage:
            "Klaviyo native order metric binding changed; approve a new probe before source ingestion",
          failureCount: sql`${klaviyoSyncRuns.failureCount} + 1`,
          finishedAt: discoveredAt,
        })
        .where(
          and(
            eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
            eq(klaviyoSyncRuns.storeId, input.scope.storeId),
            eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
            eq(klaviyoSyncRuns.operation, "events"),
            eq(klaviyoSyncRuns.status, "running"),
          ),
        );
    }

    for (const metric of input.metrics) {
      await tx
        .insert(klaviyoMetrics)
        .values({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          externalMetricId: metric.externalMetricId,
          name: metric.name,
          integrationName: metric.integrationName,
          integrationCategory: metric.integrationCategory,
          canonicalKind: metric.canonicalKind,
          ingestionEnabled: metric.ingestionEnabled ? 1 : 0,
          apiRevision: metric.apiRevision,
        })
        .onConflictDoUpdate({
          target: [klaviyoMetrics.connectionId, klaviyoMetrics.externalMetricId],
          set: {
            name: metric.name,
            integrationName: metric.integrationName,
            integrationCategory: metric.integrationCategory,
            canonicalKind: metric.canonicalKind,
            ingestionEnabled: metric.ingestionEnabled ? 1 : 0,
            apiRevision: metric.apiRevision,
            updatedAt: discoveredAt,
          },
        });
    }

    await tx
      .update(klaviyoConnections)
      .set({
        klaviyoAccountId: input.account.id,
        accountName: input.account.name,
        timezone: input.account.timezone,
        currency: input.account.currency,
        status: nativeOrderBindingsChanged ? "pending" : connection.status,
        lastDiscoverySyncedAt: discoveredAt,
        updatedAt: discoveredAt,
      })
      .where(scopePredicate(input.scope));

    const finished = await tx
      .update(klaviyoSyncRuns)
      .set({ status: "success", finishedAt: discoveredAt })
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, "discovery"),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (finished.length !== 1) {
      throw new Error("Klaviyo discovery run is not active in this scope");
    }
  });
}

function sourceContractFromCheckpoint(checkpoint: KlaviyoEventCheckpoint) {
  return {
    sourceMode: checkpoint.sourceMode,
    metricKinds: checkpoint.metricKinds,
  };
}

function assertExactEventCheckpoint(
  value: unknown,
): asserts value is KlaviyoEventCheckpoint {
  assertOrderCoreSourceContract(value);
  const candidate = value as Partial<KlaviyoEventCheckpoint>;
  if (
    JSON.stringify(Object.keys(value as object).sort()) !==
      JSON.stringify([
        "cursor",
        "metricIndex",
        "metricKinds",
        "page",
        "sourceMode",
      ]) ||
    !Number.isInteger(candidate.metricIndex) ||
    candidate.metricIndex! < 0 ||
    candidate.metricIndex! >= KLAVIYO_ORDER_CORE_KINDS.length ||
    (candidate.cursor !== null && typeof candidate.cursor !== "string") ||
    !Number.isInteger(candidate.page) ||
    candidate.page! < 0
  ) {
    throw new Error("Klaviyo event checkpoint is invalid");
  }
}

export async function commitKlaviyoEventPage(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  sourceContract: OrderCoreSourceContract;
  expectedCheckpoint: KlaviyoEventCheckpoint;
  nextCheckpoint: KlaviyoEventCheckpoint | null;
  events: NormalizedKlaviyoEvent[];
  rowsRead: number;
}) {
  assertExactOrderCoreRequestParameters(input.sourceContract);
  assertExactEventCheckpoint(input.expectedCheckpoint);
  if (input.nextCheckpoint) assertExactEventCheckpoint(input.nextCheckpoint);
  if (
    JSON.stringify(sourceContractFromCheckpoint(input.expectedCheckpoint)) !==
      JSON.stringify(input.sourceContract) ||
    (input.nextCheckpoint !== null &&
      JSON.stringify(sourceContractFromCheckpoint(input.nextCheckpoint)) !==
        JSON.stringify(input.sourceContract))
  ) {
    throw new Error("Klaviyo event checkpoint source contract changed");
  }
  if (!Number.isInteger(input.rowsRead) || input.rowsRead < 0) {
    throw new Error("Klaviyo page row count is invalid");
  }

  // Store→connection→run lock order: a suppression hit may close
  // Shopify-order incident results, so the store lock comes first.
  return withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
    const [run] = await tx
      .select({
        checkpoint: klaviyoSyncRuns.checkpoint,
        requestParameters: klaviyoSyncRuns.requestParameters,
      })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, "events"),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .for("update");
    if (!run) throw new Error("Klaviyo event sync run is not active in this scope");
    assertExactOrderCoreRequestParameters(run.requestParameters);
    if (run.checkpoint !== null) assertExactEventCheckpoint(run.checkpoint);
    if (!sameCheckpoint(run.checkpoint, input.expectedCheckpoint)) {
      return { committed: false as const, inserted: 0, updated: 0, suppressed: 0 };
    }

    const enabledOrderMetrics = await tx
      .select({
        metricRowId: klaviyoMetrics.id,
        metricKind: klaviyoMetrics.canonicalKind,
      })
      .from(klaviyoMetrics)
      .where(
        and(
          eq(klaviyoMetrics.organizationId, input.scope.organizationId),
          eq(klaviyoMetrics.storeId, input.scope.storeId),
          eq(klaviyoMetrics.connectionId, input.scope.connectionId),
          eq(klaviyoMetrics.ingestionEnabled, 1),
          inArray(klaviyoMetrics.canonicalKind, [...KLAVIYO_ORDER_CORE_KINDS]),
        ),
      );
    const metricsByKind = new Map<
      (typeof KLAVIYO_ORDER_CORE_KINDS)[number],
      string
    >();
    for (const metric of enabledOrderMetrics) {
      if (
        metric.metricKind === null ||
        !KLAVIYO_ORDER_CORE_KINDS.includes(metric.metricKind as never) ||
        metricsByKind.has(
          metric.metricKind as (typeof KLAVIYO_ORDER_CORE_KINDS)[number],
        )
      ) {
        throw new Error("Klaviyo enabled order-core metric binding is ambiguous");
      }
      metricsByKind.set(
        metric.metricKind as (typeof KLAVIYO_ORDER_CORE_KINDS)[number],
        metric.metricRowId,
      );
    }
    if (metricsByKind.size !== KLAVIYO_ORDER_CORE_KINDS.length) {
      throw new Error("Klaviyo enabled order-core metric binding is incomplete");
    }
    const expectedMetricKind =
      KLAVIYO_ORDER_CORE_KINDS[input.expectedCheckpoint.metricIndex];
    const expectedMetricRowId = metricsByKind.get(expectedMetricKind);
    if (!expectedMetricRowId) {
      throw new Error("Klaviyo event checkpoint metric binding is unavailable");
    }
    for (const event of input.events) {
      if (
        event.metricKind !== expectedMetricKind ||
        event.metricId !== expectedMetricRowId
      ) {
        throw new Error("Klaviyo event does not match the active scoped metric binding");
      }
    }

    const [gate] = await tx
      .select({
        mode: klaviyoConnections.identityWriteMode,
        currentVersion: klaviyoConnections.identityCurrentKeyVersion,
        currentCheck: klaviyoConnections.identityCurrentKeyCheck,
        previousVersion: klaviyoConnections.identityPreviousKeyVersion,
        previousCheck: klaviyoConnections.identityPreviousKeyCheck,
      })
      .from(klaviyoConnections)
      .where(scopePredicate(input.scope));
    const identityBearing = input.events.some(
      (event) =>
        event.identityDigests.length > 0 ||
        event.erasureSuppressionCandidates.length > 0,
    );
    if (identityBearing) {
      if (!gate || gate.currentVersion === null) {
        throw new Error(
          "Klaviyo identity write gate is not initialized for this connection",
        );
      }
      const [policy] = await tx
        .select({
          matchingCurrentVersion: identityCryptoPolicies.matchingCurrentVersion,
          matchingCurrentKeyCheck:
            identityCryptoPolicies.matchingCurrentKeyCheck,
          matchingPreviousVersion:
            identityCryptoPolicies.matchingPreviousVersion,
          matchingPreviousKeyCheck:
            identityCryptoPolicies.matchingPreviousKeyCheck,
        })
        .from(identityCryptoPolicies)
        .where(
          and(
            eq(
              identityCryptoPolicies.organizationId,
              input.scope.organizationId,
            ),
            eq(identityCryptoPolicies.storeId, input.scope.storeId),
          ),
        );
      const policyAgrees =
        policy !== undefined &&
        policy.matchingCurrentVersion === gate.currentVersion &&
        constantTimeEqual(
          policy.matchingCurrentKeyCheck,
          gate.currentCheck ?? "",
        ) &&
        (gate.mode !== "dual" ||
          (policy.matchingPreviousVersion === gate.previousVersion &&
            constantTimeEqual(
              policy.matchingPreviousKeyCheck ?? "",
              gate.previousCheck ?? "",
            )));
      if (!policyAgrees) {
        throw new Error(
          "Klaviyo identity write gate disagrees with the store crypto policy",
        );
      }
    }
    const authorizedVersions: string[] =
      gate === undefined || gate.currentVersion === null
        ? []
        : gate.mode === "dual" && gate.previousVersion !== null
          ? [gate.currentVersion, gate.previousVersion]
          : [gate.currentVersion];

    let inserted = 0;
    let updated = 0;
    let suppressedCount = 0;
    const pageCommittedAt = new Date();
    for (const event of input.events) {
      if (event.erasureSuppressionCandidates.length > 0) {
        const [suppressionHit] = await tx
          .select({ id: identityErasureSuppressions.id })
          .from(identityErasureSuppressions)
          .where(
            and(
              eq(
                identityErasureSuppressions.organizationId,
                input.scope.organizationId,
              ),
              eq(identityErasureSuppressions.storeId, input.scope.storeId),
              or(
                ...event.erasureSuppressionCandidates.map((candidate) =>
                  and(
                    eq(identityErasureSuppressions.kind, candidate.kind),
                    eq(identityErasureSuppressions.keyVersion, candidate.keyVersion),
                    eq(identityErasureSuppressions.digest, candidate.digest),
                  ),
                ),
              ),
            ),
          )
          .limit(1);
        if (suppressionHit) {
          const [existingSuppressed] = await tx
            .select({ id: klaviyoEvents.id })
            .from(klaviyoEvents)
            .where(
              and(
                eq(klaviyoEvents.organizationId, input.scope.organizationId),
                eq(klaviyoEvents.storeId, input.scope.storeId),
                eq(klaviyoEvents.connectionId, input.scope.connectionId),
                eq(klaviyoEvents.externalEventId, event.externalEventId),
              ),
            )
            .limit(1);
          if (existingSuppressed) {
            await eraseSuppressedKlaviyoEventEvidence({
              scope: input.scope,
              eventId: existingSuppressed.id,
              suppressionId: suppressionHit.id,
              tx,
            });
          }
          // Only a safe counter survives; no event, product, profile ID,
          // digest, or observation is written for a suppressed subject.
          suppressedCount += 1;
          continue;
        }
      }
      const [existing] = await tx
        .select({ id: klaviyoEvents.id, checksum: klaviyoEvents.sourceChecksum })
        .from(klaviyoEvents)
        .where(
          and(
            eq(klaviyoEvents.organizationId, input.scope.organizationId),
            eq(klaviyoEvents.storeId, input.scope.storeId),
            eq(klaviyoEvents.connectionId, input.scope.connectionId),
            eq(klaviyoEvents.externalEventId, event.externalEventId),
          ),
        )
        .limit(1);

      const [stored] = await tx
        .insert(klaviyoEvents)
        .values({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          metricId: event.metricId,
          externalEventId: event.externalEventId,
          eventUuid: event.eventUuid,
          occurredAt: event.occurredAt,
          profileId: event.profileId,
          explicitOrderIdCandidate: event.explicitOrderIdCandidate,
          providerUniqueIdCandidate: event.providerUniqueIdCandidate,
          providerValue: event.providerValue,
          providerCurrency: event.providerCurrency,
          attributionRelationshipIds: event.attributionRelationshipIds,
          redactedProperties: event.evidence.values,
          keyTypeFingerprint: event.evidence.fingerprint,
          warnings: event.evidence.warnings,
          productEvidenceCompleteness: event.productEvidenceCompleteness,
          sourceChecksum: event.sourceChecksum,
          apiRevision: event.apiRevision,
        })
        .onConflictDoUpdate({
          target: [klaviyoEvents.connectionId, klaviyoEvents.externalEventId],
          set: {
            metricId: event.metricId,
            eventUuid: event.eventUuid,
            occurredAt: event.occurredAt,
            profileId: event.profileId,
            explicitOrderIdCandidate: event.explicitOrderIdCandidate,
            providerUniqueIdCandidate: event.providerUniqueIdCandidate,
            providerValue: event.providerValue,
            providerCurrency: event.providerCurrency,
            attributionRelationshipIds: event.attributionRelationshipIds,
            redactedProperties: event.evidence.values,
            keyTypeFingerprint: event.evidence.fingerprint,
            warnings: event.evidence.warnings,
            productEvidenceCompleteness: event.productEvidenceCompleteness,
            sourceChecksum: event.sourceChecksum,
            apiRevision: event.apiRevision,
            fetchedAt: pageCommittedAt,
            updatedAt: pageCommittedAt,
          },
        })
        .returning({ id: klaviyoEvents.id });

      if (event.productEvidenceCompleteness === "complete") {
        await tx
          .delete(klaviyoEventProducts)
          .where(
            and(
              eq(klaviyoEventProducts.organizationId, input.scope.organizationId),
              eq(klaviyoEventProducts.storeId, input.scope.storeId),
              eq(klaviyoEventProducts.connectionId, input.scope.connectionId),
              eq(klaviyoEventProducts.eventId, stored.id),
            ),
          );
        if (event.products.length > 0) {
          await tx.insert(klaviyoEventProducts).values(
            event.products.map((product) => ({
              organizationId: input.scope.organizationId,
              storeId: input.scope.storeId,
              connectionId: input.scope.connectionId,
              eventId: stored.id,
              sourceOrdinal: product.sourceOrdinal,
              productId: product.productId,
              variantId: product.variantId,
              sku: product.sku,
              productName: product.productName,
              variantName: product.variantName,
              quantity: product.quantity,
            })),
          );
        }
      }

      const observation = await tx
        .insert(klaviyoEventRunObservations)
        .values({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          syncRunId: input.syncRunId,
          eventId: stored.id,
          observedSourceChecksum: event.sourceChecksum,
        })
        .onConflictDoNothing({
          target: [
            klaviyoEventRunObservations.connectionId,
            klaviyoEventRunObservations.syncRunId,
            klaviyoEventRunObservations.eventId,
          ],
        })
        .returning({ checksum: klaviyoEventRunObservations.observedSourceChecksum });
      if (observation.length === 0) {
        const [prior] = await tx
          .select({ checksum: klaviyoEventRunObservations.observedSourceChecksum })
          .from(klaviyoEventRunObservations)
          .where(
            and(
              eq(klaviyoEventRunObservations.organizationId, input.scope.organizationId),
              eq(klaviyoEventRunObservations.storeId, input.scope.storeId),
              eq(klaviyoEventRunObservations.connectionId, input.scope.connectionId),
              eq(klaviyoEventRunObservations.syncRunId, input.syncRunId),
              eq(klaviyoEventRunObservations.eventId, stored.id),
            ),
          );
        if (prior?.checksum !== event.sourceChecksum) {
          throw new Error("Klaviyo run observation changed during replay");
        }
      }

      if (event.identityDigests.length > 0 && gate?.currentVersion) {
        const digestByVersion = new Map(
          event.identityDigests.map((entry) => [entry.keyVersion, entry.digest]),
        );
        let currentRowId: string | null = null;
        for (const version of authorizedVersions) {
          const digest = digestByVersion.get(version);
          if (digest === undefined) continue;
          const [existingRow] = await tx
            .select({
              id: sourceIdentityHmacs.id,
              digest: sourceIdentityHmacs.digest,
            })
            .from(sourceIdentityHmacs)
            .where(
              and(
                eq(sourceIdentityHmacs.organizationId, input.scope.organizationId),
                eq(sourceIdentityHmacs.storeId, input.scope.storeId),
                eq(sourceIdentityHmacs.klaviyoConnectionId, input.scope.connectionId),
                eq(sourceIdentityHmacs.klaviyoEventId, stored.id),
                eq(sourceIdentityHmacs.keyVersion, version),
              ),
            );
          let rowId: string;
          if (existingRow && existingRow.digest === digest) {
            // Identical digest replay reuses the immutable row ID.
            rowId = existingRow.id;
          } else {
            if (existingRow) {
              // Changed digest replaces the row so dependent identity
              // observations cascade before the fresh link.
              await tx
                .delete(sourceIdentityHmacs)
                .where(eq(sourceIdentityHmacs.id, existingRow.id));
            }
            const [insertedRow] = await tx
              .insert(sourceIdentityHmacs)
              .values({
                organizationId: input.scope.organizationId,
                storeId: input.scope.storeId,
                sourceKind: "klaviyo_event",
                klaviyoConnectionId: input.scope.connectionId,
                klaviyoEventId: stored.id,
                keyVersion: version,
                digest,
                rotationState: "active",
              })
              .returning({ id: sourceIdentityHmacs.id });
            rowId = insertedRow.id;
          }
          if (version === gate.currentVersion) currentRowId = rowId;
        }
        if (currentRowId !== null) {
          const linked = await tx
            .insert(klaviyoEventRunIdentityObservations)
            .values({
              organizationId: input.scope.organizationId,
              storeId: input.scope.storeId,
              connectionId: input.scope.connectionId,
              syncRunId: input.syncRunId,
              eventId: stored.id,
              identityHmacId: currentRowId,
            })
            .onConflictDoNothing({
              target: [
                klaviyoEventRunIdentityObservations.connectionId,
                klaviyoEventRunIdentityObservations.syncRunId,
                klaviyoEventRunIdentityObservations.eventId,
              ],
            })
            .returning({
              identityHmacId: klaviyoEventRunIdentityObservations.identityHmacId,
            });
          if (linked.length === 0) {
            const [prior] = await tx
              .select({
                identityHmacId:
                  klaviyoEventRunIdentityObservations.identityHmacId,
              })
              .from(klaviyoEventRunIdentityObservations)
              .where(
                and(
                  eq(
                    klaviyoEventRunIdentityObservations.connectionId,
                    input.scope.connectionId,
                  ),
                  eq(
                    klaviyoEventRunIdentityObservations.syncRunId,
                    input.syncRunId,
                  ),
                  eq(klaviyoEventRunIdentityObservations.eventId, stored.id),
                ),
              );
            if (prior?.identityHmacId !== currentRowId) {
              throw new Error(
                "Klaviyo run identity observation changed during replay",
              );
            }
          }
        }
      }

      if (!existing) inserted += 1;
      else if (existing.checksum !== event.sourceChecksum) updated += 1;
    }

    const advanced = await tx
      .update(klaviyoSyncRuns)
      .set({
        checkpoint: input.nextCheckpoint,
        heartbeatAt: sql`greatest(
          ${klaviyoSyncRuns.heartbeatAt},
          ${sql.param(pageCommittedAt, klaviyoSyncRuns.heartbeatAt)}
        )`,
        rowsRead: sql`${klaviyoSyncRuns.rowsRead} + ${input.rowsRead}`,
        rowsInserted: sql`${klaviyoSyncRuns.rowsInserted} + ${inserted}`,
        rowsUpdated: sql`${klaviyoSyncRuns.rowsUpdated} + ${updated}`,
        eventsSuppressed: sql`${klaviyoSyncRuns.eventsSuppressed} + ${suppressedCount}`,
      })
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, "events"),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (advanced.length !== 1) throw new Error("Klaviyo event checkpoint raced");
    return {
      committed: true as const,
      inserted,
      updated,
      suppressed: suppressedCount,
    };
  });
}

export async function finishKlaviyoSyncRun(
  input: {
    scope: KlaviyoConnectionScope;
    syncRunId: string;
    operation: "discovery" | "probe" | "dimensions" | "events" | "reports";
    status: "success" | "partial" | "failed";
    error?: unknown;
  },
  executor: TransactionExecutor = db,
): Promise<void> {
  const safeError = input.error === undefined ? null : safeSyncError(input.error);
  const finishedAt = new Date();
  await runInTransaction(executor, async (tx) => {
    await lockConnection(tx, input.scope);
    const finished = await tx
      .update(klaviyoSyncRuns)
      .set({
        status: input.status,
        errorCode: safeError?.code ?? null,
        errorMessage: safeError?.message ?? null,
        failureCount: input.error === undefined ? 0 : 1,
        finishedAt,
      })
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, input.operation),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (finished.length !== 1) {
      throw new Error("Klaviyo sync run is not active for this scoped operation");
    }

    if (input.operation === "events" && input.status === "success") {
      const refreshed = await tx
        .update(klaviyoConnections)
        .set({ lastEventSyncedAt: finishedAt, updatedAt: finishedAt })
        .where(scopePredicate(input.scope))
        .returning({ id: klaviyoConnections.id });
      if (refreshed.length !== 1) {
        throw new Error("Klaviyo sync run connection is not active in this scope");
      }
    }
  });
}

export async function failKlaviyoSyncRunAfterRetryExhaustion(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  operation: "discovery" | "probe" | "dimensions" | "events" | "reports";
}): Promise<{ changed: boolean }> {
  const finishedAt = new Date();
  return withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [run] = await tx
      .select({ status: klaviyoSyncRuns.status })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, input.operation),
        ),
      )
      .for("update");
    if (!run) throw new Error("Klaviyo sync run is outside this scoped operation");
    if (run.status !== "running") return { changed: false };

    const failed = await tx
      .update(klaviyoSyncRuns)
      .set({
        status: "failed",
        errorCode: SAFE_RETRY_ERROR.code,
        errorMessage: SAFE_RETRY_ERROR.message,
        failureCount: sql`${klaviyoSyncRuns.failureCount} + 1`,
        finishedAt,
      })
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, input.operation),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (failed.length !== 1) {
      throw new Error("Klaviyo retry-exhaustion finalization raced");
    }
    return { changed: true };
  });
}

export type SampledEvidenceOrder = {
  orderId: string;
  shopifyOrderId: string;
  orderCreatedAt: Date;
  identityDigests: string[];
};

/**
 * Newest orders whose Plan 1 evidence run committed a complete line set.
 * Line rows only exist after a complete replacement, so their presence is
 * the completeness signal.
 */
export async function listNewestEvidenceCompleteOrders(
  scope: KlaviyoConnectionScope,
  limit: number,
): Promise<SampledEvidenceOrder[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Probe sample size must be between 20 and 50");
  }
  const orders = await db
    .select({
      orderId: shopifyOrders.id,
      shopifyOrderId: shopifyOrders.shopifyOrderId,
      orderCreatedAt: shopifyOrders.orderCreatedAt,
    })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, scope.organizationId),
        eq(shopifyOrders.storeId, scope.storeId),
        exists(
          db
            .select({ one: sql`1` })
            .from(shopifyOrderLines)
            .where(
              and(
                eq(shopifyOrderLines.organizationId, scope.organizationId),
                eq(shopifyOrderLines.storeId, scope.storeId),
                eq(shopifyOrderLines.orderId, shopifyOrders.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(shopifyOrders.orderCreatedAt), desc(shopifyOrders.id))
    .limit(limit);
  if (orders.length === 0) return [];

  const digests = await db
    .select({
      orderId: sourceIdentityHmacs.shopifyOrderId,
      digest: sourceIdentityHmacs.digest,
    })
    .from(sourceIdentityHmacs)
    .where(
      and(
        eq(sourceIdentityHmacs.organizationId, scope.organizationId),
        eq(sourceIdentityHmacs.storeId, scope.storeId),
        inArray(
          sourceIdentityHmacs.shopifyOrderId,
          orders.map((order) => order.orderId),
        ),
      ),
    );
  const digestsByOrder = new Map<string, string[]>();
  for (const row of digests) {
    // Shopify-source rows always carry an order ID; the Klaviyo source kind
    // added by Plan 3 never matches the inArray filter above.
    if (row.orderId === null) continue;
    const bucket = digestsByOrder.get(row.orderId) ?? [];
    bucket.push(row.digest);
    digestsByOrder.set(row.orderId, bucket);
  }
  return orders.map((order) => ({
    ...order,
    identityDigests: digestsByOrder.get(order.orderId) ?? [],
  }));
}

export async function loadRunningProbeSampleSize(
  scope: KlaviyoConnectionScope,
  syncRunId: string,
): Promise<{ sampleSize: number }> {
  const [run] = await db
    .select({ requestParameters: klaviyoSyncRuns.requestParameters })
    .from(klaviyoSyncRuns)
    .where(
      and(
        eq(klaviyoSyncRuns.id, syncRunId),
        eq(klaviyoSyncRuns.organizationId, scope.organizationId),
        eq(klaviyoSyncRuns.storeId, scope.storeId),
        eq(klaviyoSyncRuns.connectionId, scope.connectionId),
        eq(klaviyoSyncRuns.operation, "probe"),
        eq(klaviyoSyncRuns.status, "running"),
      ),
    )
    .limit(1);
  if (!run) throw new Error("Klaviyo probe run is not active in this scope");
  const parameters = run.requestParameters as Record<string, unknown>;
  const sampleSize = parameters.sampleSize;
  if (
    Object.keys(parameters).length !== 1 ||
    typeof sampleSize !== "number" ||
    !Number.isInteger(sampleSize) ||
    sampleSize < 20 ||
    sampleSize > 50
  ) {
    throw new Error("Klaviyo probe request parameters are invalid");
  }
  return { sampleSize };
}

export type CandidateAliasInput = {
  metricRowId: string;
  canonicalField: KlaviyoEventAliasField;
  sourceProperty: string;
  observedPopulated: number;
  observedMalformed: number;
};

export type CandidateRuleInput = {
  eventKind: (typeof KLAVIYO_ORDER_CORE_KINDS)[number];
  sourceProperty: string;
  targetNamespace: string;
  canonicalizer: "shopify_order_gid" | "trimmed_exact";
  observedPopulated: number;
  observedCollisions: number;
};

/**
 * Persist one immutable pending probe report with its report-scoped
 * candidate aliases/rules and finish the probe run in the same transaction.
 * A failed probe never reaches this commit, so prior reports survive.
 */
export async function commitKlaviyoProbeReport(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  sampledFrom: Date;
  sampledTo: Date;
  sampledShopifyOrders: number;
  sampledKlaviyoEvents: number;
  persistence: ProbePersistence;
  checksum: string;
  candidateAliases: CandidateAliasInput[];
  candidateRules: CandidateRuleInput[];
  rowsRead: number;
}): Promise<{ reportId: string }> {
  if (
    !Number.isInteger(input.sampledShopifyOrders) ||
    input.sampledShopifyOrders < 20 ||
    input.sampledShopifyOrders > 50
  ) {
    throw new Error("Probe sample size must be between 20 and 50");
  }
  if (
    input.candidateAliases.some(
      (alias) =>
        alias.observedPopulated <= 0 || alias.observedMalformed < 0,
    )
  ) {
    throw new Error("Probe candidate aliases must carry populated counts");
  }

  return withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [run] = await tx
      .select({ id: klaviyoSyncRuns.id })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
          eq(klaviyoSyncRuns.storeId, input.scope.storeId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, "probe"),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .for("update");
    if (!run) throw new Error("Klaviyo probe run is not active in this scope");

    const committedAt = new Date();
    const [report] = await tx
      .insert(klaviyoProbeReports)
      .values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        connectionId: input.scope.connectionId,
        syncRunId: input.syncRunId,
        sampledFrom: input.sampledFrom,
        sampledTo: input.sampledTo,
        sampledShopifyOrders: input.sampledShopifyOrders,
        sampledKlaviyoEvents: input.sampledKlaviyoEvents,
        bindingOverlapCount: input.persistence.bindingOverlapCount,
        keyTypeShapes: input.persistence.keyTypeShapes,
        identifierCoverage: input.persistence.identifierCoverage,
        collisionSummary: input.persistence.collisionSummary,
        unmatchedSummary: input.persistence.unmatchedSummary,
        unmatchedExamples: input.persistence.unmatchedExamples,
        productCoverage: input.persistence.productCoverage,
        attributionCoverage: input.persistence.attributionCoverage,
        redactionVerified: input.persistence.redactionVerified ? 1 : 0,
        status: "pending",
        checksum: input.checksum,
      })
      .returning({ id: klaviyoProbeReports.id });

    if (input.candidateAliases.length > 0) {
      await tx.insert(klaviyoEventAliases).values(
        input.candidateAliases.map((alias) => ({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          metricId: alias.metricRowId,
          probeReportId: report.id,
          canonicalField: alias.canonicalField,
          sourceProperty: alias.sourceProperty,
          state: "candidate",
          observedPopulated: alias.observedPopulated,
          observedMalformed: alias.observedMalformed,
        })),
      );
    }
    if (input.candidateRules.length > 0) {
      await tx.insert(klaviyoJoinRules).values(
        input.candidateRules.map((rule) => ({
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
          connectionId: input.scope.connectionId,
          probeReportId: report.id,
          eventKind: rule.eventKind,
          sourceProperty: rule.sourceProperty,
          targetNamespace: rule.targetNamespace,
          canonicalizer: rule.canonicalizer,
          state: "candidate",
          observedPopulated: rule.observedPopulated,
          observedCollisions: rule.observedCollisions,
        })),
      );
    }

    const finished = await tx
      .update(klaviyoSyncRuns)
      .set({
        status: "success",
        rowsRead: sql`${klaviyoSyncRuns.rowsRead} + ${input.rowsRead}`,
        heartbeatAt: sql`greatest(
          ${klaviyoSyncRuns.heartbeatAt},
          ${sql.param(committedAt, klaviyoSyncRuns.heartbeatAt)}
        )`,
        finishedAt: committedAt,
      })
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.operation, "probe"),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (finished.length !== 1) {
      throw new Error("Klaviyo probe run is not active in this scope");
    }
    return { reportId: report.id };
  });
}

export type ProbePersistence = {
  bindingOverlapCount: number;
  keyTypeShapes: PropertyFingerprintEntry[];
  identifierCoverage: Record<string, number>;
  collisionSummary: Record<string, number>;
  unmatchedSummary: Record<string, number>;
  unmatchedExamples: RedactedProbeExample[];
  productCoverage: Record<string, number>;
  attributionCoverage: Record<string, number>;
  redactionVerified: boolean;
};

export type KlaviyoHealth = {
  configured: boolean;
  store: {
    id: string;
    shopDomain: string;
    ianaTimezone: string;
    currency: string | null;
    todayInStoreTz: string;
  } | null;
  connection: {
    status: "pending" | "ready" | "degraded" | "disabled";
    accountName: string | null;
    timezone: string | null;
    currency: string | null;
    todayInAccountTz: string | null;
    lastDiscoverySyncedAt: Date | null;
    lastEventSyncedAt: Date | null;
  } | null;
};

export async function getKlaviyoHealthForOrganization(
  organizationId: string,
  now: Date = new Date(),
  credentialProvider: KlaviyoCredentialProvider =
    new EnvironmentKlaviyoCredentialProvider(),
): Promise<KlaviyoHealth> {
  let binding: Awaited<ReturnType<KlaviyoCredentialProvider["getPilotBinding"]>>;
  try {
    binding = await credentialProvider.getPilotBinding();
  } catch {
    return { configured: false, store: null, connection: null };
  }

  const rows = await db
    .select({
      id: shopifyStores.id,
      shopDomain: shopifyStores.shopDomain,
      ianaTimezone: shopifyStores.ianaTimezone,
      storeCurrency: shopifyStores.currency,
      status: klaviyoConnections.status,
      accountName: klaviyoConnections.accountName,
      accountTimezone: klaviyoConnections.timezone,
      accountCurrency: klaviyoConnections.currency,
      lastDiscoverySyncedAt: klaviyoConnections.lastDiscoverySyncedAt,
      lastEventSyncedAt: klaviyoConnections.lastEventSyncedAt,
    })
    .from(shopifyStores)
    .leftJoin(
      klaviyoConnections,
      and(
        eq(klaviyoConnections.organizationId, shopifyStores.organizationId),
        eq(klaviyoConnections.storeId, shopifyStores.id),
      ),
    )
    .where(
      and(
        eq(shopifyStores.organizationId, organizationId),
        eq(shopifyStores.shopDomain, binding.shopDomain),
      ),
    )
    .limit(2);
  if (rows.length !== 1) return { configured: true, store: null, connection: null };
  const row = rows[0];
  const store = {
    id: row.id,
    shopDomain: row.shopDomain,
    ianaTimezone: row.ianaTimezone,
    currency: row.storeCurrency,
    todayInStoreTz: deriveDayInTimezone(now, row.ianaTimezone),
  };
  if (row.status === null) return { configured: true, store, connection: null };
  return {
    configured: true,
    store,
    connection: {
      status: row.status as KlaviyoHealth["connection"] extends infer T
        ? T extends { status: infer S }
          ? S
          : never
        : never,
      accountName: row.accountName,
      timezone: row.accountTimezone,
      currency: row.accountCurrency,
      todayInAccountTz: row.accountTimezone
        ? deriveDayInTimezone(now, row.accountTimezone)
        : null,
      lastDiscoverySyncedAt: row.lastDiscoverySyncedAt,
      lastEventSyncedAt: row.lastEventSyncedAt,
    },
  };
}

type CheckpointSummary = {
  sourceMode: "order_core" | "journey" | null;
  metricIndex: number | null;
  page: number | null;
};

export function summarizeCheckpoint(
  operation: string,
  checkpoint: unknown,
): CheckpointSummary | null {
  if (operation !== "events") {
    return null;
  }
  try {
    assertExactEventCheckpoint(checkpoint);
  } catch {
    return null;
  }
  return {
    sourceMode: checkpoint.sourceMode,
    metricIndex: checkpoint.metricIndex,
    page: checkpoint.page,
  };
}

type SyncRunCursor = { startedAt: string; id: string };

function encodeSyncCursor(cursor: SyncRunCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSyncCursor(value: string | null): SyncRunCursor | null {
  if (value === null) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      typeof (decoded as SyncRunCursor).id !== "string" ||
      typeof (decoded as SyncRunCursor).startedAt !== "string"
    ) {
      throw new Error("invalid");
    }
    const startedAt = new Date((decoded as SyncRunCursor).startedAt);
    if (Number.isNaN(startedAt.getTime())) throw new Error("invalid");
    return { id: (decoded as SyncRunCursor).id, startedAt: startedAt.toISOString() };
  } catch {
    throw new Error("Invalid Klaviyo sync-run cursor");
  }
}

export async function listKlaviyoSyncRuns(input: {
  scope: KlaviyoConnectionScope;
  limit: number;
  cursor: string | null;
}) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("Klaviyo sync-run limit must be between 1 and 100");
  }
  const cursor = decodeSyncCursor(input.cursor);
  const cursorDate = cursor ? new Date(cursor.startedAt) : null;
  const rows = await db
    .select({
      id: klaviyoSyncRuns.id,
      operation: klaviyoSyncRuns.operation,
      triggerType: klaviyoSyncRuns.triggerType,
      requestedFrom: klaviyoSyncRuns.requestedFrom,
      requestedTo: klaviyoSyncRuns.requestedTo,
      status: klaviyoSyncRuns.status,
      rowsRead: klaviyoSyncRuns.rowsRead,
      rowsInserted: klaviyoSyncRuns.rowsInserted,
      rowsUpdated: klaviyoSyncRuns.rowsUpdated,
      rowsIgnored: klaviyoSyncRuns.rowsIgnored,
      warningCount: klaviyoSyncRuns.warningCount,
      failureCount: klaviyoSyncRuns.failureCount,
      errorCode: klaviyoSyncRuns.errorCode,
      errorMessage: klaviyoSyncRuns.errorMessage,
      checkpoint: klaviyoSyncRuns.checkpoint,
      startedAt: klaviyoSyncRuns.startedAt,
      finishedAt: klaviyoSyncRuns.finishedAt,
    })
    .from(klaviyoSyncRuns)
    .where(
      and(
        eq(klaviyoSyncRuns.organizationId, input.scope.organizationId),
        eq(klaviyoSyncRuns.storeId, input.scope.storeId),
        eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
        cursor && cursorDate
          ? or(
              lt(klaviyoSyncRuns.startedAt, cursorDate),
              and(
                eq(klaviyoSyncRuns.startedAt, cursorDate),
                lt(klaviyoSyncRuns.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(klaviyoSyncRuns.startedAt), desc(klaviyoSyncRuns.id))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const items = page.map(({ checkpoint, ...row }) => ({
    ...row,
    errorCode: row.errorCode ? SAFE_SYNC_ERROR.code : null,
    errorMessage: row.errorCode ? safeSyncError(null).message : null,
    checkpointSummary: summarizeCheckpoint(row.operation, checkpoint),
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeSyncCursor({ startedAt: last.startedAt.toISOString(), id: last.id })
        : null,
  };
}

export async function listKlaviyoProbeReview(input: {
  scope: KlaviyoConnectionScope;
}) {
  const reports = await db
    .select({
      id: klaviyoProbeReports.id,
      sampledFrom: klaviyoProbeReports.sampledFrom,
      sampledTo: klaviyoProbeReports.sampledTo,
      sampledShopifyOrders: klaviyoProbeReports.sampledShopifyOrders,
      sampledKlaviyoEvents: klaviyoProbeReports.sampledKlaviyoEvents,
      bindingOverlapCount: klaviyoProbeReports.bindingOverlapCount,
      keyTypeShapes: klaviyoProbeReports.keyTypeShapes,
      identifierCoverage: klaviyoProbeReports.identifierCoverage,
      collisionSummary: klaviyoProbeReports.collisionSummary,
      unmatchedSummary: klaviyoProbeReports.unmatchedSummary,
      unmatchedExamples: klaviyoProbeReports.unmatchedExamples,
      productCoverage: klaviyoProbeReports.productCoverage,
      attributionCoverage: klaviyoProbeReports.attributionCoverage,
      redactionVerified: klaviyoProbeReports.redactionVerified,
      status: klaviyoProbeReports.status,
      reviewNote: klaviyoProbeReports.reviewNote,
      reviewedAt: klaviyoProbeReports.reviewedAt,
      createdAt: klaviyoProbeReports.createdAt,
    })
    .from(klaviyoProbeReports)
    .where(
      and(
        eq(klaviyoProbeReports.organizationId, input.scope.organizationId),
        eq(klaviyoProbeReports.storeId, input.scope.storeId),
        eq(klaviyoProbeReports.connectionId, input.scope.connectionId),
      ),
    )
    .orderBy(desc(klaviyoProbeReports.createdAt), desc(klaviyoProbeReports.id));
  const rules = await db
    .select({
      id: klaviyoJoinRules.id,
      probeReportId: klaviyoJoinRules.probeReportId,
      eventKind: klaviyoJoinRules.eventKind,
      sourceProperty: klaviyoJoinRules.sourceProperty,
      targetNamespace: klaviyoJoinRules.targetNamespace,
      canonicalizer: klaviyoJoinRules.canonicalizer,
      state: klaviyoJoinRules.state,
      observedPopulated: klaviyoJoinRules.observedPopulated,
      observedCollisions: klaviyoJoinRules.observedCollisions,
      reviewNote: klaviyoJoinRules.reviewNote,
      approvedAt: klaviyoJoinRules.approvedAt,
      matcherVersion: klaviyoJoinRules.matcherVersion,
      createdAt: klaviyoJoinRules.createdAt,
    })
    .from(klaviyoJoinRules)
    .where(
      and(
        eq(klaviyoJoinRules.organizationId, input.scope.organizationId),
        eq(klaviyoJoinRules.storeId, input.scope.storeId),
        eq(klaviyoJoinRules.connectionId, input.scope.connectionId),
      ),
    )
    .orderBy(asc(klaviyoJoinRules.createdAt), asc(klaviyoJoinRules.id));
  return {
    reports: reports.map((report) => ({
      ...report,
      redactionVerified: report.redactionVerified === 1,
    })),
    rules,
  };
}

export { klaviyoJoinRules, klaviyoProbeReports };
