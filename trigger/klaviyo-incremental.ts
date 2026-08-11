import { idempotencyKeys, metadata, runs, tags, task, tasks, wait } from "@trigger.dev/sdk";
import { inclusiveStoreDaysToHalfOpenUtc } from "@/lib/klaviyo/types";
import {
  recoverExhaustedClaimBatch,
  startOrResumeClaimReplay,
} from "@/lib/klaviyo/claim-repository";
import {
  listEligibleConnections,
  runIncrementalConnection,
  type IncrementalChildren,
} from "@/lib/klaviyo/incremental-sync";
import { triggerOrRepairMatchInvocation } from "@/lib/klaviyo/match-invocation";
import { selectLatestMatchInputs } from "@/lib/klaviyo/match-service";
import { startOrResumeReportSync } from "@/lib/klaviyo/report-repository";
import { startOrResumeDimensionSync } from "@/lib/klaviyo/dimension-repository";
import {
  startOrResumeJourneySync,
  startOrResumeOrderCoreSync,
} from "@/lib/klaviyo/source-runner";
import { getConnectionRecord } from "@/lib/klaviyo/source-store";
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

function buildChildren(): IncrementalChildren {
  return {
    async runShopifyEvidence(scope) {
      await flushStage("shopify_evidence", { storeId: scope.storeId });
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo:incremental:evidence:${scope.connectionId}:incremental_7d`,
        { scope: "global" },
      );
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
      const today = new Date();
      const window = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
        dateTo: today.toISOString().slice(0, 10),
        timeZone: connection.storeTimezone,
      });
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

/**
 * Manual-only staged incremental supervisor. It enumerates only
 * repository-eligible connections and hands children internal IDs and
 * safe ranges — never private keys, HMACs, profile IDs, raw provider
 * data, or raw cursors. Durable child waits run sequentially through
 * named stages (never a parallel wait), the supervisor checkpoint is flushed to
 * run metadata before every handoff and poll, and database terminal-state
 * waits use durable intervals bounded by a persisted deadline. The daily
 * schedule stays disabled in deployment until the Reviv
 * backfill/freshness checklist is signed off; this manual task remains
 * available.
 */
export const klaviyoIncrementalTask = task({
  id: "klaviyo-incremental",
  retry: ATTRIBUTION_TASK_RETRY,
  maxDuration: 3_000,
  queue: SUPERVISOR_QUEUE,
  run: async (payload: SupervisorPayload) => {
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
  },
});
