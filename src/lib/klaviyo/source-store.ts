import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { parseIdentityHmacKeyring } from "@/lib/identity-hmac";
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
import { shopifyStores } from "@/schema/shopify";
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
        ),
      )
      .returning({ id: klaviyoSyncRuns.id });
    if (changed.length !== 1) {
      throw new Error("Klaviyo sync run is not active for this scoped operation");
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
          ...metric,
          ingestionEnabled: metric.ingestionEnabled ? 1 : 0,
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

  return withKlaviyoConnectionLock(input.scope, async (tx) => {
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
      return { committed: false as const, inserted: 0, updated: 0 };
    }

    let inserted = 0;
    let updated = 0;
    const pageCommittedAt = new Date();
    for (const event of input.events) {
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
              ...product,
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

      if (!existing) inserted += 1;
      else if (existing.checksum !== event.sourceChecksum) updated += 1;
    }

    const advanced = await tx
      .update(klaviyoSyncRuns)
      .set({
        checkpoint: input.nextCheckpoint,
        heartbeatAt: pageCommittedAt,
        rowsRead: sql`${klaviyoSyncRuns.rowsRead} + ${input.rowsRead}`,
        rowsInserted: sql`${klaviyoSyncRuns.rowsInserted} + ${inserted}`,
        rowsUpdated: sql`${klaviyoSyncRuns.rowsUpdated} + ${updated}`,
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
    return { committed: true as const, inserted, updated };
  });
}

export async function finishKlaviyoSyncRun(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  operation: "discovery" | "probe" | "events";
  status: "success" | "partial" | "failed";
  error?: unknown;
}): Promise<void> {
  const safeError = input.error === undefined ? null : safeSyncError(input.error);
  const finishedAt = new Date();
  await withKlaviyoConnectionLock(input.scope, async (tx) => {
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
  if (typeof checkpoint !== "object" || checkpoint === null || Array.isArray(checkpoint)) {
    return null;
  }
  const value = checkpoint as Record<string, unknown>;
  const page =
    Number.isInteger(value.page) && (value.page as number) >= 0
      ? (value.page as number)
      : null;
  if (operation !== "events") {
    return page === null
      ? null
      : { sourceMode: null, metricIndex: null, page };
  }
  const sourceMode = value.sourceMode;
  const metricIndex = value.metricIndex;
  if (
    (sourceMode !== "order_core" && sourceMode !== "journey") ||
    !Number.isInteger(metricIndex) ||
    (metricIndex as number) < 0 ||
    page === null
  ) {
    return null;
  }
  if (sourceMode === "order_core") {
    try {
      assertOrderCoreSourceContract(value);
    } catch {
      return null;
    }
    if ((metricIndex as number) > 1) return null;
  }
  return { sourceMode, metricIndex: metricIndex as number, page };
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
  return { reports, rules };
}

export { klaviyoJoinRules, klaviyoProbeReports };
