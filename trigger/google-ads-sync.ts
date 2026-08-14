import { createHash } from "node:crypto";
import {
  idempotencyKeys,
  logger,
  metadata,
  schedules,
  tags,
  task,
  tasks,
} from "@trigger.dev/sdk";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { googleAdsConnections } from "@/schema/google-ads";
import { runGoogleAdsDiscovery } from "@/lib/google-ads/discovery";
import { accountDay, addDays } from "@/lib/google-ads/facts";
import {
  prepareGoogleAdsFactsRun,
  processGoogleAdsFactsBatch,
} from "@/lib/google-ads/facts-runner";
import {
  connectionScope,
  failGoogleAdsSyncRun,
  resolveGoogleAdsSyncRun,
} from "@/lib/google-ads/sync-store";
import { KLAVIYO_TASK_RETRY } from "./retry";

const GOOGLE_ADS_DISCOVERY_QUEUE = {
  name: "google-ads-discovery",
  concurrencyLimit: 1,
};
const GOOGLE_ADS_FACTS_QUEUE = {
  name: "google-ads-facts",
  concurrencyLimit: 1,
};
const GOOGLE_ADS_NIGHTLY_QUEUE = {
  name: "google-ads-nightly",
  concurrencyLimit: 1,
};
/** Nightly incremental re-fetches this many trailing days so restated conversions converge. */
const INCREMENTAL_TRAILING_DAYS = 30;

type SyncRunPayload = { syncRunId: string };

function assertExactSyncRunPayload(
  value: unknown,
): asserts value is SyncRunPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input.syncRunId !== "string" ||
    input.syncRunId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Google Ads task accepts only a sync run ID");
  }
}

function orgTag(organizationId: string) {
  return `google-ads:org:${organizationId}`;
}

function checkpointFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Retry exhaustion: resolve the run's own scope/operation and fail it in
 * place, so the one-running partial unique indexes can never stay wedged.
 */
async function finalizeExhaustedRun(
  value: unknown,
  expectedOperation: "discovery" | "facts",
) {
  assertExactSyncRunPayload(value);
  const { run, scope } = await resolveGoogleAdsSyncRun(value.syncRunId);
  if (run.operation !== expectedOperation) {
    throw new Error("Google Ads failure payload references the wrong operation");
  }
  await failGoogleAdsSyncRun({
    scope,
    syncRunId: value.syncRunId,
    operation: expectedOperation,
    error: { code: "retry_exhausted", message: "Google Ads task retries were exhausted" },
  });
}

export const googleAdsDiscoveryTask = task({
  id: "google-ads-discovery",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: GOOGLE_ADS_DISCOVERY_QUEUE,
  onFailure: async ({ payload }) => {
    await finalizeExhaustedRun(payload, "discovery");
  },
  run: async (payload: SyncRunPayload) => {
    assertExactSyncRunPayload(payload);
    const { run, scope } = await resolveGoogleAdsSyncRun(payload.syncRunId);
    if (run.operation !== "discovery") {
      throw new Error(
        "Google Ads discovery payload does not reference a discovery run",
      );
    }
    await tags.add(orgTag(scope.organizationId));
    metadata.set("status", "discovering");
    const result = await runGoogleAdsDiscovery({ syncRunId: payload.syncRunId });
    metadata.set("status", result.status);
    return result;
  },
});

export const googleAdsFactsBatchTask = task({
  id: "google-ads-facts-batch",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: GOOGLE_ADS_FACTS_QUEUE,
  onFailure: async ({ payload }) => {
    await finalizeExhaustedRun(payload, "facts");
  },
  run: async (payload: SyncRunPayload) => {
    assertExactSyncRunPayload(payload);
    const { run, scope } = await resolveGoogleAdsSyncRun(payload.syncRunId);
    if (run.operation !== "facts") {
      throw new Error("Google Ads batch payload does not reference a facts run");
    }
    await tags.add(orgTag(scope.organizationId));
    const result = await processGoogleAdsFactsBatch({ syncRunId: payload.syncRunId });
    metadata.set("rowsRead", result.rowsRead);
    if (!result.done) {
      // The key hashes the committed chunk so a retried invocation reuses the
      // same continuation instead of double-triggering.
      const idempotencyKey = await idempotencyKeys.create(
        `google-ads-facts:${payload.syncRunId}:${checkpointFingerprint(result.chunk)}`,
        { scope: "global" },
      );
      await tasks.trigger<typeof googleAdsFactsBatchTask>(
        "google-ads-facts-batch",
        { syncRunId: payload.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
    }
    return result;
  },
});

/**
 * Nightly incremental: only connections whose backfill completed. Re-fetches
 * the trailing window ending yesterday in the ad account's timezone.
 */
export const googleAdsNightlySchedule = schedules.task({
  id: "google-ads-nightly",
  // 04:45 UTC, not each account's local night — the 30-day trailing window
  // absorbs any lag between this run and an account's own local calendar day.
  cron: "45 4 * * *",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 3_000,
  queue: GOOGLE_ADS_NIGHTLY_QUEUE,
  run: async () => {
    const connections = await db
      .select()
      .from(googleAdsConnections)
      .where(
        and(
          eq(googleAdsConnections.status, "ready"),
          isNotNull(googleAdsConnections.backfillCompletedAt),
        ),
      );

    // The pilot supports exactly one Google Ads connection per organization.
    // prepareGoogleAdsFactsRun resolves the connection by organization
    // (limit 1, no ORDER BY — see its own note), so a second connection for
    // the same org would race that lookup: wrong-timezone windows on some
    // nights, permanent skips on others. Dedupe defensively here instead of
    // changing sync-store.ts (out of scope) and warn loudly if this pilot
    // assumption is ever violated.
    const byOrganization = new Map<string, (typeof connections)[number]>();
    let duplicateConnections = 0;
    for (const connection of connections) {
      if (byOrganization.has(connection.organizationId)) {
        duplicateConnections += 1;
        continue;
      }
      byOrganization.set(connection.organizationId, connection);
    }
    if (duplicateConnections > 0) {
      logger.warn(
        "Skipped duplicate Google Ads connections — pilot supports one connection per organization",
        { duplicateConnections },
      );
    }

    let scheduled = 0;
    for (const connection of byOrganization.values()) {
      // A ready connection always has a discovered timezone; substituting
      // UTC here would silently shift the account-day window instead of
      // surfacing the anomaly.
      if (!connection.timezone) {
        logger.warn("Skipped Google Ads nightly facts run — connection has no timezone", {
          connectionId: connection.id,
        });
        continue;
      }
      const yesterday = addDays(accountDay(new Date(), connection.timezone), -1);

      let run: Awaited<ReturnType<typeof prepareGoogleAdsFactsRun>>;
      try {
        run = await prepareGoogleAdsFactsRun({
          organizationId: connection.organizationId,
          windowFromDay: addDays(yesterday, -(INCREMENTAL_TRAILING_DAYS - 1)),
          windowToDay: yesterday,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("already running")) {
          // Benign: a prior night's (or manual) run is still in flight.
          logger.info("Skipped Google Ads nightly facts run — already running", {
            connectionId: connection.id,
          });
        } else {
          logger.warn("Skipped Google Ads nightly facts run for connection", {
            connectionId: connection.id,
            error: message,
          });
        }
        continue;
      }

      try {
        // First-dispatch idempotency key: protects against a schedule-level
        // retry double-triggering the batch task for a run that already got
        // one dispatched successfully.
        const idempotencyKey = await idempotencyKeys.create(
          `google-ads-facts:first:${run.id}`,
          { scope: "global" },
        );
        await tasks.trigger<typeof googleAdsFactsBatchTask>(
          "google-ads-facts-batch",
          { syncRunId: run.id },
          { idempotencyKey, idempotencyKeyTTL: "7d" },
        );
        scheduled += 1;
      } catch (error) {
        // The run row was created but dispatch itself failed — no task run
        // ever starts, so onFailure never fires to close it out. Left alone
        // the run stays "running" forever and the one-running-facts partial
        // unique index wedges every future night for this connection; fail
        // it here instead.
        await failGoogleAdsSyncRun({
          scope: connectionScope(connection),
          syncRunId: run.id,
          operation: "facts",
          error: {
            code: "trigger_dispatch_failed",
            message: "Google Ads facts dispatch failed",
          },
        });
        logger.warn("Google Ads nightly facts dispatch failed; run marked failed", {
          connectionId: connection.id,
          syncRunId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { connectionsScheduled: scheduled };
  },
});
