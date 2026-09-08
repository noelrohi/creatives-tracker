import "server-only";

import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  KlaviyoApiClient,
  KlaviyoApiError,
  KLAVIYO_API_REVISIONS,
  type KlaviyoCompoundPage,
} from "@/lib/klaviyo/client";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialProvider,
} from "@/lib/klaviyo/credential-provider";
import {
  KLAVIYO_REPORT_FRESHNESS_MS,
  KLAVIYO_REPORT_KINDS,
  KLAVIYO_REPORT_MIN_INTERVAL_MS,
  KLAVIYO_REPORT_STATISTICS,
  isMessageReportKind,
  normalizeReportRows,
  publicationScopeFingerprint,
  refreshFingerprint,
  refreshSetFingerprint,
  reportEndpointKind,
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

/**
 * Each kind's grouping. Only message kinds put theirs on the wire (see
 * `wireGroupBy`); the parent kinds' entries stay in the request so their
 * fingerprints keep naming the slot they actually describe.
 */
const GROUPING_BY_KIND: Record<
  KlaviyoReportKind,
  KlaviyoReportRequest["grouping"]
> = {
  campaign: ["campaign_id", "send_date"],
  flow: ["flow_id", "send_date"],
  campaign_message: ["campaign_id", "campaign_message_id"],
  flow_message: ["flow_id", "flow_message_id"],
};

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
    grouping: [...GROUPING_BY_KIND[kind]],
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
      failureReason: klaviyoReportGenerations.failureReason,
      requestFingerprintKind: klaviyoReportGenerations.refreshFingerprint,
    })
    .from(klaviyoReportGenerations)
    .where(eq(klaviyoReportGenerations.syncRunId, input.syncRunId))
    .orderBy(asc(klaviyoReportGenerations.kind));
  // A `failed` sibling is tolerated: the message-grouping fallback below
  // fails one generation mid-run and a later batch must resume past it.
  if (
    generations.length === 0 ||
    generations.some(
      (generation) =>
        generation.status !== "staging" && generation.status !== "failed",
    )
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
    if (generation.status === "failed") {
      checkpoint = await advanceKindLocked(input, checkpoint, now());
      if (checkpoint.kindIndex >= generations.length) {
        await publishTerminalReportSync({
          scope: input.scope,
          syncRunId: input.syncRunId,
          now: now(),
        });
        return { done: true, checkpoint: null };
      }
      continue;
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
    let page: KlaviyoCompoundPage;
    try {
      page = await client.queryValuesReport({
        request,
        pageCursor: checkpoint.cursor,
      });
    } catch (error) {
      if (
        error instanceof KlaviyoApiError &&
        error.status === 400 &&
        isMessageReportKind(generation.kind)
      ) {
        // The pinned revision rejected the message grouping: fail only this
        // generation and let the parent kinds publish (spec §3.3 fallback).
        requestsUsed += 1;
        await withKlaviyoConnectionLock(input.scope, async (tx) => {
          await tx
            .update(klaviyoReportGenerations)
            .set({ status: "failed", failureReason: "grouping_unsupported" })
            .where(eq(klaviyoReportGenerations.id, generation.id));
        });
        generation.status = "failed";
        checkpoint = await advanceKindLocked(input, checkpoint, now());
        if (checkpoint.kindIndex >= generations.length) {
          await publishTerminalReportSync({
            scope: input.scope,
            syncRunId: input.syncRunId,
            now: now(),
          });
          return { done: true, checkpoint: null };
        }
        continue;
      }
      throw error;
    }
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
      let insertedFacts = 0;
      const endpoint = reportEndpointKind(generation.kind);
      for (const fact of facts) {
        let campaignObjectId = await resolveReportObject(
          tx,
          input.scope,
          "campaign",
          fact.campaignExternalId,
        );
        let flowObjectId = await resolveReportObject(
          tx,
          input.scope,
          "flow",
          fact.flowExternalId,
        );
        let messageObjectId: string | null = null;
        if (isMessageReportKind(generation.kind)) {
          const message = await resolveMessageObject(
            tx,
            input.scope,
            generation.kind === "campaign_message"
              ? "campaign_message"
              : "flow_message",
            fact.messageExternalId,
          );
          // A message fact that names no known message is unusable: skip it
          // (rows_read - rows_inserted on the run records how many).
          if (message === null) continue;
          messageObjectId = message.id;
          if (endpoint === "campaign" && campaignObjectId === null) {
            campaignObjectId = message.parentId;
          }
          if (endpoint === "flow" && flowObjectId === null) {
            flowObjectId = message.parentId;
          }
        }
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
            messageObjectId,
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
            delivered: fact.statistics.delivered,
            bounced: fact.statistics.bounced,
            unsubscribes: fact.statistics.unsubscribes,
            spamComplaints: fact.statistics.spamComplaints,
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
        insertedFacts += 1;
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
          rowsInserted: sql`${klaviyoSyncRuns.rowsInserted} + ${insertedFacts}`,
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

/** Move the checkpoint to the next kind under the lock, guarding against a moved checkpoint. */
async function advanceKindLocked(
  input: { scope: KlaviyoConnectionScope; syncRunId: string },
  checkpoint: KlaviyoReportSyncCheckpoint,
  now: Date,
): Promise<KlaviyoReportSyncCheckpoint> {
  const next: KlaviyoReportSyncCheckpoint = {
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
    if (locked.checkpoint.kindIndex !== checkpoint.kindIndex) {
      throw new Error("Klaviyo report checkpoint moved; replay this batch");
    }
    await tx
      .update(klaviyoSyncRuns)
      .set({ checkpoint: next, heartbeatAt: now })
      .where(eq(klaviyoSyncRuns.id, input.syncRunId));
  });
  return next;
}

async function resolveMessageObject(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  objectType: "campaign_message" | "flow_message",
  externalId: string | null,
): Promise<{ id: string; parentId: string | null } | null> {
  if (externalId === null) return null;
  const [row] = await tx
    .select({
      id: klaviyoMarketingObjects.id,
      parentId: klaviyoMarketingObjects.parentId,
    })
    .from(klaviyoMarketingObjects)
    .where(
      and(
        eq(klaviyoMarketingObjects.connectionId, scope.connectionId),
        eq(klaviyoMarketingObjects.objectType, objectType),
        eq(klaviyoMarketingObjects.externalId, externalId),
      ),
    )
    .limit(1);
  return row ?? null;
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
        failureReason: klaviyoReportGenerations.failureReason,
        publicationScopeFingerprint:
          klaviyoReportGenerations.publicationScopeFingerprint,
        requestedFrom: klaviyoReportGenerations.requestedFrom,
        requestedTo: klaviyoReportGenerations.requestedTo,
      })
      .from(klaviyoReportGenerations)
      .where(eq(klaviyoReportGenerations.syncRunId, input.syncRunId))
      .orderBy(asc(klaviyoReportGenerations.kind))
      .for("update");
    // Only `staging` rows publish. A `failed` sibling from the message
    // grouping fallback is tolerated, but a run with nothing left to
    // publish must not be treated as a success.
    const stagingOnly = staging.filter(
      (generation) => generation.status === "staging",
    );
    if (
      stagingOnly.length === 0 &&
      staging.length > 0 &&
      staging.every(
        (generation) =>
          generation.status === "failed" &&
          generation.failureReason === "grouping_unsupported",
      )
    ) {
      // The pinned revision rejects every staged kind's grouping. There is
      // nothing to publish and nothing to retry, so finish the run as a
      // success — otherwise the nightly fails forever once the parent kinds
      // are fresh. Nothing becomes `current` and `lastReportSyncedAt` stays
      // put, so reads keep serving the previous current generations.
      await finishKlaviyoSyncRun(
        {
          scope: input.scope,
          syncRunId: input.syncRunId,
          operation: "reports",
          status: "success",
        },
        tx,
      );
      return { publishedKinds: [] };
    }
    if (
      staging.length === 0 ||
      staging.some(
        (generation) =>
          generation.status !== "staging" && generation.status !== "failed",
      ) ||
      stagingOnly.length === 0
    ) {
      throw new Error("Klaviyo report staging generations are not intact");
    }
    for (const generation of stagingOnly) {
      // Supersede by logical slot (window + kind) as well as fingerprint, so a
      // fingerprint change (e.g. a widened statistics list) cannot leave a
      // stale `current` beside the new one.
      await tx
        .update(klaviyoReportGenerations)
        .set({ status: "superseded", supersededAt: input.now })
        .where(
          and(
            eq(
              klaviyoReportGenerations.connectionId,
              input.scope.connectionId,
            ),
            eq(klaviyoReportGenerations.status, "current"),
            or(
              eq(
                klaviyoReportGenerations.publicationScopeFingerprint,
                generation.publicationScopeFingerprint,
              ),
              and(
                eq(klaviyoReportGenerations.kind, generation.kind),
                eq(
                  klaviyoReportGenerations.requestedFrom,
                  generation.requestedFrom,
                ),
                eq(
                  klaviyoReportGenerations.requestedTo,
                  generation.requestedTo,
                ),
              ),
            ),
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
    return { publishedKinds: stagingOnly.map((generation) => generation.kind) };
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
  window: { from: Date; to: Date };
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
    delivered: string | null;
    bounced: string | null;
    unsubscribes: string | null;
    spamComplaints: string | null;
    campaignObjectId: string | null;
    flowObjectId: string | null;
    messageObjectId: string | null;
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
        eq(klaviyoReportGenerations.requestedFrom, input.window.from),
        eq(klaviyoReportGenerations.requestedTo, input.window.to),
      ),
    )
    .orderBy(desc(klaviyoReportGenerations.publishedAt))
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
      delivered: klaviyoReportFacts.delivered,
      bounced: klaviyoReportFacts.bounced,
      unsubscribes: klaviyoReportFacts.unsubscribes,
      spamComplaints: klaviyoReportFacts.spamComplaints,
      campaignObjectId: klaviyoReportFacts.campaignObjectId,
      flowObjectId: klaviyoReportFacts.flowObjectId,
      messageObjectId: klaviyoReportFacts.messageObjectId,
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

