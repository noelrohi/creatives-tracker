import { createHash } from "node:crypto";
import { idempotencyKeys, metadata, tags, task, tasks } from "@trigger.dev/sdk";
import {
  failReportSync,
  processReportBatch,
} from "@/lib/klaviyo/report-repository";
import { resolveTaskSyncRun } from "@/lib/klaviyo/source-store";
import { KLAVIYO_TASK_RETRY } from "./retry";

const KLAVIYO_REPORTS_QUEUE = {
  name: "klaviyo-reports-low-quota",
  concurrencyLimit: 1,
};

type ReportBatchPayload = { syncRunId: string };

function assertExactReportPayload(
  value: unknown,
): asserts value is ReportBatchPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input.syncRunId !== "string" ||
    input.syncRunId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Klaviyo report task accepts only a sync run ID");
  }
}

function checkpointFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Low-quota report refresh batch on its own single-concurrency queue,
 * independent of discovery, events, and dimensions. Freshness is decided
 * before run creation, never here. A terminal empty/complete page swaps
 * all affected per-kind generations atomically and never enqueues; every
 * failure path routes through the report-specific wrapper so staging
 * generations fail together with the sync run finalization.
 */
export const klaviyoReportsTask = task({
  id: "klaviyo-reports",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_REPORTS_QUEUE,
  onFailure: async ({ payload }) => {
    assertExactReportPayload(payload);
    const run = await resolveTaskSyncRun(payload.syncRunId);
    if (run.operation !== "reports") {
      throw new Error("Klaviyo failure payload references the wrong operation");
    }
    await failReportSync({
      scope: run.scope,
      syncRunId: payload.syncRunId,
      now: new Date(),
    });
  },
  run: async (payload: ReportBatchPayload) => {
    assertExactReportPayload(payload);
    const run = await resolveTaskSyncRun(payload.syncRunId);
    if (run.operation !== "reports") {
      throw new Error("Klaviyo report payload does not reference a report run");
    }
    await tags.add(`klaviyo:org:${run.scope.organizationId}`);
    const result = await processReportBatch({
      scope: run.scope,
      syncRunId: payload.syncRunId,
    });
    metadata.set("done", result.done);
    if (!result.done) {
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo:reports:${payload.syncRunId}:${checkpointFingerprint(result.checkpoint)}`,
        { scope: "global" },
      );
      await tasks.trigger<typeof klaviyoReportsTask>(
        "klaviyo-reports",
        { syncRunId: payload.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
    }
    return result;
  },
});

/** One initial handoff per report run through the canonical global key. */
export async function triggerFirstReportBatch(
  syncRunId: string,
): Promise<{ triggerRunId: string }> {
  const idempotencyKey = await idempotencyKeys.create(
    `klaviyo:reports:first:${syncRunId}`,
    { scope: "global" },
  );
  const handle = await tasks.trigger<typeof klaviyoReportsTask>(
    "klaviyo-reports",
    { syncRunId },
    { idempotencyKey, idempotencyKeyTTL: "7d" },
  );
  return { triggerRunId: handle.id };
}
