import { task, tags } from "@trigger.dev/sdk";
import { computeAndPublishMatches } from "@/lib/klaviyo/match-service";
import { resolveTaskConnection } from "@/lib/klaviyo/source-store";
import { KLAVIYO_TASK_RETRY } from "./retry";

const KLAVIYO_MATCHING_QUEUE = {
  name: "klaviyo-matching",
  concurrencyLimit: 1,
};

type MatchPayload = {
  invocationFingerprint: string;
  connectionId: string;
  sourceRunId: string;
  shopifyEvidenceRunId: string;
  from: string;
  to: string;
  reason: "source_sync" | "manual" | "rule_change";
};

function assertExactMatchPayload(value: unknown): asserts value is MatchPayload {
  const input = value as Record<string, unknown> | null;
  const keys = [
    "invocationFingerprint",
    "connectionId",
    "sourceRunId",
    "shopifyEvidenceRunId",
    "from",
    "to",
    "reason",
  ];
  if (
    !input ||
    Object.keys(input).length !== keys.length ||
    keys.some(
      (key) => typeof input[key] !== "string" || (input[key] as string) === "",
    ) ||
    !["source_sync", "manual", "rule_change"].includes(input.reason as string)
  ) {
    throw new Error("Klaviyo match payload is invalid");
  }
}

export const klaviyoMatchTask = task({
  id: "klaviyo-match",
  retry: KLAVIYO_TASK_RETRY,
  maxDuration: 600,
  queue: KLAVIYO_MATCHING_QUEUE,
  run: async (payload: MatchPayload) => {
    assertExactMatchPayload(payload);
    // Payloads carry only internal IDs; the authoritative scope is always
    // re-resolved from the connection row.
    const connection = await resolveTaskConnection(payload.connectionId);
    await tags.add(`klaviyo:org:${connection.organizationId}`);
    const result = await computeAndPublishMatches({
      scope: {
        organizationId: connection.organizationId,
        storeId: connection.storeId,
        connectionId: connection.connectionId,
      },
      sourceRunId: payload.sourceRunId,
      shopifyEvidenceRunId: payload.shopifyEvidenceRunId,
      expectedInvocationFingerprint: payload.invocationFingerprint,
    });
    // Only internal run IDs, matcher metadata, and counts reach logs.
    return { ok: true as const, matchRunId: result.runId, ...result.counts };
  },
});
