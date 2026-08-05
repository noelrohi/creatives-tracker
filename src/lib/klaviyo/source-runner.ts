import "server-only";

import { and, eq } from "drizzle-orm";
import {
  parseErasureSuppressionKey,
  parseIdentityHmacKeyring,
  type ErasureSuppressionKey,
  type IdentityHmacKeyring,
} from "@/lib/identity-hmac";
import {
  KlaviyoApiClient,
} from "@/lib/klaviyo/client";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialProvider,
} from "@/lib/klaviyo/credential-provider";
import { normalizeEventPage } from "@/lib/klaviyo/event-normalizer";
import {
  KLAVIYO_RUN_STALE_AFTER_MS,
  commitKlaviyoEventPage,
  failExpiredKlaviyoSyncRun,
  finishKlaviyoSyncRun,
  getConnectionRecord,
  loadEnabledOrderCoreMetrics,
  renewKlaviyoSyncRunHeartbeat,
  withKlaviyoConnectionLock,
} from "@/lib/klaviyo/source-store";
import { deriveDayInTimezone } from "@/lib/shopify-ingest";
import {
  KLAVIYO_ORDER_CORE_KINDS,
  assertExactOrderCoreRequestParameters,
  assertHalfOpenWindow,
  assertOrderCoreSourceContract,
  inclusiveStoreDaysToHalfOpenUtc,
  initialEventCheckpoint,
  orderCoreSourceContract,
  type HalfOpenWindow,
  type KlaviyoConnectionScope,
  type KlaviyoEventCheckpoint,
} from "@/lib/klaviyo/types";
import {
  klaviyoConnections,
  klaviyoProbeReports,
  klaviyoSyncRuns,
} from "@/schema/klaviyo";
import { shopifyStores } from "@/schema/shopify";
import { db } from "@/db";

export const KLAVIYO_INITIAL_SOURCE_DAYS = 90;

export function nextEventCheckpoint(
  current: KlaviyoEventCheckpoint,
  nextCursor: string | null,
): KlaviyoEventCheckpoint | null {
  assertOrderCoreSourceContract(current);
  if (nextCursor) {
    return { ...current, cursor: nextCursor, page: current.page + 1 };
  }
  if (current.metricIndex + 1 < KLAVIYO_ORDER_CORE_KINDS.length) {
    return {
      sourceMode: current.sourceMode,
      metricKinds: current.metricKinds,
      metricIndex: current.metricIndex + 1,
      cursor: null,
      page: 0,
    };
  }
  return null;
}

export type RunningEventRun = {
  syncRunId: string;
  requestedFrom: Date | null;
  requestedTo: Date | null;
  requestParameters: unknown;
  heartbeatAt: Date;
};

export type LockedEventRunOps = {
  getLockedConnection(): Promise<{
    status: string;
    storeTimezone: string;
    initialSourceFrom: Date | null;
    initialSourceTo: Date | null;
  }>;
  hasPassedProbe(): Promise<boolean>;
  findRunningEventRun(): Promise<RunningEventRun | null>;
  failExpiredEventRun(syncRunId: string, now: Date): Promise<{ changed: boolean }>;
  persistInitialWindow(window: HalfOpenWindow): Promise<void>;
  insertEventRun(input: {
    window: HalfOpenWindow;
    triggerType: string;
  }): Promise<{ syncRunId: string }>;
};

export type EventRunStore = {
  withConnectionLock<T>(
    scope: KlaviyoConnectionScope,
    work: (ops: LockedEventRunOps) => Promise<T>,
  ): Promise<T>;
};

export type EventRunRecord = {
  status: string;
  requestParameters: unknown;
  checkpoint: KlaviyoEventCheckpoint | null;
  requestedFrom: Date | null;
  requestedTo: Date | null;
};

export type SourceRunnerDependencies = {
  createClient?: (
    privateApiKey: string,
  ) => Pick<KlaviyoApiClient, "listEvents">;
  credentialProvider?: KlaviyoCredentialProvider;
  now?: () => Date;
  loadIdentityKeyring?: () => IdentityHmacKeyring;
  loadSuppressionKey?: () => ErasureSuppressionKey;
  loadConnection?: typeof getConnectionRecord;
  loadEnabledMetrics?: typeof loadEnabledOrderCoreMetrics;
  renewHeartbeat?: typeof renewKlaviyoSyncRunHeartbeat;
  commitPage?: typeof commitKlaviyoEventPage;
  finishRun?: typeof finishKlaviyoSyncRun;
  loadEventRun?: (
    scope: KlaviyoConnectionScope,
    syncRunId: string,
  ) => Promise<EventRunRecord>;
  runStore?: EventRunStore;
};

const databaseEventRunStore: EventRunStore = {
  withConnectionLock(scope, work) {
    return withKlaviyoConnectionLock(scope, async (tx) => {
      const ops: LockedEventRunOps = {
        async getLockedConnection() {
          const [row] = await tx
            .select({
              status: klaviyoConnections.status,
              storeTimezone: shopifyStores.ianaTimezone,
              initialSourceFrom: klaviyoConnections.initialSourceFrom,
              initialSourceTo: klaviyoConnections.initialSourceTo,
            })
            .from(klaviyoConnections)
            .innerJoin(
              shopifyStores,
              eq(shopifyStores.id, klaviyoConnections.storeId),
            )
            .where(
              and(
                eq(klaviyoConnections.organizationId, scope.organizationId),
                eq(klaviyoConnections.storeId, scope.storeId),
                eq(klaviyoConnections.id, scope.connectionId),
              ),
            )
            .limit(1);
          if (!row) throw new Error("Klaviyo connection is outside this scope");
          return row;
        },
        async hasPassedProbe() {
          const [report] = await tx
            .select({ id: klaviyoProbeReports.id })
            .from(klaviyoProbeReports)
            .where(
              and(
                eq(klaviyoProbeReports.organizationId, scope.organizationId),
                eq(klaviyoProbeReports.storeId, scope.storeId),
                eq(klaviyoProbeReports.connectionId, scope.connectionId),
                eq(klaviyoProbeReports.status, "passed"),
              ),
            )
            .limit(1);
          return report !== undefined;
        },
        async findRunningEventRun() {
          const [run] = await tx
            .select({
              syncRunId: klaviyoSyncRuns.id,
              requestedFrom: klaviyoSyncRuns.requestedFrom,
              requestedTo: klaviyoSyncRuns.requestedTo,
              requestParameters: klaviyoSyncRuns.requestParameters,
              heartbeatAt: klaviyoSyncRuns.heartbeatAt,
            })
            .from(klaviyoSyncRuns)
            .where(
              and(
                eq(klaviyoSyncRuns.organizationId, scope.organizationId),
                eq(klaviyoSyncRuns.storeId, scope.storeId),
                eq(klaviyoSyncRuns.connectionId, scope.connectionId),
                eq(klaviyoSyncRuns.operation, "events"),
                eq(klaviyoSyncRuns.status, "running"),
              ),
            )
            .for("update");
          return run ?? null;
        },
        async failExpiredEventRun(syncRunId, now) {
          return failExpiredKlaviyoSyncRun(
            { scope, syncRunId, operation: "events", now },
            tx,
          );
        },
        async persistInitialWindow(window) {
          await tx
            .update(klaviyoConnections)
            .set({
              initialSourceFrom: window.from,
              initialSourceTo: window.to,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(klaviyoConnections.organizationId, scope.organizationId),
                eq(klaviyoConnections.storeId, scope.storeId),
                eq(klaviyoConnections.id, scope.connectionId),
              ),
            );
        },
        async insertEventRun(input) {
          const [run] = await tx
            .insert(klaviyoSyncRuns)
            .values({
              organizationId: scope.organizationId,
              storeId: scope.storeId,
              connectionId: scope.connectionId,
              operation: "events",
              triggerType: input.triggerType,
              requestParameters: orderCoreSourceContract(),
              requestedFrom: input.window.from,
              requestedTo: input.window.to,
              checkpoint: initialEventCheckpoint(),
              status: "running",
            })
            .returning({ id: klaviyoSyncRuns.id });
          return { syncRunId: run.id };
        },
      };
      return work(ops);
    });
  },
};

async function defaultLoadEventRun(
  scope: KlaviyoConnectionScope,
  syncRunId: string,
): Promise<EventRunRecord> {
  const [run] = await db
    .select({
      status: klaviyoSyncRuns.status,
      requestParameters: klaviyoSyncRuns.requestParameters,
      checkpoint: klaviyoSyncRuns.checkpoint,
      requestedFrom: klaviyoSyncRuns.requestedFrom,
      requestedTo: klaviyoSyncRuns.requestedTo,
    })
    .from(klaviyoSyncRuns)
    .where(
      and(
        eq(klaviyoSyncRuns.id, syncRunId),
        eq(klaviyoSyncRuns.organizationId, scope.organizationId),
        eq(klaviyoSyncRuns.storeId, scope.storeId),
        eq(klaviyoSyncRuns.connectionId, scope.connectionId),
        eq(klaviyoSyncRuns.operation, "events"),
      ),
    )
    .limit(1);
  if (!run) throw new Error("Klaviyo event sync run is outside this scope");
  return run;
}

function storeDayMinusDays(day: string, amount: number): string {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, dayOfMonth - amount))
    .toISOString()
    .slice(0, 10);
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

export async function startOrResumeOrderCoreSync(
  input: {
    scope: KlaviyoConnectionScope;
    window: HalfOpenWindow;
    triggerType: "manual_backfill" | "scheduled";
  },
  dependencies: SourceRunnerDependencies = {},
): Promise<{ syncRunId: string; resumed: boolean }> {
  (dependencies.loadIdentityKeyring ?? parseIdentityHmacKeyring)();
  assertHalfOpenWindow(input.window);
  const now = dependencies.now ?? (() => new Date());
  const runStore = dependencies.runStore ?? databaseEventRunStore;

  return runStore.withConnectionLock(input.scope, async (ops) => {
    const connection = await ops.getLockedConnection();
    if (connection.status !== "ready") {
      throw new Error("Klaviyo source ingestion requires a ready connection");
    }
    if (!(await ops.hasPassedProbe())) {
      throw new Error("Klaviyo source ingestion requires a passed probe report");
    }

    const currentInstant = now();
    const today = deriveDayInTimezone(currentInstant, connection.storeTimezone);
    const floorDay = storeDayMinusDays(today, KLAVIYO_INITIAL_SOURCE_DAYS - 1);
    const allowed = inclusiveStoreDaysToHalfOpenUtc({
      dateFrom: floorDay,
      dateTo: today,
      timeZone: connection.storeTimezone,
    });

    if (connection.initialSourceFrom === null) {
      if (
        input.window.from.getTime() < allowed.from.getTime() ||
        input.window.to.getTime() > allowed.to.getTime()
      ) {
        throw new Error(
          "Klaviyo initial source window must stay inside the 90-store-day boundary",
        );
      }
      // The fixed approved floor/current bound persists — not a possibly
      // shorter first request — so later runs may extend back to it.
      await ops.persistInitialWindow(allowed);
    } else {
      if (input.window.from.getTime() < connection.initialSourceFrom.getTime()) {
        throw new Error(
          "Klaviyo source window cannot begin before the approved initial floor",
        );
      }
      if (input.window.to.getTime() > allowed.to.getTime()) {
        throw new Error(
          "Klaviyo source window cannot end after the current store day",
        );
      }
    }

    const running = await ops.findRunningEventRun();
    if (running) {
      const stale =
        running.heartbeatAt.getTime() <=
        currentInstant.getTime() - KLAVIYO_RUN_STALE_AFTER_MS;
      if (stale) {
        const reaped = await ops.failExpiredEventRun(
          running.syncRunId,
          currentInstant,
        );
        if (!reaped.changed) {
          throw new Error("Klaviyo expired event run reap raced; retry start");
        }
      } else {
        assertExactOrderCoreRequestParameters(running.requestParameters);
        if (
          sameInstant(running.requestedFrom, input.window.from) &&
          sameInstant(running.requestedTo, input.window.to)
        ) {
          return { syncRunId: running.syncRunId, resumed: true };
        }
        throw new Error(
          "A Klaviyo event run is already running with a different window",
        );
      }
    }

    const created = await ops.insertEventRun({
      window: input.window,
      triggerType: input.triggerType,
    });
    return { syncRunId: created.syncRunId, resumed: false };
  });
}

function assertCheckpointMatchesContract(
  checkpoint: KlaviyoEventCheckpoint,
  requestParameters: unknown,
): void {
  assertExactOrderCoreRequestParameters(requestParameters);
  assertOrderCoreSourceContract(checkpoint);
  const contract = requestParameters as {
    sourceMode: string;
    metricKinds: readonly string[];
  };
  if (
    checkpoint.sourceMode !== contract.sourceMode ||
    checkpoint.metricKinds.length !== contract.metricKinds.length ||
    checkpoint.metricKinds.some(
      (kind, index) => kind !== contract.metricKinds[index],
    ) ||
    !Number.isInteger(checkpoint.metricIndex) ||
    checkpoint.metricIndex < 0 ||
    checkpoint.metricIndex >= KLAVIYO_ORDER_CORE_KINDS.length ||
    !Number.isInteger(checkpoint.page) ||
    checkpoint.page < 0 ||
    (checkpoint.cursor !== null && typeof checkpoint.cursor !== "string")
  ) {
    throw new Error("Klaviyo event checkpoint does not match the run contract");
  }
}

export async function processOrderCoreBatch(
  input: {
    scope: KlaviyoConnectionScope;
    syncRunId: string;
    maxPages: number;
  },
  dependencies: SourceRunnerDependencies = {},
): Promise<{
  done: boolean;
  pagesProcessed: number;
  eventsRead: number;
  checkpoint: KlaviyoEventCheckpoint | null;
}> {
  if (!Number.isInteger(input.maxPages) || input.maxPages < 1) {
    throw new Error("Klaviyo batch page bound is invalid");
  }
  // Both key configurations resolve server-side before any page write; a
  // missing or invalid keyring fails the batch here.
  const identityKeyring = (
    dependencies.loadIdentityKeyring ?? parseIdentityHmacKeyring
  )();
  const suppressionKey = (
    dependencies.loadSuppressionKey ?? parseErasureSuppressionKey
  )();

  const loadEventRun = dependencies.loadEventRun ?? defaultLoadEventRun;
  const run = await loadEventRun(input.scope, input.syncRunId);
  if (run.status !== "running") {
    throw new Error("Klaviyo event sync run is not active in this scope");
  }
  assertExactOrderCoreRequestParameters(run.requestParameters);

  const finishRun = dependencies.finishRun ?? finishKlaviyoSyncRun;
  if (run.checkpoint === null) {
    // Terminal-null continuation: the last page committed but the finish was
    // interrupted. Validate the contract and finish without any refetch.
    await finishRun({
      scope: input.scope,
      syncRunId: input.syncRunId,
      operation: "events",
      status: "success",
    });
    return { done: true, pagesProcessed: 0, eventsRead: 0, checkpoint: null };
  }
  assertCheckpointMatchesContract(run.checkpoint, run.requestParameters);
  if (run.requestedFrom === null || run.requestedTo === null) {
    throw new Error("Klaviyo event sync run window is missing");
  }
  const window: HalfOpenWindow = { from: run.requestedFrom, to: run.requestedTo };
  assertHalfOpenWindow(window);

  const now = dependencies.now ?? (() => new Date());
  const renewHeartbeat =
    dependencies.renewHeartbeat ?? renewKlaviyoSyncRunHeartbeat;
  await renewHeartbeat({
    scope: input.scope,
    syncRunId: input.syncRunId,
    operation: "events",
    now: now(),
  });

  const loadConnection = dependencies.loadConnection ?? getConnectionRecord;
  const connection = await loadConnection(input.scope);
  if (!connection) throw new Error("Klaviyo connection is outside this scope");
  const credentialProvider =
    dependencies.credentialProvider ?? new EnvironmentKlaviyoCredentialProvider();
  const credential = await credentialProvider.resolve({
    connectionId: connection.connectionId,
    credentialReference: connection.credentialReference,
    persistedKlaviyoAccountId: connection.klaviyoAccountId,
    shopDomain: connection.shopDomain,
  });

  const metrics = await (
    dependencies.loadEnabledMetrics ?? loadEnabledOrderCoreMetrics
  )(input.scope);
  const client = (
    dependencies.createClient ??
    ((privateApiKey: string) => new KlaviyoApiClient({ privateApiKey }))
  )(credential.privateApiKey);
  const commitPage = dependencies.commitPage ?? commitKlaviyoEventPage;
  const merchantHosts = new Set(credential.allowedUrlHosts);

  let checkpoint: KlaviyoEventCheckpoint = run.checkpoint;
  let pagesProcessed = 0;
  let eventsRead = 0;

  while (pagesProcessed < input.maxPages) {
    const metric = metrics[checkpoint.metricIndex];
    if (!metric || metric.metricKind !== checkpoint.metricKinds[checkpoint.metricIndex]) {
      throw new Error("Klaviyo event checkpoint metric binding is unavailable");
    }
    // Canonical order-core pages request the sparse profile email so
    // identity digests can be derived in memory; the email itself is
    // discarded inside normalization and never crosses into persistence.
    const page = await client.listEvents({
      metricId: metric.externalMetricId,
      from: window.from,
      to: window.to,
      cursor: checkpoint.cursor,
      includeAttributions: true,
      includeProfileEmail: true,
    });
    const events = normalizeEventPage({
      metricRowId: metric.metricRowId,
      externalMetricId: metric.externalMetricId,
      metricKind: metric.metricKind,
      apiRevision: page.apiRevision,
      merchantHosts,
      approvedAliases: metric.approvedAliases,
      page,
      identity: {
        scope: {
          organizationId: input.scope.organizationId,
          storeId: input.scope.storeId,
        },
        identityKeyring,
        suppressionKey,
      },
    });
    const next = nextEventCheckpoint(checkpoint, page.nextCursor);
    const result = await commitPage({
      scope: input.scope,
      syncRunId: input.syncRunId,
      sourceContract: orderCoreSourceContract(),
      expectedCheckpoint: checkpoint,
      nextCheckpoint: next,
      events,
      rowsRead: page.data.length,
    });
    if (!result.committed) {
      return { done: false, pagesProcessed, eventsRead, checkpoint };
    }
    pagesProcessed += 1;
    eventsRead += events.length;
    if (next === null) {
      await finishRun({
        scope: input.scope,
        syncRunId: input.syncRunId,
        operation: "events",
        status: "success",
      });
      return { done: true, pagesProcessed, eventsRead, checkpoint: null };
    }
    checkpoint = next;
  }

  return { done: false, pagesProcessed, eventsRead, checkpoint };
}
