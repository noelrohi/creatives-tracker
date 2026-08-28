import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { KlaviyoApiClient } from "@/lib/klaviyo/client";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialProvider,
} from "@/lib/klaviyo/credential-provider";
import {
  CLAIM_BATCH_SOFT_DEADLINE_MS,
  CLAIM_REPLAY_LOOKBACK_DAYS,
  MAX_CLAIM_CONVERSIONS_PER_BATCH,
  MAX_CLAIM_REMOTE_CALLS_PER_BATCH,
  MAX_FAILED_CLAIM_RETRIES_PER_GRAPH,
  MAX_INCOMPLETE_CLAIM_RETRIES_PER_GRAPH,
  MAX_REFERENCED_EVENT_FETCHES_PER_CONVERSION,
  assertExactClaimReplayCheckpoint,
  normalizeAttributionClaims,
  normalizeReferencedInteraction,
  type ClaimReplayCheckpoint,
  type NormalizedAttributionClaim,
  type RedactedInteractionDetail,
} from "@/lib/klaviyo/claims";
import {
  resolveCurrentPublishedMatchRun,
  verifyClaimPublication,
  verifyCurrentClaimAnchor,
  verifyPublishedMatchFreshness,
  type SafeMatchStaleReason,
} from "@/lib/klaviyo/match-freshness";
import {
  withKlaviyoStoreConnectionLock,
  getConnectionRecord,
  type KlaviyoStoreTransaction,
} from "@/lib/klaviyo/source-store";
import type { KlaviyoConnectionScope, KlaviyoMetricKind } from "@/lib/klaviyo/types";
import { klaviyoEvents, klaviyoMetrics } from "@/schema/klaviyo";
import {
  klaviyoAttributionClaims,
  klaviyoClaimReplayRuns,
  klaviyoClaimReplayStates,
} from "@/schema/klaviyo-claim";
import {
  klaviyoEventMatchResults,
  klaviyoOrderMatchResults,
} from "@/schema/klaviyo-match";

export const CLAIM_REPLAY_STALE_AFTER_MS = 20 * 60 * 1000;
const CLAIM_LEASE_ERROR = "CLAIM_LEASE_EXPIRED";
const CLAIM_RETRY_ERROR = "CLAIM_RETRIES_EXHAUSTED";
const CLAIM_HANDOFF_ERROR = "CLAIM_HANDOFF_FAILED";

export type StartClaimReplayResult =
  | { kind: "no_work"; matchRunId: string }
  | { kind: "pending"; claimReplayId: string }
  | { kind: "started"; claimReplayId: string }
  | { kind: "conflict" }
  | { kind: "stale"; reason: SafeMatchStaleReason | "no_event_anchor" };

function initialCheckpoint(input: {
  claimReplayId: string;
  sourceRunId: string;
  matchRunId: string;
  now: Date;
}): ClaimReplayCheckpoint {
  return {
    claimReplayId: input.claimReplayId,
    sourceRunId: input.sourceRunId,
    matchRunId: input.matchRunId,
    // Computed exactly once from the same instant that stamps startedAt and
    // persisted so every batch and resume shares one deterministic cutoff.
    lookbackCutoff: new Date(
      input.now.getTime() - CLAIM_REPLAY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
    phase: "missing",
    afterOccurredAt: null,
    afterEventRowId: null,
    remainingIncompleteRetries: MAX_INCOMPLETE_CLAIM_RETRIES_PER_GRAPH,
    remainingFailedRetries: MAX_FAILED_CLAIM_RETRIES_PER_GRAPH,
    attemptingConversionEventId: null,
    attemptingOccurredAt: null,
    stage: "idle",
  };
}

async function lockGraphRow(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  claimReplayId: string,
) {
  const [graph] = await tx
    .select({
      id: klaviyoClaimReplayRuns.id,
      status: klaviyoClaimReplayRuns.status,
      sourceRunId: klaviyoClaimReplayRuns.sourceRunId,
      matchRunId: klaviyoClaimReplayRuns.matchRunId,
      checkpoint: klaviyoClaimReplayRuns.checkpoint,
      heartbeatAt: klaviyoClaimReplayRuns.heartbeatAt,
      supersededSkipped: klaviyoClaimReplayRuns.supersededSkipped,
      currentTriggerRunId: klaviyoClaimReplayRuns.currentTriggerRunId,
    })
    .from(klaviyoClaimReplayRuns)
    .where(
      and(
        eq(klaviyoClaimReplayRuns.id, claimReplayId),
        eq(klaviyoClaimReplayRuns.organizationId, scope.organizationId),
        eq(klaviyoClaimReplayRuns.storeId, scope.storeId),
        eq(klaviyoClaimReplayRuns.connectionId, scope.connectionId),
      ),
    )
    .for("update");
  if (!graph) throw new Error("Klaviyo claim graph is outside this scope");
  return graph;
}

async function finishGraphLocked(
  tx: KlaviyoStoreTransaction,
  claimReplayId: string,
  status: "success" | "partial" | "failed" | "stale",
  failureCode: string | null,
): Promise<void> {
  const finished = await tx
    .update(klaviyoClaimReplayRuns)
    .set({ status, failureCode, finishedAt: new Date() })
    .where(
      and(
        eq(klaviyoClaimReplayRuns.id, claimReplayId),
        eq(klaviyoClaimReplayRuns.status, "running"),
      ),
    )
    .returning({ id: klaviyoClaimReplayRuns.id });
  if (finished.length !== 1) {
    throw new Error("Klaviyo claim graph finish raced");
  }
}

/**
 * Whether the bound run can still hand this graph anchors: it is published,
 * and at least one of its event match results is unsuperseded. Both halves
 * matter. The first covers a run that is missing or was never published; the
 * second is the precise signal that a newer publication replaced this run's
 * results — the run row itself keeps `status = 'published'` and only gains
 * `superseded_at` when recountMatchRunCurrentness happens to have run, so
 * status alone never notices, and the graph would walk an empty enumeration
 * (selectNextConversion filters `run_id = checkpoint.matchRunId`) and finish
 * "success" having done nothing.
 *
 * Deliberately NOT "a different run is now current": several published,
 * unsuperseded runs coexist normally (rolling sync windows give consecutive
 * passes different scope fingerprints), and an older run legitimately keeps
 * current results for events outside the newer window. Yanking an in-flight
 * graph off such a run would forfeit its post-cursor tail — conversions
 * confirmed only there become unreachable.
 */
async function boundRunYieldsAnchors(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  matchRunId: string,
): Promise<boolean> {
  const published = await verifyClaimPublication({
    scope,
    matchRunId,
    executor: tx,
  });
  if (!published) return false;
  const [anchors] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(klaviyoEventMatchResults)
    .where(
      and(
        eq(klaviyoEventMatchResults.runId, matchRunId),
        eq(klaviyoEventMatchResults.connectionId, scope.connectionId),
        isNull(klaviyoEventMatchResults.supersededAt),
      ),
    );
  return (anchors?.count ?? 0) > 0;
}

/**
 * Claims are immutable per-conversion facts keyed by conversion_event_id,
 * never by publication — so a graph whose run was replaced is not invalid,
 * merely pointed at yesterday's run. Rebind it to the current publication
 * and continue from the same cursor. Returns null when there is nothing
 * fresher to rebind onto, and the caller must stale.
 *
 * The cursor is deliberately preserved: an event the new publication
 * confirms behind the cursor is skipped by THIS graph but stays in scope
 * for the next one, because "no complete claim state" is always in scope
 * regardless of age. Resetting instead would re-walk from the start on
 * every publication and never finish.
 */
async function rebindGraphLocked(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  claimReplayId: string,
  current: ClaimReplayCheckpoint,
  reason: string,
  now: Date,
): Promise<ClaimReplayCheckpoint | null> {
  const target = await resolveCurrentPublishedMatchRun({ scope, executor: tx });
  if (target === null || target.id === current.matchRunId) return null;
  const rebound: ClaimReplayCheckpoint = {
    ...current,
    sourceRunId: target.sourceRunId,
    matchRunId: target.id,
  };
  await tx
    .update(klaviyoClaimReplayRuns)
    .set({
      sourceRunId: target.sourceRunId,
      matchRunId: target.id,
      checkpoint: rebound as unknown as Record<string, never>,
      heartbeatAt: now,
    })
    .where(eq(klaviyoClaimReplayRuns.id, claimReplayId));
  console.info("klaviyo claim replay rebound", {
    connectionId: scope.connectionId,
    claimReplayId,
    fromMatchRunId: current.matchRunId,
    toMatchRunId: target.id,
    reason,
  });
  return rebound;
}

/**
 * Store→connection-locked start: inspects the one-running graph before any
 * no-work return, fixed-code reconciles an expired graph, reuses a live
 * identical graph, proves full dual-source publication freshness, and only
 * then creates a database-owned claim replay ID. A fresh empty publication
 * returns typed no_work without provider work; a stale or fully replaced
 * nonempty match creates no graph.
 */
export async function startOrResumeClaimReplay(input: {
  scope: KlaviyoConnectionScope;
  sourceRunId: string;
  matchRunId: string;
  now: Date;
}): Promise<StartClaimReplayResult> {
  const now = new Date(input.now.getTime());
  if (Number.isNaN(now.getTime())) throw new Error("Invalid start time");
  const staleAt = new Date(now.getTime() - CLAIM_REPLAY_STALE_AFTER_MS);

  return withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
    const [running] = await tx
      .select({
        id: klaviyoClaimReplayRuns.id,
        sourceRunId: klaviyoClaimReplayRuns.sourceRunId,
        matchRunId: klaviyoClaimReplayRuns.matchRunId,
        heartbeatAt: klaviyoClaimReplayRuns.heartbeatAt,
      })
      .from(klaviyoClaimReplayRuns)
      .where(
        and(
          eq(klaviyoClaimReplayRuns.connectionId, input.scope.connectionId),
          eq(klaviyoClaimReplayRuns.status, "running"),
        ),
      )
      .for("update");
    if (running) {
      if (running.heartbeatAt.getTime() > staleAt.getTime()) {
        if (
          running.sourceRunId === input.sourceRunId &&
          running.matchRunId === input.matchRunId
        ) {
          return { kind: "pending" as const, claimReplayId: running.id };
        }
        return { kind: "conflict" as const };
      }
      await finishGraphLocked(tx, running.id, "failed", CLAIM_LEASE_ERROR);
    }

    const freshness = await verifyPublishedMatchFreshness({
      scope: input.scope,
      matchRunId: input.matchRunId,
      executor: tx,
    });
    if (!freshness.fresh) {
      return { kind: "stale" as const, reason: freshness.reason };
    }
    if (freshness.matchRun.sourceRunId !== input.sourceRunId) {
      return { kind: "stale" as const, reason: "fingerprint_mismatch" as const };
    }
    if (
      freshness.matchRun.expectedEventCount === 0 &&
      freshness.matchRun.expectedOrderCount === 0
    ) {
      return { kind: "no_work" as const, matchRunId: input.matchRunId };
    }
    // Integrity guard for the truly-zero-anchors case only. A publication
    // whose anchors all fall outside the replay scope (old and already
    // covered) still starts and lets the first batch conclude success with
    // zero conversions.
    const [anchors] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(klaviyoEventMatchResults)
      .where(
        and(
          eq(klaviyoEventMatchResults.runId, input.matchRunId),
          isNull(klaviyoEventMatchResults.supersededAt),
        ),
      );
    if ((anchors?.count ?? 0) === 0) {
      return { kind: "stale" as const, reason: "no_event_anchor" as const };
    }

    const claimReplayId = crypto.randomUUID();
    await tx.insert(klaviyoClaimReplayRuns).values({
      id: claimReplayId,
      organizationId: input.scope.organizationId,
      storeId: input.scope.storeId,
      connectionId: input.scope.connectionId,
      sourceRunId: input.sourceRunId,
      matchRunId: input.matchRunId,
      checkpoint: initialCheckpoint({
        claimReplayId,
        sourceRunId: input.sourceRunId,
        matchRunId: input.matchRunId,
        now,
      }) as unknown as Record<string, never>,
      status: "running",
      heartbeatAt: now,
      startedAt: now,
    });
    return { kind: "started" as const, claimReplayId };
  });
}

export async function renewClaimReplayHeartbeat(input: {
  scope: KlaviyoConnectionScope;
  claimReplayId: string;
  now: Date;
}): Promise<{ changed: boolean }> {
  const now = new Date(input.now.getTime());
  if (Number.isNaN(now.getTime())) throw new Error("Invalid heartbeat time");
  return db.transaction(async (tx) => {
    const graph = await lockGraphRow(tx, input.scope, input.claimReplayId);
    if (graph.status !== "running") {
      throw new Error("Klaviyo claim graph is not running");
    }
    await tx
      .update(klaviyoClaimReplayRuns)
      .set({ heartbeatAt: now })
      .where(eq(klaviyoClaimReplayRuns.id, input.claimReplayId));
    return { changed: true };
  });
}

/** Idempotent fixed-code lease fallback preserving checkpoint and claims. */
export async function failExpiredClaimReplayRun(input: {
  scope: KlaviyoConnectionScope;
  claimReplayId: string;
  now: Date;
}): Promise<{ changed: boolean }> {
  const now = new Date(input.now.getTime());
  const staleAt = new Date(now.getTime() - CLAIM_REPLAY_STALE_AFTER_MS);
  return withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
    const graph = await lockGraphRow(tx, input.scope, input.claimReplayId);
    if (graph.status !== "running") return { changed: false };
    if (graph.heartbeatAt.getTime() > staleAt.getTime()) {
      return { changed: false };
    }
    await finishGraphLocked(tx, input.claimReplayId, "failed", CLAIM_LEASE_ERROR);
    return { changed: true };
  });
}

type SelectedConversion = {
  eventRowId: string;
  externalEventId: string;
  occurredAt: Date;
  attributionRelationshipIds: string[];
  truncated: boolean;
  sourceChecksum: string;
};

async function loadConversion(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  eventRowId: string,
): Promise<SelectedConversion> {
  const [event] = await tx
    .select({
      id: klaviyoEvents.id,
      externalEventId: klaviyoEvents.externalEventId,
      occurredAt: klaviyoEvents.occurredAt,
      attributionRelationshipIds: klaviyoEvents.attributionRelationshipIds,
      warnings: klaviyoEvents.warnings,
      sourceChecksum: klaviyoEvents.sourceChecksum,
    })
    .from(klaviyoEvents)
    .where(
      and(
        eq(klaviyoEvents.connectionId, scope.connectionId),
        eq(klaviyoEvents.id, eventRowId),
      ),
    )
    .limit(1);
  if (!event) throw new Error("Klaviyo conversion event is outside this scope");
  return {
    eventRowId: event.id,
    externalEventId: event.externalEventId,
    occurredAt: event.occurredAt,
    attributionRelationshipIds: event.attributionRelationshipIds,
    truncated: event.warnings.includes("attribution_relationship_truncated"),
    sourceChecksum: event.sourceChecksum,
  };
}

async function selectNextConversion(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  checkpoint: ClaimReplayCheckpoint,
): Promise<SelectedConversion | null> {
  const cursorPredicate =
    checkpoint.afterOccurredAt === null || checkpoint.afterEventRowId === null
      ? sql`true`
      : sql`(${klaviyoEvents.occurredAt}, ${klaviyoEvents.id}) >
          (${checkpoint.afterOccurredAt}::timestamp, ${checkpoint.afterEventRowId})`;

  if (checkpoint.phase === "missing") {
    // An anchor is in scope when its conversion is recent (occurred on or
    // after the persisted lookback cutoff) or has never been successfully
    // covered: no complete replay state for it anywhere on this connection.
    // Old, already-covered conversions keep their existing claims untouched.
    const inScopePredicate = sql`(
      ${klaviyoEvents.occurredAt} >= ${checkpoint.lookbackCutoff}::timestamp
      or not exists (
        select 1
          from klaviyo_claim_replay_state covered
         where covered.connection_id = ${scope.connectionId}
           and covered.conversion_event_id = ${klaviyoEventMatchResults.eventId}
           and covered.status = 'complete'
      ))`;
    const [row] = await tx
      .select({ eventId: klaviyoEventMatchResults.eventId })
      .from(klaviyoEventMatchResults)
      .innerJoin(
        klaviyoEvents,
        and(
          eq(klaviyoEvents.connectionId, klaviyoEventMatchResults.connectionId),
          eq(klaviyoEvents.id, klaviyoEventMatchResults.eventId),
        ),
      )
      .leftJoin(
        klaviyoClaimReplayStates,
        and(
          eq(klaviyoClaimReplayStates.connectionId, scope.connectionId),
          eq(klaviyoClaimReplayStates.sourceRunId, checkpoint.sourceRunId),
          eq(klaviyoClaimReplayStates.matchRunId, checkpoint.matchRunId),
          eq(
            klaviyoClaimReplayStates.conversionEventId,
            klaviyoEventMatchResults.eventId,
          ),
        ),
      )
      .where(
        and(
          eq(klaviyoEventMatchResults.runId, checkpoint.matchRunId),
          eq(klaviyoEventMatchResults.connectionId, scope.connectionId),
          isNull(klaviyoEventMatchResults.supersededAt),
          cursorPredicate,
          inScopePredicate,
          sql`(${klaviyoClaimReplayStates.id} is null
            or ${klaviyoClaimReplayStates.sourceChecksum} <> ${klaviyoEvents.sourceChecksum})`,
        ),
      )
      .orderBy(asc(klaviyoEvents.occurredAt), asc(klaviyoEvents.id))
      .limit(1);
    return row ? loadConversion(tx, scope, row.eventId) : null;
  }

  const retryStatus =
    checkpoint.phase === "incomplete_retry" ? "incomplete" : "failed";
  const remaining =
    checkpoint.phase === "incomplete_retry"
      ? checkpoint.remainingIncompleteRetries
      : checkpoint.remainingFailedRetries;
  if (remaining <= 0) return null;
  const [row] = await tx
    .select({ eventId: klaviyoClaimReplayStates.conversionEventId })
    .from(klaviyoClaimReplayStates)
    .innerJoin(
      klaviyoEvents,
      and(
        eq(klaviyoEvents.connectionId, klaviyoClaimReplayStates.connectionId),
        eq(klaviyoEvents.id, klaviyoClaimReplayStates.conversionEventId),
      ),
    )
    .innerJoin(
      klaviyoEventMatchResults,
      and(
        eq(klaviyoEventMatchResults.runId, checkpoint.matchRunId),
        eq(
          klaviyoEventMatchResults.eventId,
          klaviyoClaimReplayStates.conversionEventId,
        ),
        isNull(klaviyoEventMatchResults.supersededAt),
      ),
    )
    .where(
      and(
        eq(klaviyoClaimReplayStates.connectionId, scope.connectionId),
        eq(klaviyoClaimReplayStates.sourceRunId, checkpoint.sourceRunId),
        eq(klaviyoClaimReplayStates.matchRunId, checkpoint.matchRunId),
        eq(klaviyoClaimReplayStates.status, retryStatus),
        eq(
          klaviyoClaimReplayStates.sourceChecksum,
          klaviyoEvents.sourceChecksum,
        ),
        sql`(${klaviyoClaimReplayStates.lastAttemptClaimReplayId} is null
          or ${klaviyoClaimReplayStates.lastAttemptClaimReplayId} <> ${checkpoint.claimReplayId})`,
        cursorPredicate,
      ),
    )
    .orderBy(asc(klaviyoEvents.occurredAt), asc(klaviyoEvents.id))
    .limit(1);
  return row ? loadConversion(tx, scope, row.eventId) : null;
}

/**
 * Known consequence of a mid-run rebind: this count, like both retry
 * phases, filters on the graph's CURRENT binding, so states written under
 * the binding it left are invisible here and the graph can report success
 * while incomplete or failed conversions from before the rebind remain.
 * Nothing is lost — a state that is not `complete` keeps its conversion in
 * scope for the next graph, which refetches it — so this stays a reporting
 * optimism, not a data gap, and is deliberately not widened: counting
 * across bindings would also count states from unrelated older runs.
 */
async function unresolvedStateCount(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  sourceRunId: string,
  matchRunId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(klaviyoClaimReplayStates)
    .where(
      and(
        eq(klaviyoClaimReplayStates.connectionId, scope.connectionId),
        eq(klaviyoClaimReplayStates.sourceRunId, sourceRunId),
        eq(klaviyoClaimReplayStates.matchRunId, matchRunId),
        sql`${klaviyoClaimReplayStates.status} in ('incomplete', 'failed')`,
      ),
    );
  return row?.count ?? 0;
}

export type ClaimClient = Pick<KlaviyoApiClient, "getEventById">;

export type ClaimBatchDependencies = {
  createClient?: (privateApiKey: string) => ClaimClient;
  credentialProvider?: KlaviyoCredentialProvider;
  now?: () => Date;
  nowMs?: () => number;
  verifyWriterReadiness?: (
    scope: KlaviyoConnectionScope,
  ) => Promise<{ ready: boolean }>;
};

export type ClaimBatchResult = {
  outcome:
    | "continue"
    | "done"
    | "stale"
    | "gate_blocked"
    | "budget_exhausted";
  processed: number;
  supersededSkipped: number;
  checkpoint: ClaimReplayCheckpoint | null;
};

async function defaultWriterReadiness(
  scope: KlaviyoConnectionScope,
): Promise<{ ready: boolean }> {
  const [{ verifyIdentityWriterReadiness }, identityHmac] = await Promise.all([
    import("@/lib/klaviyo/identity-rotation"),
    import("@/lib/identity-hmac"),
  ]);
  return verifyIdentityWriterReadiness({
    scope,
    keyring: identityHmac.parseIdentityHmacKeyring(),
    suppressionKey: identityHmac.parseErasureSuppressionKey(),
  });
}

async function metricKindByExternalId(
  scope: KlaviyoConnectionScope,
  externalMetricId: string | null,
): Promise<KlaviyoMetricKind | null> {
  if (externalMetricId === null) return null;
  const [metric] = await db
    .select({ canonicalKind: klaviyoMetrics.canonicalKind })
    .from(klaviyoMetrics)
    .where(
      and(
        eq(klaviyoMetrics.connectionId, scope.connectionId),
        eq(klaviyoMetrics.externalMetricId, externalMetricId),
      ),
    )
    .limit(1);
  return metric?.canonicalKind ?? null;
}

/**
 * Bounded claim replay batch. The only idle→fetching path is the locked
 * selection transaction (full publication proof + exact anchor + gate
 * check + atomic attempting write). Remote fetches happen without locks;
 * every referenced fetch preflights the same persisted attempting tuple,
 * and the final commit revalidates all three proofs before any claim,
 * state, count, or checkpoint write. Only a returned current confirmed
 * order result may receive `claimCount`; match status, method, confidence,
 * candidate edges, product status, and every Shopify field stay untouched.
 */
export async function processClaimBatch(
  input: { scope: KlaviyoConnectionScope; claimReplayId: string },
  dependencies: ClaimBatchDependencies = {},
): Promise<ClaimBatchResult> {
  const now = dependencies.now ?? (() => new Date());
  const nowMs = dependencies.nowMs ?? (() => Date.now());
  const verifyGate =
    dependencies.verifyWriterReadiness ?? defaultWriterReadiness;
  const startedAtMs = nowMs();
  let remoteCalls = 0;
  let processed = 0;
  let supersededSkipped = 0;

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
    ((privateApiKey: string): ClaimClient =>
      new KlaviyoApiClient({ privateApiKey }));
  const client = createClient(credential.privateApiKey);

  let checkpoint: ClaimReplayCheckpoint | null = null;

  for (
    let conversionIndex = 0;
    conversionIndex < MAX_CLAIM_CONVERSIONS_PER_BATCH;
    conversionIndex += 1
  ) {
    if (nowMs() - startedAtMs >= CLAIM_BATCH_SOFT_DEADLINE_MS) {
      return {
        outcome: "budget_exhausted",
        processed,
        supersededSkipped,
        checkpoint,
      };
    }
    if (remoteCalls + 1 > MAX_CLAIM_REMOTE_CALLS_PER_BATCH) {
      return {
        outcome: "budget_exhausted",
        processed,
        supersededSkipped,
        checkpoint,
      };
    }

    // Selection transaction: the only idle→fetching path.
    const selection = await withKlaviyoStoreConnectionLock(
      input.scope,
      async (tx) => {
        const graph = await lockGraphRow(tx, input.scope, input.claimReplayId);
        if (graph.status !== "running") {
          throw new Error("Klaviyo claim graph is not running");
        }
        assertExactClaimReplayCheckpoint(graph.checkpoint);
        let current = graph.checkpoint;
        // A bound run that can no longer yield anchors is not a dead graph,
        // only one pointed at yesterday's run: move it to the current
        // publication, keeping the cursor, and stale only when there is
        // nothing to move onto.
        if (
          !(await boundRunYieldsAnchors(tx, input.scope, current.matchRunId))
        ) {
          const rebound = await rebindGraphLocked(
            tx,
            input.scope,
            input.claimReplayId,
            current,
            "bound_run_yields_no_anchors",
            now(),
          );
          if (rebound === null) {
            await finishGraphLocked(tx, input.claimReplayId, "stale", null);
            return { kind: "stale" as const };
          }
          current = rebound;
        }

        if (current.stage === "handoff") {
          current = { ...current, stage: "idle" };
        }
        if (current.stage === "fetching") {
          if (current.attemptingConversionEventId === null) {
            throw new Error("Klaviyo claim attempt tuple is missing");
          }
          const conversion = await loadConversion(
            tx,
            input.scope,
            current.attemptingConversionEventId,
          );
          return { kind: "selected" as const, conversion, checkpoint: current };
        }

        // idle: select the next conversion, advancing phases as needed.
        let conversion = await selectNextConversion(tx, input.scope, current);
        while (conversion === null) {
          if (current.phase === "missing") {
            current = {
              ...current,
              phase: "incomplete_retry",
              afterOccurredAt: null,
              afterEventRowId: null,
            };
          } else if (current.phase === "incomplete_retry") {
            current = {
              ...current,
              phase: "failed_retry",
              afterOccurredAt: null,
              afterEventRowId: null,
            };
          } else {
            const unresolved = await unresolvedStateCount(
              tx,
              input.scope,
              current.sourceRunId,
              current.matchRunId,
            );
            await finishGraphLocked(
              tx,
              input.claimReplayId,
              unresolved > 0 ? "partial" : "success",
              null,
            );
            return { kind: "terminal" as const };
          }
          conversion = await selectNextConversion(tx, input.scope, current);
        }

        let anchor = await verifyCurrentClaimAnchor({
          scope: input.scope,
          matchRunId: current.matchRunId,
          conversionEventRowId: conversion.eventRowId,
          executor: tx,
        });
        if (!anchor.fresh) {
          // A replaced publication re-confirms the same events; rebind and
          // re-ask before concluding this conversion is gone. Defence in
          // depth rather than a live path: selectNextConversion already
          // filters superseded results, and publishing takes the same
          // store→connection locks this transaction holds, so an anchor
          // cannot be superseded between enumeration and this check. The
          // reachable equivalents are the preflight and commit arms below,
          // which run in later transactions.
          const rebound = await rebindGraphLocked(
            tx,
            input.scope,
            input.claimReplayId,
            current,
            anchor.reason,
            now(),
          );
          if (rebound !== null) {
            current = rebound;
            anchor = await verifyCurrentClaimAnchor({
              scope: input.scope,
              matchRunId: current.matchRunId,
              conversionEventRowId: conversion.eventRowId,
              executor: tx,
            });
          }
        }
        if (!anchor.fresh) {
          if (anchor.reason === "publication_stale") {
            await finishGraphLocked(tx, input.claimReplayId, "stale", null);
            return { kind: "stale" as const };
          }
          const skipped: ClaimReplayCheckpoint = {
            ...current,
            afterOccurredAt: conversion.occurredAt.toISOString(),
            afterEventRowId: conversion.eventRowId,
          };
          await tx
            .update(klaviyoClaimReplayRuns)
            .set({
              checkpoint: skipped as unknown as Record<string, never>,
              supersededSkipped: sql`${klaviyoClaimReplayRuns.supersededSkipped} + 1`,
              heartbeatAt: now(),
            })
            .where(eq(klaviyoClaimReplayRuns.id, input.claimReplayId));
          return { kind: "superseded_skip" as const, checkpoint: skipped };
        }

        const gate = await verifyGate(input.scope);
        if (!gate.ready) {
          return { kind: "gate_blocked" as const };
        }

        const attempting: ClaimReplayCheckpoint = {
          ...current,
          attemptingConversionEventId: conversion.eventRowId,
          attemptingOccurredAt: conversion.occurredAt.toISOString(),
          stage: "fetching",
        };
        await tx
          .update(klaviyoClaimReplayRuns)
          .set({
            checkpoint: attempting as unknown as Record<string, never>,
            heartbeatAt: now(),
          })
          .where(eq(klaviyoClaimReplayRuns.id, input.claimReplayId));
        return { kind: "selected" as const, conversion, checkpoint: attempting };
      },
    );

    if (selection.kind === "stale") {
      return { outcome: "stale", processed, supersededSkipped, checkpoint };
    }
    if (selection.kind === "terminal") {
      return { outcome: "done", processed, supersededSkipped, checkpoint: null };
    }
    if (selection.kind === "gate_blocked") {
      return {
        outcome: "gate_blocked",
        processed,
        supersededSkipped,
        checkpoint,
      };
    }
    if (selection.kind === "superseded_skip") {
      supersededSkipped += 1;
      checkpoint = selection.checkpoint;
      continue;
    }

    const { conversion } = selection;
    checkpoint = selection.checkpoint;

    // Primary conversion fetch without database locks.
    remoteCalls += 1;
    const primary = await client.getEventById({
      externalEventId: conversion.externalEventId,
      request: {
        purpose: "attribution_claim",
        include: ["metric", "attributions"],
      },
    });
    if (primary.purpose !== "attribution_claim") {
      throw new Error("Klaviyo claim fetch returned the wrong purpose");
    }
    const normalization = normalizeAttributionClaims({
      conversionEventRowId: conversion.eventRowId,
      conversionExternalEventId: conversion.externalEventId,
      storedAttributionRelationshipIds: conversion.attributionRelationshipIds,
      storedTruncated: conversion.truncated,
      fetchedEventExternalId: primary.event.id,
      attributions: primary.attributions,
      apiRevision: "2026-07-15",
    });

    // Referenced interaction resolution with per-fetch preflight.
    const interactionByClaim = new Map<string, RedactedInteractionDetail>();
    const referencedReasons: string[] = [];
    let referencedFetches = 0;
    for (const claim of normalization.claims) {
      if (claim.attributedInteractionEventId === null) continue;
      if (referencedFetches >= MAX_REFERENCED_EVENT_FETCHES_PER_CONVERSION) {
        claim.unknownReasonCodes.push("referenced_event_fetch_cap");
        continue;
      }
      if (remoteCalls + 1 > MAX_CLAIM_REMOTE_CALLS_PER_BATCH) {
        claim.unknownReasonCodes.push("task_remote_call_cap");
        continue;
      }
      if (nowMs() - startedAtMs >= CLAIM_BATCH_SOFT_DEADLINE_MS) {
        claim.unknownReasonCodes.push("task_soft_deadline");
        continue;
      }

      const preflight = await withKlaviyoStoreConnectionLock(
        input.scope,
        async (tx) => {
          const graph = await lockGraphRow(
            tx,
            input.scope,
            input.claimReplayId,
          );
          if (graph.status !== "running") return { ok: false as const };
          assertExactClaimReplayCheckpoint(graph.checkpoint);
          if (
            graph.checkpoint.stage !== "fetching" ||
            graph.checkpoint.attemptingConversionEventId !==
              conversion.eventRowId
          ) {
            return { ok: false as const };
          }
          // Non-terminal by design: a stop only ends this conversion's
          // referenced fetches. It still rebinds, because otherwise a
          // publication that lands mid-fetch strips every interaction
          // detail and hands the commit an anchor it would skip on,
          // discarding work the new publication still confirms.
          let bound = graph.checkpoint;
          if (
            !(await verifyClaimPublication({
              scope: input.scope,
              matchRunId: bound.matchRunId,
              executor: tx,
            }))
          ) {
            const rebound = await rebindGraphLocked(
              tx,
              input.scope,
              input.claimReplayId,
              bound,
              "publication_not_published",
              now(),
            );
            if (rebound === null) return { ok: false as const };
            bound = rebound;
          }
          let anchor = await verifyCurrentClaimAnchor({
            scope: input.scope,
            matchRunId: bound.matchRunId,
            conversionEventRowId: conversion.eventRowId,
            executor: tx,
          });
          if (!anchor.fresh) {
            const rebound = await rebindGraphLocked(
              tx,
              input.scope,
              input.claimReplayId,
              bound,
              anchor.reason,
              now(),
            );
            if (rebound === null) return { ok: false as const };
            bound = rebound;
            anchor = await verifyCurrentClaimAnchor({
              scope: input.scope,
              matchRunId: bound.matchRunId,
              conversionEventRowId: conversion.eventRowId,
              executor: tx,
            });
          }
          if (!anchor.fresh) return { ok: false as const };
          const gate = await verifyGate(input.scope);
          return { ok: gate.ready };
        },
      );
      if (!preflight.ok) {
        // Erasure, supersession, or gate drift stops the next request and
        // discards partial response state; the commit recheck decides fate.
        referencedReasons.push("referenced_fetch_preflight_stopped");
        break;
      }

      remoteCalls += 1;
      referencedFetches += 1;
      try {
        const referenced = await client.getEventById({
          externalEventId: claim.attributedInteractionEventId,
          request: { purpose: "referenced_interaction", include: ["metric"] },
        });
        if (referenced.purpose !== "referenced_interaction") continue;
        const attributes = referenced.event.attributes ?? {};
        const properties =
          attributes.event_properties &&
          typeof attributes.event_properties === "object"
            ? (attributes.event_properties as Record<string, unknown>)
            : {};
        const metricKind = await metricKindByExternalId(
          input.scope,
          referenced.metric?.id ?? null,
        );
        const occurredAtRaw = attributes.datetime;
        const { detail, reasonCodes } = normalizeReferencedInteraction({
          externalEventId: referenced.event.id,
          metricKind,
          occurredAt:
            typeof occurredAtRaw === "string" &&
            !Number.isNaN(Date.parse(occurredAtRaw))
              ? new Date(occurredAtRaw)
              : null,
          channel: null,
          url: properties.URL ?? properties.url ?? null,
          botClick: null,
        });
        claim.unknownReasonCodes.push(...reasonCodes);
        if (detail !== null) {
          interactionByClaim.set(claim.attributionId, detail);
        }
      } catch {
        claim.unknownReasonCodes.push("referenced_event_unavailable");
      }
    }

    // Per-conversion commit: revalidate all proofs, then write atomically.
    const commit = await withKlaviyoStoreConnectionLock(
      input.scope,
      async (tx) => {
        const graph = await lockGraphRow(tx, input.scope, input.claimReplayId);
        if (graph.status !== "running") {
          throw new Error("Klaviyo claim graph is not running");
        }
        assertExactClaimReplayCheckpoint(graph.checkpoint);
        let current = graph.checkpoint;
        if (
          current.stage !== "fetching" ||
          current.attemptingConversionEventId !== conversion.eventRowId
        ) {
          throw new Error("Klaviyo claim attempt tuple moved");
        }
        if (
          !(await verifyClaimPublication({
            scope: input.scope,
            matchRunId: current.matchRunId,
            executor: tx,
          }))
        ) {
          const rebound = await rebindGraphLocked(
            tx,
            input.scope,
            input.claimReplayId,
            current,
            "publication_not_published",
            now(),
          );
          if (rebound === null) {
            await finishGraphLocked(tx, input.claimReplayId, "stale", null);
            return { kind: "stale" as const };
          }
          current = rebound;
        }
        let anchor = await verifyCurrentClaimAnchor({
          scope: input.scope,
          matchRunId: current.matchRunId,
          conversionEventRowId: conversion.eventRowId,
          executor: tx,
        });
        if (!anchor.fresh) {
          // A publication that landed while this conversion was being
          // fetched supersedes the old run's event result; rebind and
          // re-ask, or the claims just fetched are discarded even though
          // the current publication still confirms the conversion.
          const rebound = await rebindGraphLocked(
            tx,
            input.scope,
            input.claimReplayId,
            current,
            anchor.reason,
            now(),
          );
          if (rebound !== null) {
            current = rebound;
            anchor = await verifyCurrentClaimAnchor({
              scope: input.scope,
              matchRunId: current.matchRunId,
              conversionEventRowId: conversion.eventRowId,
              executor: tx,
            });
          }
        }
        if (!anchor.fresh) {
          const skipped: ClaimReplayCheckpoint = {
            ...current,
            afterOccurredAt: conversion.occurredAt.toISOString(),
            afterEventRowId: conversion.eventRowId,
            attemptingConversionEventId: null,
            attemptingOccurredAt: null,
            stage: "idle",
          };
          await tx
            .update(klaviyoClaimReplayRuns)
            .set({
              checkpoint: skipped as unknown as Record<string, never>,
              supersededSkipped: sql`${klaviyoClaimReplayRuns.supersededSkipped} + 1`,
              heartbeatAt: now(),
            })
            .where(eq(klaviyoClaimReplayRuns.id, input.claimReplayId));
          return { kind: "superseded_skip" as const, checkpoint: skipped };
        }
        const gate = await verifyGate(input.scope);
        if (!gate.ready) {
          return { kind: "gate_blocked" as const };
        }

        const complete = normalization.complete;
        if (complete) {
          await tx
            .delete(klaviyoAttributionClaims)
            .where(
              and(
                eq(
                  klaviyoAttributionClaims.connectionId,
                  input.scope.connectionId,
                ),
                eq(
                  klaviyoAttributionClaims.conversionEventId,
                  conversion.eventRowId,
                ),
              ),
            );
          for (const claim of normalization.claims) {
            const detail = interactionByClaim.get(claim.attributionId) ?? null;
            const interactionRow = await resolveInteractionRow(
              tx,
              input.scope,
              claim,
            );
            await tx.insert(klaviyoAttributionClaims).values({
              organizationId: input.scope.organizationId,
              storeId: input.scope.storeId,
              connectionId: input.scope.connectionId,
              conversionEventId: conversion.eventRowId,
              klaviyoAttributionId: claim.attributionId,
              attributedInteractionEventId: interactionRow,
              attributedInteractionExternalEventId:
                claim.attributedInteractionEventId,
              campaignObjectId: await resolveMarketingRow(
                tx,
                input.scope,
                "campaign",
                claim.marketingRelationships.campaignId,
              ),
              flowObjectId: await resolveMarketingRow(
                tx,
                input.scope,
                "flow",
                claim.marketingRelationships.flowId,
              ),
              messageObjectId: await resolveMessageRow(
                tx,
                input.scope,
                claim.marketingRelationships.messageId,
              ),
              variationObjectId: null,
              externalVariationReference:
                claim.marketingRelationships.externalVariationReference,
              interactionType: detail?.interactionType ?? null,
              interactionOccurredAt: detail?.occurredAt ?? null,
              interactionChannel: detail?.channel ?? null,
              interactionHost: detail?.host ?? null,
              interactionPath: detail?.path ?? null,
              botClick:
                detail?.botClick === null || detail === null
                  ? null
                  : detail.botClick
                    ? 1
                    : 0,
              unknownReasonCodes: [
                ...new Set([...claim.unknownReasonCodes, ...referencedReasons]),
              ],
              sourceChecksum: claim.sourceChecksum,
              apiRevision: claim.apiRevision,
              fetchedAt: now(),
            });
          }
          if (anchor.canonicalOrderResultId !== null) {
            await tx
              .update(klaviyoOrderMatchResults)
              .set({ claimCount: normalization.claims.length })
              .where(
                and(
                  eq(
                    klaviyoOrderMatchResults.id,
                    anchor.canonicalOrderResultId,
                  ),
                  isNull(klaviyoOrderMatchResults.supersededAt),
                ),
              );
          }
        }

        await upsertReplayState(tx, {
          scope: input.scope,
          sourceRunId: current.sourceRunId,
          matchRunId: current.matchRunId,
          conversionEventId: conversion.eventRowId,
          sourceChecksum: conversion.sourceChecksum,
          status: complete ? "complete" : "incomplete",
          expectedClaimCount: conversion.attributionRelationshipIds.length,
          resolvedClaimCount: complete ? normalization.claims.length : 0,
          referencedEventFetchCount: referencedFetches,
          reasonCodes: normalization.incompleteReasonCodes,
          claimReplayId: input.claimReplayId,
          now: now(),
        });

        const advanced: ClaimReplayCheckpoint = {
          ...current,
          afterOccurredAt: conversion.occurredAt.toISOString(),
          afterEventRowId: conversion.eventRowId,
          remainingIncompleteRetries:
            current.phase === "incomplete_retry"
              ? current.remainingIncompleteRetries - 1
              : current.remainingIncompleteRetries,
          remainingFailedRetries:
            current.phase === "failed_retry"
              ? current.remainingFailedRetries - 1
              : current.remainingFailedRetries,
          attemptingConversionEventId: null,
          attemptingOccurredAt: null,
          stage: "idle",
        };
        await tx
          .update(klaviyoClaimReplayRuns)
          .set({
            checkpoint: advanced as unknown as Record<string, never>,
            conversionsComplete: complete
              ? sql`${klaviyoClaimReplayRuns.conversionsComplete} + 1`
              : klaviyoClaimReplayRuns.conversionsComplete,
            conversionsIncomplete: complete
              ? klaviyoClaimReplayRuns.conversionsIncomplete
              : sql`${klaviyoClaimReplayRuns.conversionsIncomplete} + 1`,
            heartbeatAt: now(),
          })
          .where(eq(klaviyoClaimReplayRuns.id, input.claimReplayId));
        return { kind: "committed" as const, checkpoint: advanced };
      },
    );

    if (commit.kind === "stale") {
      return { outcome: "stale", processed, supersededSkipped, checkpoint };
    }
    if (commit.kind === "gate_blocked") {
      return {
        outcome: "gate_blocked",
        processed,
        supersededSkipped,
        checkpoint,
      };
    }
    if (commit.kind === "superseded_skip") {
      supersededSkipped += 1;
      checkpoint = commit.checkpoint;
      continue;
    }
    processed += 1;
    checkpoint = commit.checkpoint;
  }

  return { outcome: "continue", processed, supersededSkipped, checkpoint };
}

async function resolveMarketingRow(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  objectType: "campaign" | "flow",
  externalId: string | null,
): Promise<string | null> {
  if (externalId === null) return null;
  const { klaviyoMarketingObjects } = await import("@/schema/klaviyo-claim");
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

async function resolveMessageRow(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  externalId: string | null,
): Promise<string | null> {
  if (externalId === null) return null;
  const { klaviyoMarketingObjects } = await import("@/schema/klaviyo-claim");
  const [row] = await tx
    .select({ id: klaviyoMarketingObjects.id })
    .from(klaviyoMarketingObjects)
    .where(
      and(
        eq(klaviyoMarketingObjects.connectionId, scope.connectionId),
        sql`${klaviyoMarketingObjects.objectType} in ('campaign_message', 'flow_message')`,
        eq(klaviyoMarketingObjects.externalId, externalId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function resolveInteractionRow(
  tx: KlaviyoStoreTransaction,
  scope: KlaviyoConnectionScope,
  claim: NormalizedAttributionClaim,
): Promise<string | null> {
  if (claim.attributedInteractionEventId === null) return null;
  // Claims never insert or update klaviyo_event; the optional foreign key
  // resolves only when the source event already exists in this connection.
  const [row] = await tx
    .select({ id: klaviyoEvents.id })
    .from(klaviyoEvents)
    .where(
      and(
        eq(klaviyoEvents.connectionId, scope.connectionId),
        eq(klaviyoEvents.externalEventId, claim.attributedInteractionEventId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function upsertReplayState(
  tx: KlaviyoStoreTransaction,
  input: {
    scope: KlaviyoConnectionScope;
    sourceRunId: string;
    matchRunId: string;
    conversionEventId: string;
    sourceChecksum: string;
    status: "complete" | "incomplete" | "failed";
    expectedClaimCount: number;
    resolvedClaimCount: number;
    referencedEventFetchCount: number;
    reasonCodes: string[];
    claimReplayId: string;
    now: Date;
  },
): Promise<void> {
  const [existing] = await tx
    .select({ id: klaviyoClaimReplayStates.id })
    .from(klaviyoClaimReplayStates)
    .where(
      and(
        eq(klaviyoClaimReplayStates.connectionId, input.scope.connectionId),
        eq(klaviyoClaimReplayStates.sourceRunId, input.sourceRunId),
        eq(klaviyoClaimReplayStates.matchRunId, input.matchRunId),
        eq(
          klaviyoClaimReplayStates.conversionEventId,
          input.conversionEventId,
        ),
      ),
    )
    .for("update");
  if (existing) {
    await tx
      .update(klaviyoClaimReplayStates)
      .set({
        sourceChecksum: input.sourceChecksum,
        status: input.status,
        expectedClaimCount: input.expectedClaimCount,
        resolvedClaimCount: input.resolvedClaimCount,
        referencedEventFetchCount: input.referencedEventFetchCount,
        reasonCodes: input.reasonCodes,
        lastAttemptClaimReplayId: input.claimReplayId,
        attemptCount: sql`${klaviyoClaimReplayStates.attemptCount} + 1`,
        attemptedAt: input.now,
        completedAt: input.status === "complete" ? input.now : null,
        updatedAt: input.now,
      })
      .where(eq(klaviyoClaimReplayStates.id, existing.id));
    return;
  }
  await tx.insert(klaviyoClaimReplayStates).values({
    organizationId: input.scope.organizationId,
    storeId: input.scope.storeId,
    connectionId: input.scope.connectionId,
    sourceRunId: input.sourceRunId,
    matchRunId: input.matchRunId,
    conversionEventId: input.conversionEventId,
    sourceChecksum: input.sourceChecksum,
    status: input.status,
    expectedClaimCount: input.expectedClaimCount,
    resolvedClaimCount: input.resolvedClaimCount,
    referencedEventFetchCount: input.referencedEventFetchCount,
    reasonCodes: input.reasonCodes,
    lastAttemptClaimReplayId: input.claimReplayId,
    attemptCount: 1,
    attemptedAt: input.now,
    completedAt: input.status === "complete" ? input.now : null,
  });
}

export async function resolveClaimReplayScope(claimReplayId: string): Promise<{
  scope: KlaviyoConnectionScope;
  sourceRunId: string;
  matchRunId: string;
}> {
  const [graph] = await db
    .select({
      organizationId: klaviyoClaimReplayRuns.organizationId,
      storeId: klaviyoClaimReplayRuns.storeId,
      connectionId: klaviyoClaimReplayRuns.connectionId,
      sourceRunId: klaviyoClaimReplayRuns.sourceRunId,
      matchRunId: klaviyoClaimReplayRuns.matchRunId,
    })
    .from(klaviyoClaimReplayRuns)
    .where(eq(klaviyoClaimReplayRuns.id, claimReplayId))
    .limit(1);
  if (!graph) throw new Error("Klaviyo claim graph does not exist");
  return {
    scope: {
      organizationId: graph.organizationId,
      storeId: graph.storeId,
      connectionId: graph.connectionId,
    },
    sourceRunId: graph.sourceRunId,
    matchRunId: graph.matchRunId,
  };
}

export type RecoverClaimBatchResult =
  | { kind: "recovered"; checkpoint: ClaimReplayCheckpoint }
  | { kind: "superseded_skip"; checkpoint: ClaimReplayCheckpoint }
  | { kind: "handoff_recovered" }
  | { kind: "stale" }
  | { kind: "no_attempt" };

/**
 * Terminal-retry recovery. Marks only the exact persisted attempting
 * conversion failed — never a scanned-forward neighbor — preserves its
 * prior claims and claimCount, and finalizes the graph with a fixed code.
 * Idempotent: a non-running graph returns no_attempt without writes.
 */
export async function recoverExhaustedClaimBatch(input: {
  scope: KlaviyoConnectionScope;
  claimReplayId: string;
  now: Date;
}): Promise<RecoverClaimBatchResult> {
  return withKlaviyoStoreConnectionLock(input.scope, async (tx) => {
    const graph = await lockGraphRow(tx, input.scope, input.claimReplayId);
    if (graph.status !== "running") return { kind: "no_attempt" as const };
    assertExactClaimReplayCheckpoint(graph.checkpoint);
    const current = graph.checkpoint;

    // Terminal by design: retries are already exhausted, so this path never
    // rebinds — it only records the exact attempt's fate and finalizes.
    if (
      !(await verifyClaimPublication({
        scope: input.scope,
        matchRunId: current.matchRunId,
        executor: tx,
      }))
    ) {
      await finishGraphLocked(tx, input.claimReplayId, "stale", null);
      return { kind: "stale" as const };
    }

    if (current.stage === "handoff") {
      await finishGraphLocked(
        tx,
        input.claimReplayId,
        "failed",
        CLAIM_HANDOFF_ERROR,
      );
      return { kind: "no_attempt" as const };
    }

    if (
      current.stage === "fetching" &&
      current.attemptingConversionEventId !== null
    ) {
      const conversion = await loadConversion(
        tx,
        input.scope,
        current.attemptingConversionEventId,
      );
      const anchor = await verifyCurrentClaimAnchor({
        scope: input.scope,
        matchRunId: current.matchRunId,
        conversionEventRowId: conversion.eventRowId,
        executor: tx,
      });
      if (!anchor.fresh) {
        const skipped: ClaimReplayCheckpoint = {
          ...current,
          afterOccurredAt: conversion.occurredAt.toISOString(),
          afterEventRowId: conversion.eventRowId,
          attemptingConversionEventId: null,
          attemptingOccurredAt: null,
          stage: "idle",
        };
        const [remaining] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(klaviyoEventMatchResults)
          .where(
            and(
              eq(klaviyoEventMatchResults.runId, current.matchRunId),
              isNull(klaviyoEventMatchResults.supersededAt),
            ),
          );
        await tx
          .update(klaviyoClaimReplayRuns)
          .set({
            checkpoint: skipped as unknown as Record<string, never>,
            supersededSkipped: sql`${klaviyoClaimReplayRuns.supersededSkipped} + 1`,
            heartbeatAt: input.now,
          })
          .where(eq(klaviyoClaimReplayRuns.id, input.claimReplayId));
        if ((remaining?.count ?? 0) === 0) {
          await finishGraphLocked(tx, input.claimReplayId, "stale", null);
          return { kind: "stale" as const };
        }
        return { kind: "superseded_skip" as const, checkpoint: skipped };
      }

      await upsertReplayState(tx, {
        scope: input.scope,
        sourceRunId: current.sourceRunId,
        matchRunId: current.matchRunId,
        conversionEventId: conversion.eventRowId,
        sourceChecksum: conversion.sourceChecksum,
        status: "failed",
        expectedClaimCount: conversion.attributionRelationshipIds.length,
        resolvedClaimCount: 0,
        referencedEventFetchCount: 0,
        reasonCodes: [CLAIM_RETRY_ERROR],
        claimReplayId: input.claimReplayId,
        now: input.now,
      });
      const advanced: ClaimReplayCheckpoint = {
        ...current,
        afterOccurredAt: conversion.occurredAt.toISOString(),
        afterEventRowId: conversion.eventRowId,
        attemptingConversionEventId: null,
        attemptingOccurredAt: null,
        stage: "idle",
      };
      await tx
        .update(klaviyoClaimReplayRuns)
        .set({
          checkpoint: advanced as unknown as Record<string, never>,
          conversionsFailed: sql`${klaviyoClaimReplayRuns.conversionsFailed} + 1`,
        })
        .where(eq(klaviyoClaimReplayRuns.id, input.claimReplayId));
      await finishGraphLocked(
        tx,
        input.claimReplayId,
        "failed",
        CLAIM_RETRY_ERROR,
      );
      return { kind: "recovered" as const, checkpoint: advanced };
    }

    // Idle with no attempt: only the graph fails; no conversion is labeled.
    await finishGraphLocked(
      tx,
      input.claimReplayId,
      "failed",
      CLAIM_RETRY_ERROR,
    );
    return { kind: "no_attempt" as const };
  });
}
