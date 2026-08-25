import {
  idempotencyKeys,
  metadata,
  runs,
  schedules,
  tags,
  task,
  tasks,
  wait,
} from "@trigger.dev/sdk";
import {
  inclusiveStoreDaysToHalfOpenUtc,
  type HalfOpenWindow,
  type KlaviyoConnectionScope,
} from "@/lib/klaviyo/types";
import {
  recoverExhaustedClaimBatch,
  startOrResumeClaimReplay,
} from "@/lib/klaviyo/claim-repository";
import {
  listEligibleConnections,
  runIncrementalConnection,
  type IncrementalChildren,
  type ShopifyEvidenceOutcome,
} from "@/lib/klaviyo/incremental-sync";
import { triggerOrRepairMatchInvocation } from "@/lib/klaviyo/match-invocation";
import {
  isEvidenceRunAcceptableForMatching,
  selectLatestMatchInputs,
} from "@/lib/klaviyo/match-service";
import { startOrResumeReportSync } from "@/lib/klaviyo/report-repository";
import { startOrResumeDimensionSync } from "@/lib/klaviyo/dimension-repository";
import {
  startOrResumeConsentSync,
  startOrResumeJourneySync,
  startOrResumeOrderCoreSync,
} from "@/lib/klaviyo/source-runner";
import { getConnectionRecord } from "@/lib/klaviyo/source-store";
import { deriveDayInTimezone } from "@/lib/shopify-ingest";
import { db } from "@/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { klaviyoSyncRuns } from "@/schema/klaviyo";
import { klaviyoClaimReplayRuns } from "@/schema/klaviyo-claim";
import { klaviyoMatchRuns } from "@/schema/klaviyo-match";
import { shopifyEvidenceSyncRuns } from "@/schema/shopify-evidence";
import { ATTRIBUTION_TASK_RETRY } from "./retry";

const SUPERVISOR_QUEUE = {
  name: "klaviyo-incremental-supervisor",
  concurrencyLimit: 1,
};
const POLL_INTERVAL_SECONDS = 20;
const POLL_DEADLINE_MS = 8 * 60 * 1000;
// Real evidence passes re-observe the full trailing window and routinely
// run ~25-40 minutes on live stores. Durable waits freeze the run between
// polls, so a long deadline costs wall clock only, never compute.
const EVIDENCE_POLL_DEADLINE_MS = 60 * 60 * 1000;
// Same durable-wait doctrine: freezing between polls costs wall clock
// only, never compute. 30 minutes covers the documented worst case for a
// journey chain (6 pages x 300s) exactly, so consent waits out a live
// journey run instead of losing the night to a still-tight deadline.
const CONSENT_WAIT_DEADLINE_MS = 30 * 60 * 1000;

type SupervisorPayload = { organizationId?: string };

async function flushStage(stage: string, extra: Record<string, unknown> = {}) {
  metadata.set("supervisor", { stage, ...extra });
  await metadata.flush();
}

async function pollDatabase<T>(
  read: () => Promise<T | null>,
  deadlineMs: number = POLL_DEADLINE_MS,
): Promise<T | null> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await wait.for({ seconds: POLL_INTERVAL_SECONDS });
  }
}

// The DB enforces exactly one running `operation: "events"` sync run per
// connection (klaviyo_sync_run_one_running_events_uidx). Journey and
// consent are both timeline modes over that same slot, so a scheduled
// consent start must wait for a still-running journey run to vacate it
// instead of racing the guard in startOrResumeConsentSync.
async function hasRunningEventsRun(
  scope: KlaviyoConnectionScope,
): Promise<boolean> {
  const [run] = await db
    .select({ id: klaviyoSyncRuns.id })
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
    .limit(1);
  return run !== undefined;
}

// Scope-qualified terminal-status read for one events sync run: the consent
// stage reports run completion (not dispatch), so the supervisor polls the
// durable run row it started until it leaves "running".
async function getEventsRunStatus(
  scope: KlaviyoConnectionScope,
  syncRunId: string,
): Promise<string | null> {
  const [run] = await db
    .select({ status: klaviyoSyncRuns.status })
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
  return run?.status ?? null;
}

function trailingWeekWindow(storeTimezone: string): HalfOpenWindow {
  const today = new Date();
  return inclusiveStoreDaysToHalfOpenUtc({
    dateFrom: new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    dateTo: today.toISOString().slice(0, 10),
    timeZone: storeTimezone,
  });
}

// One evidence handoff under one explicit idempotency key: trigger the
// mode-only start child, then poll the durable evidence run row to a
// terminal status.
async function runEvidenceAttempt(key: string): Promise<ShopifyEvidenceOutcome> {
  const idempotencyKey = await idempotencyKeys.create(key, { scope: "global" });
  // Mode-only payload: the evidence task is bound to the environment
  // store and rejects any extra keys by exact shape.
  const result = await tasks.triggerAndWait(
    "shopify-evidence-start",
    { mode: "incremental_7d" },
    { idempotencyKey, idempotencyKeyTTL: "7d" },
  );
  metadata.set("shopifyTriggerRunId", result.id);
  await metadata.flush();
  if (!result.ok) {
    return {
      ok: false,
      evidenceRunId: null,
      status: "failed" as const,
      lineCompleteness: "unavailable" as const,
    };
  }
  const output = result.output as { evidenceRunId?: string };
  const evidenceRunId = output?.evidenceRunId ?? null;
  if (evidenceRunId === null) {
    return {
      ok: false,
      evidenceRunId: null,
      status: "failed" as const,
      lineCompleteness: "unavailable" as const,
    };
  }
  await flushStage("shopify_evidence_wait", { evidenceRunId });
  const terminal = await pollDatabase(async () => {
    const [run] = await db
      .select({
        status: shopifyEvidenceSyncRuns.status,
        lineCompleteness: shopifyEvidenceSyncRuns.lineCompleteness,
      })
      .from(shopifyEvidenceSyncRuns)
      .where(eq(shopifyEvidenceSyncRuns.id, evidenceRunId))
      .limit(1);
    if (!run || run.status === "running") return null;
    return run;
  }, EVIDENCE_POLL_DEADLINE_MS);
  if (terminal === null) {
    return {
      ok: true,
      evidenceRunId,
      status: "running" as const,
      lineCompleteness: "unavailable" as const,
    };
  }
  return {
    ok: true,
    evidenceRunId,
    status: terminal.status as "success" | "partial" | "failed",
    lineCompleteness: (terminal.lineCompleteness ?? "unavailable") as
      | "complete"
      | "partial"
      | "unavailable",
  };
}

function buildChildren(): IncrementalChildren {
  return {
    async runShopifyEvidence(scope) {
      await flushStage("shopify_evidence", { storeId: scope.storeId });
      // The key carries the store day: each store day gets exactly one
      // evidence pass per connection, and a fresh day always starts a
      // fresh pass instead of deduping to yesterday's completed child
      // (which a later ingest would have staled anyway).
      const connection = await getConnectionRecord(scope);
      if (!connection) throw new Error("Klaviyo connection is outside scope");
      const storeDay = deriveDayInTimezone(new Date(), connection.storeTimezone);
      const dayKey = `klaviyo:incremental:evidence:${scope.connectionId}:incremental_7d:${storeDay}`;
      const attempt = await runEvidenceAttempt(dayKey);
      const attemptAcceptable =
        attempt.ok &&
        attempt.evidenceRunId !== null &&
        ((attempt.status === "success" &&
          attempt.lineCompleteness === "complete") ||
          (attempt.status === "partial" &&
            attempt.lineCompleteness === "partial"));
      if (!attemptAcceptable) return attempt;
      // The same-store-day key can resume an evidence run that finished
      // before later Shopify ingest mutated in-window orders; the matching
      // stage would then reject it (shopify_content_mutated). Evaluate the
      // matcher's own acceptability predicate here — resume if fresh,
      // rerun if stale — so supervisor and matcher can never disagree.
      const verdict = await isEvidenceRunAcceptableForMatching({
        scope,
        shopifyEvidenceRunId: attempt.evidenceRunId!,
      });
      if (verdict.acceptable) return attempt;
      // Exactly one forced fresh pass, keyed deterministically off the
      // stale run so supervisor replays dedupe to the same retry. If the
      // fresh run is also staled by racing ingest, downstream matching
      // records the failure exactly as before — never a retry loop.
      await flushStage("shopify_evidence_supersede", {
        staleEvidenceRunId: attempt.evidenceRunId,
        reason: verdict.reason,
      });
      return runEvidenceAttempt(
        `${dayKey}:supersede:${attempt.evidenceRunId}`,
      );
    },

    async runOrderCore(scope) {
      await flushStage("order_core");
      const connection = await getConnectionRecord(scope);
      if (!connection) throw new Error("Klaviyo connection is outside scope");
      const today = new Date();
      const dateTo = today.toISOString().slice(0, 10);
      const dateFrom = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const window = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom,
        dateTo,
        timeZone: connection.storeTimezone,
      });
      // A busy events slot (for example a still-live journey run straddling
      // into this pass) is a recorded stage failure for this run, never a
      // supervisor crash — the next scheduled pass retries after the lease.
      let prepared: { syncRunId: string };
      try {
        prepared = await startOrResumeOrderCoreSync({
          scope,
          window,
          triggerType: "scheduled",
        });
      } catch {
        return {
          syncRunId: null,
          status: "failed" as const,
          checkpointNull: false,
          orderCoreParameters: false,
        };
      }
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo:events:first:${prepared.syncRunId}`,
        { scope: "global" },
      );
      await tasks.trigger(
        "klaviyo-order-core-batch",
        { syncRunId: prepared.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
      await flushStage("order_core_wait", { syncRunId: prepared.syncRunId });
      const terminal = await pollDatabase(async () => {
        const [run] = await db
          .select({
            status: klaviyoSyncRuns.status,
            checkpoint: klaviyoSyncRuns.checkpoint,
            requestParameters: klaviyoSyncRuns.requestParameters,
          })
          .from(klaviyoSyncRuns)
          .where(eq(klaviyoSyncRuns.id, prepared.syncRunId))
          .limit(1);
        if (!run || run.status === "running") return null;
        return run;
      });
      if (terminal === null) {
        return {
          syncRunId: prepared.syncRunId,
          status: "running" as const,
          checkpointNull: false,
          orderCoreParameters: false,
        };
      }
      const parameters = terminal.requestParameters as {
        sourceMode?: string;
        metricKinds?: string[];
      };
      return {
        syncRunId: prepared.syncRunId,
        status: terminal.status as "success" | "partial" | "failed",
        checkpointNull: terminal.checkpoint === null,
        orderCoreParameters:
          parameters?.sourceMode === "order_core" &&
          JSON.stringify(parameters?.metricKinds) ===
            JSON.stringify(["placed_order", "ordered_product"]),
      };
    },

    async runMatching(scope, input) {
      await flushStage("matching", input);
      let inputs: Awaited<ReturnType<typeof selectLatestMatchInputs>>;
      try {
        inputs = await selectLatestMatchInputs(scope);
      } catch {
        return { published: false, matchRunId: null };
      }
      if (
        inputs.sourceRunId !== input.sourceRunId ||
        inputs.shopifyEvidenceRunId !== input.shopifyEvidenceRunId
      ) {
        // A later run (for example a journey run) can never replace the
        // retained exact order-core source run for this chain.
        return { published: false, matchRunId: null };
      }
      const payload = {
        invocationFingerprint: inputs.invocationFingerprint,
        connectionId: scope.connectionId,
        sourceRunId: inputs.sourceRunId,
        shopifyEvidenceRunId: inputs.shopifyEvidenceRunId,
        from: inputs.window.from.toISOString(),
        to: inputs.window.to.toISOString(),
        // The match task's closed reason union: a chain that follows a
        // fresh source sync is exactly "source_sync".
        reason: "source_sync" as const,
      };
      await triggerOrRepairMatchInvocation({
        invocationFingerprint: inputs.invocationFingerprint,
        adapters: {
          async triggerWithKey(key) {
            const idempotencyKey = await idempotencyKeys.create(key, {
              scope: "global",
            });
            const handle = await tasks.trigger("klaviyo-match", payload, {
              idempotencyKey,
              idempotencyKeyTTL: "7d",
            });
            return { triggerRunId: handle.id };
          },
          async getRunStatus(runId) {
            const run = await runs.retrieve(runId);
            return { status: run.status };
          },
          async verifyPublishedRun(runId) {
            const run = await runs.retrieve(runId);
            const output = run.output as { matchRunId?: string } | undefined;
            if (!output?.matchRunId) return false;
            const [row] = await db
              .select({ id: klaviyoMatchRuns.id })
              .from(klaviyoMatchRuns)
              .where(
                and(
                  eq(klaviyoMatchRuns.id, output.matchRunId),
                  eq(klaviyoMatchRuns.connectionId, scope.connectionId),
                  eq(klaviyoMatchRuns.status, "published"),
                ),
              )
              .limit(1);
            return row !== undefined;
          },
        },
      });
      const published = await pollDatabase(async () => {
        const [run] = await db
          .select({ id: klaviyoMatchRuns.id })
          .from(klaviyoMatchRuns)
          .where(
            and(
              eq(klaviyoMatchRuns.connectionId, scope.connectionId),
              eq(klaviyoMatchRuns.sourceRunId, input.sourceRunId),
              eq(
                klaviyoMatchRuns.shopifyEvidenceRunId,
                input.shopifyEvidenceRunId,
              ),
              eq(klaviyoMatchRuns.status, "published"),
              isNull(klaviyoMatchRuns.supersededAt),
            ),
          )
          .orderBy(desc(klaviyoMatchRuns.publishedAt))
          .limit(1);
        return run ?? null;
      });
      return {
        published: published !== null,
        matchRunId: published?.id ?? null,
      };
    },

    async startClaims(scope, input) {
      await flushStage("claims_start", input);
      return startOrResumeClaimReplay({
        scope,
        sourceRunId: input.sourceRunId,
        matchRunId: input.matchRunId,
        now: new Date(),
      });
    },

    async runClaimGraph(scope, claimReplayId) {
      await flushStage("claims_wait", { claimReplayId });
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo-claims:first:${claimReplayId}`,
        { scope: "global" },
      );
      const result = await tasks.triggerAndWait(
        "klaviyo-claims",
        { claimReplayId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
      metadata.set("claimTriggerRunId", result.id);
      await metadata.flush();
      if (!result.ok) {
        throw new Error("Klaviyo claim child did not complete");
      }
      // The durable graph — not child output — is authoritative.
      const terminal = await pollDatabase(async () => {
        const [graph] = await db
          .select({ status: klaviyoClaimReplayRuns.status })
          .from(klaviyoClaimReplayRuns)
          .where(eq(klaviyoClaimReplayRuns.id, claimReplayId))
          .limit(1);
        if (!graph || graph.status === "running") return null;
        return graph;
      });
      return {
        status: (terminal?.status ?? "running") as
          | "success"
          | "partial"
          | "failed"
          | "stale"
          | "running",
      };
    },

    async recoverClaims(scope, claimReplayId) {
      await recoverExhaustedClaimBatch({
        scope,
        claimReplayId,
        now: new Date(),
      });
    },

    async runJourney(scope) {
      await flushStage("journey");
      const connection = await getConnectionRecord(scope);
      if (!connection) return { ok: false };
      const window = trailingWeekWindow(connection.storeTimezone);
      const prepared = await startOrResumeJourneySync({
        scope,
        window,
        triggerType: "scheduled",
      });
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo:journey:first:${prepared.syncRunId}`,
        { scope: "global" },
      );
      await tasks.trigger(
        "klaviyo-order-core-batch",
        { syncRunId: prepared.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
      return { ok: true };
    },

    async runConsent(scope) {
      await flushStage("consent");
      const connection = await getConnectionRecord(scope);
      if (!connection) return { status: "failed" as const };
      // Journey and consent share the one running-events slot
      // (klaviyo_sync_run_one_running_events_uidx). runJourney above only
      // fires-and-forgets its batch task, so its run row can still be
      // "running" here — wait for it to vacate instead of racing the
      // "already running in a different source mode" guard in
      // startOrResumeConsentSync.
      await flushStage("consent_wait");
      await pollDatabase(
        async () => ((await hasRunningEventsRun(scope)) ? null : true),
        CONSENT_WAIT_DEADLINE_MS,
      );
      // Deadline expiry falls through to one start attempt regardless: a
      // genuinely still-live run makes the guard throw (caught and logged
      // upstream, same outcome as returning early), but a run that went
      // stale during the wait (>20 min heartbeat) gets reaped by the
      // guard's own reap-on-start, so consent still proceeds tonight.
      await flushStage("consent");
      const window = trailingWeekWindow(connection.storeTimezone);
      const prepared = await startOrResumeConsentSync({
        scope,
        window,
        triggerType: "scheduled",
      });
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo:consent:first:${prepared.syncRunId}`,
        { scope: "global" },
      );
      await tasks.trigger(
        "klaviyo-order-core-batch",
        { syncRunId: prepared.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
      // The consent stage reports completion, not dispatch: poll the
      // durable run row to its terminal status. Still "running" (or not
      // yet visible) at the deadline reports as live_at_deadline pending,
      // mirroring the claims stage.
      await flushStage("consent_run_wait", { syncRunId: prepared.syncRunId });
      const terminal = await pollDatabase(async () => {
        const status = await getEventsRunStatus(scope, prepared.syncRunId);
        if (status === null || status === "running") return null;
        return status;
      });
      if (terminal === null) return { status: "running" as const };
      return terminal === "success"
        ? { status: "success" as const }
        : { status: "failed" as const };
    },

    async runDimensions(scope) {
      await flushStage("dimensions");
      const prepared = await startOrResumeDimensionSync({
        scope,
        triggerType: "scheduled",
        now: new Date(),
      });
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo:dimensions:first:${prepared.syncRunId}`,
        { scope: "global" },
      );
      await tasks.trigger(
        "klaviyo-dimensions",
        { syncRunId: prepared.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
      return { ok: true };
    },

    async runReports(scope) {
      await flushStage("reports");
      const connection = await getConnectionRecord(scope);
      if (!connection) return { ok: false };
      const today = new Date();
      const window = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
        dateTo: today.toISOString().slice(0, 10),
        timeZone: connection.storeTimezone,
      });
      // The incremental supervisor is the only scheduled-reason caller and
      // never triggers when preflight returns all-fresh.
      const prepared = await startOrResumeReportSync({
        scope,
        window,
        kinds: ["campaign", "flow"],
        reason: "scheduled",
        now: new Date(),
      });
      if (prepared.kind === "fresh") return { ok: true };
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo:reports:first:${prepared.syncRunId}`,
        { scope: "global" },
      );
      await tasks.trigger(
        "klaviyo-reports",
        { syncRunId: prepared.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
      return { ok: true };
    },
  };
}

async function runIncrementalSupervisor(payload: SupervisorPayload) {
  const eligible = await listEligibleConnections();
  const targets = payload?.organizationId
    ? eligible.filter(
        (scope) => scope.organizationId === payload.organizationId,
      )
    : eligible;
  const reports: Record<string, unknown> = {};
  for (const scope of targets) {
    await tags.add(`klaviyo:org:${scope.organizationId}`);
    reports[scope.connectionId] = await runIncrementalConnection(
      { scope },
      buildChildren(),
    );
  }
  metadata.set("connections", targets.length);
  await metadata.flush();
  return { ok: true as const, connections: targets.length, reports };
}

/**
 * Staged incremental supervisor. It enumerates only repository-eligible
 * connections and hands children internal IDs and safe ranges — never
 * private keys, HMACs, profile IDs, raw provider data, or raw cursors.
 * Durable child waits run sequentially through named stages (never a
 * parallel wait), the supervisor checkpoint is flushed to run metadata
 * before every handoff and poll, and database terminal-state waits use
 * durable intervals bounded by a persisted deadline.
 *
 * Eligibility (connection ready + probe passed + order-core backfill
 * complete) is the per-connection gate the pilot design requires before
 * daily refresh, so the schedule below no-ops until bootstrap succeeds.
 * This manual task remains available for single-organization runs.
 */
export const klaviyoIncrementalTask = task({
  id: "klaviyo-incremental",
  retry: ATTRIBUTION_TASK_RETRY,
  maxDuration: 3_000,
  queue: SUPERVISOR_QUEUE,
  run: async (payload: SupervisorPayload) => runIncrementalSupervisor(payload),
});

export const klaviyoIncrementalScheduled = schedules.task({
  id: "klaviyo-incremental-scheduled",
  // 20:30 UTC = 4:30am store time (PHT): after the 18:00 Meta sync and
  // 19:30 attribution checks, clear of the top-of-hour Shopify sync.
  cron: "30 20 * * *",
  retry: ATTRIBUTION_TASK_RETRY,
  maxDuration: 3_000,
  queue: SUPERVISOR_QUEUE,
  run: async () => runIncrementalSupervisor({}),
});
