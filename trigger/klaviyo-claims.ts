import { createHash } from "node:crypto";
import { idempotencyKeys, metadata, tags, task, tasks } from "@trigger.dev/sdk";
import {
  processClaimBatch,
  recoverExhaustedClaimBatch,
  resolveClaimReplayScope,
} from "@/lib/klaviyo/claim-repository";
import { ATTRIBUTION_TASK_RETRY } from "./retry";

const KLAVIYO_CLAIMS_QUEUE = {
  name: "klaviyo-claims",
  concurrencyLimit: 1,
};

type ClaimBatchPayload = { claimReplayId: string };

function assertExactClaimPayload(
  value: unknown,
): asserts value is ClaimBatchPayload {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input.claimReplayId !== "string" ||
    input.claimReplayId.length === 0 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Klaviyo claim task accepts only a claim replay ID");
  }
}

function tupleHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Bounded claim replay batch on a dedicated single-concurrency queue. The
 * payload carries only the internal database-owned graph ID; scope and
 * bound source/match runs are re-resolved from the durable graph row.
 * Continuation keys hash only the persisted validated tuple — never a
 * provider cursor or external event ID — and are created with explicit
 * global scope and a seven-day TTL. The terminal onFailure hook applies
 * the idempotent exact-attempt recovery without passing raw errors;
 * failExpiredClaimReplayRun remains the lease fallback for skipped hooks.
 */
export const klaviyoClaimsTask = task({
  id: "klaviyo-claims",
  retry: ATTRIBUTION_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_CLAIMS_QUEUE,
  onFailure: async ({ payload }) => {
    assertExactClaimPayload(payload);
    const { scope } = await resolveClaimReplayScope(payload.claimReplayId);
    await recoverExhaustedClaimBatch({
      scope,
      claimReplayId: payload.claimReplayId,
      now: new Date(),
    });
  },
  run: async (payload: ClaimBatchPayload) => {
    assertExactClaimPayload(payload);
    const { scope, sourceRunId, matchRunId } = await resolveClaimReplayScope(
      payload.claimReplayId,
    );
    await tags.add(`klaviyo:org:${scope.organizationId}`);
    const result = await processClaimBatch({
      scope,
      claimReplayId: payload.claimReplayId,
    });
    metadata.set("outcome", result.outcome);
    metadata.set("processed", result.processed);
    metadata.set("supersededSkipped", result.supersededSkipped);
    if (
      (result.outcome === "continue" || result.outcome === "budget_exhausted") &&
      result.checkpoint !== null
    ) {
      const idempotencyKey = await idempotencyKeys.create(
        `klaviyo-claims:${payload.claimReplayId}:${sourceRunId}:${matchRunId}:${result.checkpoint.phase}:${tupleHash(result.checkpoint)}`,
        { scope: "global" },
      );
      await tasks.trigger<typeof klaviyoClaimsTask>(
        "klaviyo-claims",
        { claimReplayId: payload.claimReplayId },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
    }
    return {
      ok: true as const,
      outcome: result.outcome,
      processed: result.processed,
      supersededSkipped: result.supersededSkipped,
    };
  },
});

/**
 * Initial handoff helper: exactly one first child per graph through the
 * canonical `klaviyo-claims:first:${claimReplayId}` global key.
 */
export async function triggerFirstClaimBatch(
  claimReplayId: string,
): Promise<{ triggerRunId: string }> {
  const idempotencyKey = await idempotencyKeys.create(
    `klaviyo-claims:first:${claimReplayId}`,
    { scope: "global" },
  );
  const handle = await tasks.trigger<typeof klaviyoClaimsTask>(
    "klaviyo-claims",
    { claimReplayId },
    { idempotencyKey, idempotencyKeyTTL: "7d" },
  );
  return { triggerRunId: handle.id };
}
