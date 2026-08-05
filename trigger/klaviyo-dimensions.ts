import { createHash } from "node:crypto";
import { idempotencyKeys, metadata, tags, task, tasks } from "@trigger.dev/sdk";
import { processDimensionBatch } from "@/lib/klaviyo/dimension-repository";
import {
  failKlaviyoSyncRunAfterRetryExhaustion,
  resolveTaskSyncRun,
} from "@/lib/klaviyo/source-store";
import { KLAVIYO_TASK_RETRY } from "./retry";

const KLAVIYO_DIMENSIONS_QUEUE = {
  name: "klaviyo-dimensions",
  concurrencyLimit: 1,
};

type DimensionBatchPayload = { syncRunId: string };

function assertExactDimensionPayload(
  value: unknown,
): asserts value is DimensionBatchPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input.syncRunId !== "string" ||
    input.syncRunId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Klaviyo dimension task accepts only a sync run ID");
  }
}

function checkpointFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Bounded marketing-dimension traversal batch. Payload carries only the
 * internal sync run ID; scope and operation are re-resolved from that row.
 * Every nonterminal committed checkpoint schedules exactly one global-key
 * continuation; a terminal empty traversal finishes success and never
 * enqueues. Only safe IDs and counts reach logs or metadata.
 */
export const klaviyoDimensionsTask = task({
  id: "klaviyo-dimensions",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_DIMENSIONS_QUEUE,
  onFailure: async ({ payload }) => {
    assertExactDimensionPayload(payload);
    const run = await resolveTaskSyncRun(payload.syncRunId);
    if (run.operation !== "dimensions") {
      throw new Error("Klaviyo failure payload references the wrong operation");
    }
    await failKlaviyoSyncRunAfterRetryExhaustion({
      scope: run.scope,
      syncRunId: payload.syncRunId,
      operation: "dimensions",
    });
  },
  run: async (payload: DimensionBatchPayload) => {
    assertExactDimensionPayload(payload);
    const run = await resolveTaskSyncRun(payload.syncRunId);
    if (run.operation !== "dimensions") {
      throw new Error(
        "Klaviyo dimension payload does not reference a dimension run",
      );
    }
    await tags.add(`klaviyo:org:${run.scope.organizationId}`);
    const result = await processDimensionBatch({
      scope: run.scope,
      syncRunId: payload.syncRunId,
    });
    metadata.set("requestsUsed", result.requestsUsed);
    metadata.set("done", result.done);
    if (!result.done) {
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo:dimensions:${payload.syncRunId}:${checkpointFingerprint(result.checkpoint)}`,
        { scope: "global" },
      );
      await tasks.trigger<typeof klaviyoDimensionsTask>(
        "klaviyo-dimensions",
        { syncRunId: payload.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
    }
    return result.done
      ? { done: true as const, checkpoint: null }
      : { done: false as const, checkpoint: result.checkpoint };
  },
});
