import { createHash } from "node:crypto";
import { idempotencyKeys, metadata, tags, task, tasks } from "@trigger.dev/sdk";
import { runKlaviyoDiscovery } from "@/lib/klaviyo/discovery";
import { runKlaviyoProbe } from "@/lib/klaviyo/probe";
import { processEventSourceBatch } from "@/lib/klaviyo/source-runner";
import {
  failKlaviyoSyncRunAfterRetryExhaustion,
  resolveTaskSyncRun,
} from "@/lib/klaviyo/source-store";
import { KLAVIYO_TASK_RETRY } from "./retry";

const KLAVIYO_DISCOVERY_QUEUE = {
  name: "klaviyo-discovery",
  concurrencyLimit: 1,
};
const KLAVIYO_EVENTS_QUEUE = {
  name: "klaviyo-events",
  concurrencyLimit: 1,
};
const MAX_PAGES_PER_BATCH = 5;

type SourceBatchPayload = { syncRunId: string };

function assertExactSourceBatchPayload(
  value: unknown,
): asserts value is SourceBatchPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input.syncRunId !== "string" ||
    input.syncRunId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Klaviyo source task accepts only a sync run ID");
  }
}

async function finalizeExhaustedSourceRun(
  value: unknown,
  expectedOperation: "discovery" | "probe" | "events",
) {
  assertExactSourceBatchPayload(value);
  const run = await resolveTaskSyncRun(value.syncRunId);
  if (run.operation !== expectedOperation) {
    throw new Error("Klaviyo failure payload references the wrong operation");
  }
  return failKlaviyoSyncRunAfterRetryExhaustion({
    scope: run.scope,
    syncRunId: value.syncRunId,
    operation: expectedOperation,
  });
}

function orgTag(organizationId: string) {
  return `klaviyo:org:${organizationId}`;
}

function checkpointFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const klaviyoDiscoveryTask = task({
  id: "klaviyo-discovery",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_DISCOVERY_QUEUE,
  onFailure: async ({ payload }) => {
    await finalizeExhaustedSourceRun(payload, "discovery");
  },
  run: async (payload: SourceBatchPayload) => {
    assertExactSourceBatchPayload(payload);
    const run = await resolveTaskSyncRun(payload.syncRunId);
    if (run.operation !== "discovery") {
      throw new Error(
        "Klaviyo discovery payload does not reference a discovery run",
      );
    }
    await tags.add(orgTag(run.scope.organizationId));
    metadata.set("status", "discovering");
    const result = await runKlaviyoDiscovery({
      scope: run.scope,
      syncRunId: payload.syncRunId,
    });
    metadata.set("status", "completed");
    return result;
  },
});

export const klaviyoProbeTask = task({
  id: "klaviyo-probe",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_DISCOVERY_QUEUE,
  onFailure: async ({ payload }) => {
    await finalizeExhaustedSourceRun(payload, "probe");
  },
  run: async (payload: SourceBatchPayload) => {
    assertExactSourceBatchPayload(payload);
    const run = await resolveTaskSyncRun(payload.syncRunId);
    if (run.operation !== "probe") {
      throw new Error("Klaviyo probe payload does not reference a probe run");
    }
    await tags.add(orgTag(run.scope.organizationId));
    metadata.set("status", "probing");
    const result = await runKlaviyoProbe({
      scope: run.scope,
      syncRunId: payload.syncRunId,
    });
    metadata.set("status", "awaiting_review");
    return result;
  },
});

export const klaviyoOrderCoreBatchTask = task({
  id: "klaviyo-order-core-batch",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_EVENTS_QUEUE,
  onFailure: async ({ payload }) => {
    await finalizeExhaustedSourceRun(payload, "events");
  },
  run: async (payload: SourceBatchPayload) => {
    assertExactSourceBatchPayload(payload);
    const run = await resolveTaskSyncRun(payload.syncRunId);
    if (run.operation !== "events") {
      throw new Error("Klaviyo batch payload does not reference an event run");
    }
    await tags.add(orgTag(run.scope.organizationId));
    // The durable run's immutable parameters — never the payload — decide
    // order-core versus journey processing inside the one engine.
    const result = await processEventSourceBatch({
      scope: run.scope,
      syncRunId: payload.syncRunId,
      maxPages: MAX_PAGES_PER_BATCH,
    });
    metadata.set("pagesProcessed", result.pagesProcessed);
    metadata.set("eventsRead", result.eventsRead);
    metadata.set("sourceMode", result.sourceMode);
    if (!result.done) {
      // The key hashes the validated persisted next checkpoint, so provider
      // cursors never appear in task keys or logs.
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo-${result.sourceMode === "journey" ? "journey" : "order-core"}:${payload.syncRunId}:${checkpointFingerprint(result.checkpoint)}`,
        { scope: "global" },
      );
      await tasks.trigger<typeof klaviyoOrderCoreBatchTask>(
        "klaviyo-order-core-batch",
        { syncRunId: payload.syncRunId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
    }
    return result;
  },
});
