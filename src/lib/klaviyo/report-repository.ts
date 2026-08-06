import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { KlaviyoApiClient, KLAVIYO_API_REVISIONS } from "@/lib/klaviyo/client";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialProvider,
} from "@/lib/klaviyo/credential-provider";
import {
  KLAVIYO_REPORT_FRESHNESS_MS,
  KLAVIYO_REPORT_KINDS,
  KLAVIYO_REPORT_MIN_INTERVAL_MS,
  KLAVIYO_REPORT_STATISTICS,
  normalizeReportRows,
  publicationScopeFingerprint,
  refreshFingerprint,
  refreshSetFingerprint,
  type KlaviyoReportKind,
  type KlaviyoReportRequest,
} from "@/lib/klaviyo/reports";
import {
  finishKlaviyoSyncRun,
  getConnectionRecord,
  renewKlaviyoSyncRunHeartbeat,
  withKlaviyoConnectionLock,
  type KlaviyoStoreTransaction,
} from "@/lib/klaviyo/source-store";
import {
  assertExactReportSyncCheckpoint,
  type JsonValue,
  type KlaviyoConnectionScope,
  type KlaviyoReportSyncCheckpoint,
} from "@/lib/klaviyo/types";
import {
  klaviyoConnections,
  klaviyoMetrics,
  klaviyoSyncRuns,
} from "@/schema/klaviyo";
import {
  klaviyoMarketingObjects,
  klaviyoReportFacts,
  klaviyoReportGenerations,
} from "@/schema/klaviyo-claim";

const REPORT_FAILURE = {
  code: "KLAVIYO_REPORT_FAILED",
  message: "Klaviyo report refresh did not complete",
};

export type ReportRunParameters = {
  operation: "reports";
  reason: "manual" | "scheduled";
  kinds: KlaviyoReportKind[];
  from: string;
  to: string;
  asOf: string;
  accountTimezone: string;
  conversionMetricRowId: string;
  conversionExternalMetricId: string;
  refreshSetFingerprint: string;
};

function assertExactReportRunParameters(
  value: unknown,
): asserts value is ReportRunParameters {
  const parameters = value as Partial<ReportRunParameters> | null;
  if (
    !parameters ||
    parameters.operation !== "reports" ||
    (parameters.reason !== "manual" && parameters.reason !== "scheduled") ||
    !Array.isArray(parameters.kinds) ||
    parameters.kinds.length === 0 ||
    parameters.kinds.some(
      (kind) => !KLAVIYO_REPORT_KINDS.includes(kind as KlaviyoReportKind),
    ) ||
    typeof parameters.from !== "string" ||
    typeof parameters.to !== "string" ||
    typeof parameters.asOf !== "string" ||
    typeof parameters.accountTimezone !== "string" ||
    typeof parameters.conversionMetricRowId !== "string" ||
    typeof parameters.conversionExternalMetricId !== "string" ||
    typeof parameters.refreshSetFingerprint !== "string"
  ) {
    throw new Error("Klaviyo report run parameters are invalid");
  }
}

export function reportRequestForKind(
  parameters: ReportRunParameters,
  kind: KlaviyoReportKind,
  connectionId: string,
): KlaviyoReportRequest {
  return {
    connectionId,
    kind,
    conversionMetricRowId: parameters.conversionMetricRowId,
    conversionExternalMetricId: parameters.conversionExternalMetricId,
    timeframe: { from: parameters.from, to: parameters.to },
    statistics: [...KLAVIYO_REPORT_STATISTICS],
    grouping: kind === "campaign" ? ["campaign_id", "send_date"] : ["flow_id", "send_date"],
    apiRevision: KLAVIYO_API_REVISIONS.reports,
    asOf: parameters.asOf,
  };
}

async function resolveConversionMetric(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
): Promise<{ rowId: string; externalId: string }> {
  const [metric] = await tx
    .select({
      rowId: klaviyoMetrics.id,
      externalId: klaviyoMetrics.externalMetricId,
    })
    .from(klaviyoMetrics)
    .where(
      and(
        eq(klaviyoMetrics.organizationId, scope.organizationId),
        eq(klaviyoMetrics.storeId, scope.storeId),
        eq(klaviyoMetrics.connectionId, scope.connectionId),
        eq(klaviyoMetrics.canonicalKind, "placed_order"),
        eq(klaviyoMetrics.ingestionEnabled, 1),
      ),
    )
    .limit(1);
  if (!metric) {
    throw new Error("Klaviyo report conversion metric is not discovered");
  }
  return metric;
}

export type StartReportSyncResult =
  | { kind: "fresh" }
  | {
      kind: "pending" | "started";
      syncRunId: string;
      asOf: string;
      stagedKinds: KlaviyoReportKind[];
    };

/**
 * Server-derived preflight under the connection lock. Freshness is decided
 * here — never inside the task: a scheduled request filters fresh kinds and
 * creates no work when none remain, a manual request stages every requested
 * kind with a new `asOf`. A compatible live run is returned with its
 * persisted `asOf` and staging set so retries and concurrent manual calls
 * reuse one graph instead of minting a new fingerprint per clock tick.
 */
export async function startOrResumeReportSync(input: {
  scope: KlaviyoConnectionScope;
  window: { from: Date; to: Date };
  kinds: KlaviyoReportKind[];
  reason: "manual" | "scheduled";
  now: Date;
}): Promise<StartReportSyncResult> {
  const now = new Date(input.now.getTime());
  if (Number.isNaN(now.getTime())) throw new Error("Invalid report time");
  if (input.window.from.getTime() >= input.window.to.getTime()) {
    throw new Error("Klaviyo report window is invalid");
  }
  const requestedKinds = [...new Set(input.kinds)].sort() as KlaviyoReportKind[];
  if (requestedKinds.length === 0) {
    throw new Error("Klaviyo report request needs at least one kind");
  }
  const staleAt = new Date(now.getTime() - 20 * 60 * 1000);

  return withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [connection] = await tx
      .select({ timezone: klaviyoConnections.timezone })
      .from(klaviyoConnections)
      .where(eq(klaviyoConnections.id, input.scope.connectionId))
      .limit(1);
    const accountTimezone = connection?.timezone ?? "UTC";
    const metric = await resolveConversionMetric(tx, input.scope);

    const [running] = await tx
      .select({
        id: klaviyoSyncRuns.id,
        heartbeatAt: klaviyoSyncRuns.heartbeatAt,
        requestParameters: klaviyoSyncRuns.requestParameters,
      })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, "reports"),
          eq(klaviyoSyncRuns.status, "running"),
        ),
      )
      .for("update");
    if (running) {
      if (running.heartbeatAt.getTime() > staleAt.getTime()) {
        assertExactReportRunParameters(running.requestParameters);
        const live = running.requestParameters;
        if (
          live.reason === input.reason &&
          live.from === input.window.from.toISOString() &&
          live.to === input.window.to.toISOString() &&
          JSON.stringify(live.kinds) === JSON.stringify(requestedKinds)
        ) {
          return {
            kind: "pending" as const,
            syncRunId: running.id,
            asOf: live.asOf,
            stagedKinds: live.kinds,
          };
        }
        throw new Error(
          "A different Klaviyo report run is already running for this connection",
        );
      }
      await failReportSyncLocked(tx, input.scope, running.id, now);
    }

    // Preflight against current slots — only when no live run exists.
    const asOf = now.toISOString();
    const probeParameters: ReportRunParameters = {
      operation: "reports",
      reason: input.reason,
      kinds: requestedKinds,
      from: input.window.from.toISOString(),
      to: input.window.to.toISOString(),
      asOf,
      accountTimezone,
      conversionMetricRowId: metric.rowId,
      conversionExternalMetricId: metric.externalId,
      refreshSetFingerprint: "",
    };
    let stagedKinds = requestedKinds;
    if (input.reason === "scheduled") {
      const staleKinds: KlaviyoReportKind[] = [];
      for (const kind of requestedKinds) {
        const request = reportRequestForKind(
          probeParameters,
          kind,
          input.scope.connectionId,
        );
        const scopeFingerprint = publicationScopeFingerprint(
          request,
          accountTimezone,
        );
        const [current] = await tx
          .select({ publishedAt: klaviyoReportGenerations.publishedAt })
          .from(klaviyoReportGenerations)
          .where(
            and(
              eq(
                klaviyoReportGenerations.connectionId,
                input.scope.connectionId,
              ),
              eq(
                klaviyoReportGenerations.publicationScopeFingerprint,
                scopeFingerprint,
              ),
              eq(klaviyoReportGenerations.status, "current"),
            ),
          )
          .limit(1);
        const fresh =
          current?.publishedAt !== undefined &&
          current.publishedAt !== null &&
          now.getTime() - current.publishedAt.getTime() <
            KLAVIYO_REPORT_FRESHNESS_MS;
        if (!fresh) staleKinds.push(kind);
      }
      if (staleKinds.length === 0) return { kind: "fresh" as const };
      stagedKinds = staleKinds;
    }

    const perKindRefresh = stagedKinds.map((kind) =>
      refreshFingerprint(
        reportRequestForKind(probeParameters, kind, input.scope.connectionId),
        accountTimezone,
      ),
    );
    const parameters: ReportRunParameters = {
      ...probeParameters,
      kinds: stagedKinds,
      refreshSetFingerprint: refreshSetFingerprint(perKindRefresh),
    };
    const checkpoint: KlaviyoReportSyncCheckpoint = {
      operation: "reports",
      kindIndex: 0,
      cursor: null,
      page: 0,
    };
    const [run] = await tx
      .insert(klaviyoSyncRuns)
      .values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        connectionId: input.scope.connectionId,
        operation: "reports",
        triggerType: input.reason,
        requestParameters: parameters as unknown as Record<string, JsonValue>,
        requestedFrom: input.window.from,
        requestedTo: input.window.to,
        checkpoint,
        status: "running",
        heartbeatAt: now,
        startedAt: now,
      })
      .returning({ id: klaviyoSyncRuns.id });
    for (const kind of stagedKinds) {
      const request = reportRequestForKind(
        parameters,
        kind,
        input.scope.connectionId,
      );
      await tx.insert(klaviyoReportGenerations).values({
        organizationId: input.scope.organizationId,
        storeId: input.scope.storeId,
        connectionId: input.scope.connectionId,
        syncRunId: run.id,
        kind,
        requestedFrom: input.window.from,
        requestedTo: input.window.to,
        accountTimezone,
        publicationScopeFingerprint: publicationScopeFingerprint(
          request,
          accountTimezone,
        ),
        refreshFingerprint: refreshFingerprint(request, accountTimezone),
        status: "staging",
      });
    }
    return {
      kind: "started" as const,
      syncRunId: run.id,
      asOf,
      stagedKinds,
    };
  });
}

async function failReportSyncLocked(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  syncRunId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(klaviyoReportGenerations)
    .set({ status: "failed" })
    .where(
      and(
        eq(klaviyoReportGenerations.syncRunId, syncRunId),
        eq(klaviyoReportGenerations.status, "staging"),
      ),
    );
  await tx
    .update(klaviyoSyncRuns)
    .set({
      status: "failed",
      errorCode: REPORT_FAILURE.code,
      errorMessage: REPORT_FAILURE.message,
      failureCount: sql`${klaviyoSyncRuns.failureCount} + 1`,
      finishedAt: now,
    })
    .where(
      and(
        eq(klaviyoSyncRuns.id, syncRunId),
        eq(klaviyoSyncRuns.connectionId, scope.connectionId),
        eq(klaviyoSyncRuns.operation, "reports"),
        eq(klaviyoSyncRuns.status, "running"),
      ),
    );
}

/**
 * Report-specific fixed-code failure wrapper: every staging generation for
 * the sync is failed atomically with the run finalization. Previous
 * current facts stay visible and `lastReportSyncedAt` never advances on
 * any partial or failure path.
 */
export async function failReportSync(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  now: Date;
}): Promise<{ changed: boolean }> {
  return withKlaviyoConnectionLock(input.scope, async (tx) => {
    const [run] = await tx
      .select({ status: klaviyoSyncRuns.status })
      .from(klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSyncRuns.id, input.syncRunId),
          eq(klaviyoSyncRuns.connectionId, input.scope.connectionId),
          eq(klaviyoSyncRuns.operation, "reports"),
        ),
      )
      .for("update");
    if (!run) throw new Error("Klaviyo report run is outside this scope");
    if (run.status !== "running") return { changed: false };
    await failReportSyncLocked(tx, input.scope, input.syncRunId, input.now);
    return { changed: true };
  });
}

export type ReportClient = Pick<KlaviyoApiClient, "queryValuesReport">;

export type ReportBatchDependencies = {
  createClient?: (privateApiKey: string) => ReportClient;
  credentialProvider?: KlaviyoCredentialProvider;
  now?: () => Date;
  spacer?: (milliseconds: number) => Promise<void>;
};

export type ReportBatchResult =
  | { done: false; checkpoint: KlaviyoReportSyncCheckpoint }
  | { done: true; checkpoint: null };

function extractReportRows(page: {
  data: Array<{ attributes?: Record<string, unknown> }>;
}): { rows: Array<Record<string, unknown>>; nextCursor: string | null } {
  const attributes = page.data[0]?.attributes ?? {};
  const results = Array.isArray(attributes.results) ? attributes.results : [];
  const cursor = attributes.page_cursor;
  return {
    rows: results.filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object",
    ),
    nextCursor: typeof cursor === "string" && cursor !== "" ? cursor : null,
  };
}

/**
 * Bounded low-quota report batch. At most one provider request is in
 * flight; the injected spacer is awaited between calls. Every page commits
 * only into its own kind's staging generation with checkpoint, heartbeat,
 * and counts together, so reads keep returning only the previous current
 * generation for each affected slot until the terminal atomic swap.
 */
export async function processReportBatch(
  input: {
    scope: KlaviyoConnectionScope;
    syncRunId: string;
    maxRequests?: number;
  },
  dependencies: ReportBatchDependencies = {},
): Promise<ReportBatchResult> {
  const now = dependencies.now ?? (() => new Date());
  const spacer =
    dependencies.spacer ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maxRequests = input.maxRequests ?? 10;

  const [run] = await db
    .select({
      status: klaviyoSyncRuns.status,
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
        eq(klaviyoSyncRuns.operation, "reports"),
      ),
    )
    .limit(1);
  if (!run) throw new Error("Klaviyo report run is outside this scope");
  if (run.status !== "running") {
    throw new Error("Klaviyo report run is not active");
  }
  assertExactReportRunParameters(run.requestParameters);
  const parameters = run.requestParameters;
  if (run.checkpoint === null) {
    await publishTerminalReportSync({
      scope: input.scope,
      syncRunId: input.syncRunId,
      now: now(),
    });
    return { done: true, checkpoint: null };
  }
  assertExactReportSyncCheckpoint(run.checkpoint);
  let checkpoint = run.checkpoint;

  const generations = await db
    .select({
      id: klaviyoReportGenerations.id,
      kind: klaviyoReportGenerations.kind,
      status: klaviyoReportGenerations.status,
      requestFingerprintKind: klaviyoReportGenerations.refreshFingerprint,
    })
    .from(klaviyoReportGenerations)
    .where(eq(klaviyoReportGenerations.syncRunId, input.syncRunId))
    .orderBy(asc(klaviyoReportGenerations.kind));
  if (
    generations.length === 0 ||
    generations.some((generation) => generation.status !== "staging")
  ) {
    throw new Error("Klaviyo report staging generations are not intact");
  }

  const connection = await getConnectionRecord(input.scope);
  if (!connection) throw new Error("Klaviyo connection is outside this scope");
  const credentialProvider =
    dependencies.credentialProvider ??
    new EnvironmentKlaviyoCredentialProvider();
  const credential = await credentialProvider.resolve({
    connectionId: connection.connectionId,
    credentialReference: connection.credentialReference,
    persistedKlaviyoAccountId: connection.klaviyoAccountId,
    shopDomain: connection.shopDomain,
  });
  const createClient =
    dependencies.createClient ??
    ((privateApiKey: string): ReportClient =>
      new KlaviyoApiClient({ privateApiKey }));
  const client = createClient(credential.privateApiKey);

  let requestsUsed = 0;
  while (requestsUsed < maxRequests) {
    const generation = generations[checkpoint.kindIndex];
    if (generation === undefined) {
      await publishTerminalReportSync({
        scope: input.scope,
        syncRunId: input.syncRunId,
        now: now(),
      });
      return { done: true, checkpoint: null };
    }
    await renewKlaviyoSyncRunHeartbeat({
      scope: input.scope,
      syncRunId: input.syncRunId,
      operation: "reports",
      now: now(),
    });
    if (requestsUsed > 0) await spacer(KLAVIYO_REPORT_MIN_INTERVAL_MS);
    const request = reportRequestForKind(
      parameters,
      generation.kind,
      input.scope.connectionId,
    );
    const page = await client.queryValuesReport({
      request,
      pageCursor: checkpoint.cursor,
    });
    requestsUsed += 1;
    const { rows, nextCursor } = extractReportRows(page);
    const requestFingerprintValue = refreshFingerprint(
      request,
      parameters.accountTimezone,
    );
    const { facts } = normalizeReportRows({
      kind: generation.kind,
      requestFingerprint: requestFingerprintValue,
      rows,
    });

    const nextCheckpoint: KlaviyoReportSyncCheckpoint =
      nextCursor !== null
        ? { ...checkpoint, cursor: nextCursor, page: checkpoint.page + 1 }
        : {
            operation: "reports",
            kindIndex: checkpoint.kindIndex + 1,
            cursor: null,
            page: 0,
          };

    await withKlaviyoConnectionLock(input.scope, async (tx) => {
      const [locked] = await tx
        .select({ checkpoint: klaviyoSyncRuns.checkpoint })
        .from(klaviyoSyncRuns)
        .where(
          and(
            eq(klaviyoSyncRuns.id, input.syncRunId),
            eq(klaviyoSyncRuns.status, "running"),
          ),
        )
        .for("update");
      if (!locked) throw new Error("Klaviyo report run is not active");
      assertExactReportSyncCheckpoint(locked.checkpoint);
      if (
        locked.checkpoint.kindIndex !== checkpoint.kindIndex ||
        locked.checkpoint.cursor !== checkpoint.cursor ||
        locked.checkpoint.page !== checkpoint.page
      ) {
        throw new Error("Klaviyo report checkpoint moved; replay this batch");
      }
      for (const fact of facts) {
        const campaignObjectId = await resolveReportObject(
          tx,
          input.scope,
          "campaign",
          fact.campaignExternalId,
        );
        const flowObjectId = await resolveReportObject(
          tx,
          input.scope,
          "flow",
          fact.flowExternalId,
        );
        await tx
          .insert(klaviyoReportFacts)
          .values({
            organizationId: input.scope.organizationId,
            storeId: input.scope.storeId,
            connectionId: input.scope.connectionId,
            generationId: generation.id,
            reportKind: generation.kind,
            conversionMetricId: parameters.conversionMetricRowId,
            campaignObjectId,
            flowObjectId,
            messageObjectId: null,
            requestedFrom: new Date(parameters.from),
            requestedTo: new Date(parameters.to),
            accountTimezone: parameters.accountTimezone,
            grouping: fact.grouping,
            requestFingerprint: requestFingerprintValue,
            factFingerprint: fact.factFingerprint,
            conversions: fact.statistics.conversions,
            conversionValue: fact.statistics.conversionValue,
            recipients: fact.statistics.recipients,
            uniqueClicks: fact.statistics.uniqueClicks,
            uniqueOpens: fact.statistics.uniqueOpens,
            additionalStatistics: fact.additionalStatistics,
            apiRevision: request.apiRevision,
            asOf: new Date(parameters.asOf),
            fetchedAt: now(),
          })
          .onConflictDoNothing({
            target: [
              klaviyoReportFacts.generationId,
              klaviyoReportFacts.factFingerprint,
            ],
          });
      }
      await tx
        .update(klaviyoReportGenerations)
        .set({
          factCount: sql`(select count(*) from ${klaviyoReportFacts}
            where ${klaviyoReportFacts.generationId} = ${generation.id})`,
        })
        .where(eq(klaviyoReportGenerations.id, generation.id));
      await tx
        .update(klaviyoSyncRuns)
        .set({
          checkpoint: nextCheckpoint,
          heartbeatAt: now(),
          rowsRead: sql`${klaviyoSyncRuns.rowsRead} + ${rows.length}`,
          rowsInserted: sql`${klaviyoSyncRuns.rowsInserted} + ${facts.length}`,
          apiRevision: request.apiRevision,
        })
        .where(
          and(
            eq(klaviyoSyncRuns.id, input.syncRunId),
            eq(klaviyoSyncRuns.status, "running"),
          ),
        );
    });
    checkpoint = nextCheckpoint;

    if (checkpoint.kindIndex >= generations.length) {
      await publishTerminalReportSync({
        scope: input.scope,
        syncRunId: input.syncRunId,
        now: now(),
      });
      return { done: true, checkpoint: null };
    }
  }
  return { done: false, checkpoint };
}

async function resolveReportObject(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  objectType: "campaign" | "flow",
  externalId: string | null,
): Promise<string | null> {
  if (externalId === null) return null;
  const [row] = await tx
    .select({ id: klaviyoMarketingObjects.id })
    .from(klaviyoMarketingObjects)
    .where(
      and(
        eq(klaviyoMarketingObjects.connectionId, scope.connectionId),
        eq(klaviyoMarketingObjects.objectType, objectType),
        eq(klaviyoMarketingObjects.externalId, externalId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * The one atomic terminal publication. Locks the connection and all
 * staging generations in canonical kind order, revalidates the refresh
 * set, supersedes each affected slot's prior current generation before
 * marking its staging generation current, finishes the sync run through
 * the widened scoped finalizer inside the same transaction, and only then
 * advances `lastReportSyncedAt`. Any failure rolls the whole swap back.
 * No other code finishes a successful report run or marks a generation
 * current.
 */
export async function publishTerminalReportSync(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  now: Date;
}): Promise<{ publishedKinds: KlaviyoReportKind[] }> {
  return withKlaviyoConnectionLock(input.scope, async (tx) => {
    const staging = await tx
      .select({
        id: klaviyoReportGenerations.id,
        kind: klaviyoReportGenerations.kind,
        status: klaviyoReportGenerations.status,
        publicationScopeFingerprint:
          klaviyoReportGenerations.publicationScopeFingerprint,
      })
      .from(klaviyoReportGenerations)
      .where(eq(klaviyoReportGenerations.syncRunId, input.syncRunId))
      .orderBy(asc(klaviyoReportGenerations.kind))
      .for("update");
    if (
      staging.length === 0 ||
      staging.some((generation) => generation.status !== "staging")
    ) {
      throw new Error("Klaviyo report staging generations are not intact");
    }
    for (const generation of staging) {
      await tx
        .update(klaviyoReportGenerations)
        .set({ status: "superseded", supersededAt: input.now })
        .where(
          and(
            eq(
              klaviyoReportGenerations.connectionId,
              input.scope.connectionId,
            ),
            eq(
              klaviyoReportGenerations.publicationScopeFingerprint,
              generation.publicationScopeFingerprint,
            ),
            eq(klaviyoReportGenerations.status, "current"),
          ),
        );
      await tx
        .update(klaviyoReportGenerations)
        .set({ status: "current", publishedAt: input.now })
        .where(eq(klaviyoReportGenerations.id, generation.id));
    }
    await finishKlaviyoSyncRun(
      {
        scope: input.scope,
        syncRunId: input.syncRunId,
        operation: "reports",
        status: "success",
      },
      tx,
    );
    await tx
      .update(klaviyoConnections)
      .set({ lastReportSyncedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(klaviyoConnections.organizationId, input.scope.organizationId),
          eq(klaviyoConnections.storeId, input.scope.storeId),
          eq(klaviyoConnections.id, input.scope.connectionId),
        ),
      );
    return { publishedKinds: staging.map((generation) => generation.kind) };
  });
}

/**
 * Read facts only from the one current generation of the requested
 * logical slot — never staging, failed, superseded, or a union of
 * overlapping generations.
 */
export async function listCurrentReportFacts(input: {
  scope: KlaviyoConnectionScope;
  kind: KlaviyoReportKind;
  limit?: number;
  offset?: number;
}): Promise<{
  generationId: string | null;
  publishedAt: Date | null;
  facts: Array<{
    id: string;
    grouping: Record<string, JsonValue>;
    conversions: string | null;
    conversionValue: string | null;
    recipients: string | null;
    uniqueClicks: string | null;
    uniqueOpens: string | null;
    campaignObjectId: string | null;
    flowObjectId: string | null;
    asOf: Date;
  }>;
}> {
  const [generation] = await db
    .select({
      id: klaviyoReportGenerations.id,
      publishedAt: klaviyoReportGenerations.publishedAt,
    })
    .from(klaviyoReportGenerations)
    .where(
      and(
        eq(klaviyoReportGenerations.connectionId, input.scope.connectionId),
        eq(klaviyoReportGenerations.organizationId, input.scope.organizationId),
        eq(klaviyoReportGenerations.storeId, input.scope.storeId),
        eq(klaviyoReportGenerations.kind, input.kind),
        eq(klaviyoReportGenerations.status, "current"),
      ),
    )
    .orderBy(asc(klaviyoReportGenerations.publishedAt))
    .limit(1);
  if (!generation) return { generationId: null, publishedAt: null, facts: [] };
  const facts = await db
    .select({
      id: klaviyoReportFacts.id,
      grouping: klaviyoReportFacts.grouping,
      conversions: klaviyoReportFacts.conversions,
      conversionValue: klaviyoReportFacts.conversionValue,
      recipients: klaviyoReportFacts.recipients,
      uniqueClicks: klaviyoReportFacts.uniqueClicks,
      uniqueOpens: klaviyoReportFacts.uniqueOpens,
      campaignObjectId: klaviyoReportFacts.campaignObjectId,
      flowObjectId: klaviyoReportFacts.flowObjectId,
      asOf: klaviyoReportFacts.asOf,
    })
    .from(klaviyoReportFacts)
    .where(eq(klaviyoReportFacts.generationId, generation.id))
    .orderBy(asc(klaviyoReportFacts.factFingerprint))
    .limit(Math.min(input.limit ?? 100, 500))
    .offset(input.offset ?? 0);
  return {
    generationId: generation.id,
    publishedAt: generation.publishedAt,
    facts,
  };
}

