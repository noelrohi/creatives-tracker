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
  cron: "45 4 * * *",
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
    let scheduled = 0;
    for (const connection of connections) {
      const timezone = connection.timezone ?? "UTC";
      const yesterday = addDays(accountDay(new Date(), timezone), -1);
      try {
        const run = await prepareGoogleAdsFactsRun({
          organizationId: connection.organizationId,
          windowFromDay: addDays(yesterday, -(INCREMENTAL_TRAILING_DAYS - 1)),
          windowToDay: yesterday,
        });
        await tasks.trigger<typeof googleAdsFactsBatchTask>(
          "google-ads-facts-batch",
          { syncRunId: run.id },
        );
        scheduled += 1;
      } catch (error) {
        // A facts run already in flight (or a degraded connection racing the
        // read) skips this connection tonight rather than failing the batch.
        logger.warn("Skipped Google Ads nightly facts run for connection", {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { connectionsScheduled: scheduled };
  },
});
