import "server-only";

import { createHash } from "node:crypto";

/**
 * Server-only match invocation lifecycle. Maps provider run states into a
 * closed internal union and repairs dead invocations through a bounded
 * deterministic idempotency-key chain. Accepts injected adapters; imports
 * no router, session, or Trigger task code and exposes no task payload.
 */

export type MatchInvocationState =
  | "live"
  | "completed"
  | "failed_auto_cleared"
  | "terminal_without_publication";

const LIVE_STATES = new Set([
  "QUEUED",
  "PENDING",
  "PENDING_VERSION",
  "EXECUTING",
  "DEQUEUED",
  "WAITING",
  "WAITING_FOR_DEPLOY",
  "REATTEMPTING",
  "RETRYING_AFTER_FAILURE",
  "DELAYED",
  "FROZEN",
  "PAUSED",
]);
const TERMINAL_WITHOUT_PUBLICATION_STATES = new Set([
  "CANCELED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "INTERRUPTED",
  "TIMED_OUT",
  "TIMEDOUT",
  "EXPIRED",
]);

export class UnknownProviderRunStateError extends Error {
  constructor() {
    super("Klaviyo match invocation returned an unknown provider state");
    this.name = "UnknownProviderRunStateError";
  }
}

export class MatchInvocationUnavailableError extends Error {
  constructor() {
    super("Klaviyo match invocation is unavailable after bounded recovery");
    this.name = "MatchInvocationUnavailableError";
  }
}

export function mapProviderRunState(status: string): MatchInvocationState {
  const normalized = status.toUpperCase();
  if (LIVE_STATES.has(normalized)) return "live";
  if (normalized === "COMPLETED") return "completed";
  if (normalized === "FAILED") return "failed_auto_cleared";
  if (TERMINAL_WITHOUT_PUBLICATION_STATES.has(normalized)) {
    return "terminal_without_publication";
  }
  // Unknown/unparseable states fail closed without key mutation.
  throw new UnknownProviderRunStateError();
}

export const MATCH_INVOCATION_KEY_TTL = "7d";
export const MATCH_INVOCATION_MAX_RECOVERY_HOPS = 3;

export function baseInvocationKey(fingerprint: string): string {
  return `klaviyo-match:${fingerprint}`;
}

export function recoveryInvocationKey(
  fingerprint: string,
  previousTriggerRunId: string,
): string {
  const digest = createHash("sha256")
    .update(previousTriggerRunId, "utf8")
    .digest("hex");
  return `klaviyo-match:${fingerprint}:recover:${digest}`;
}

export type MatchInvocationAdapters = {
  /**
   * Trigger (or dedupe onto) the run for an explicit global idempotency key
   * with the seven-day TTL; returns the resolved run ID.
   */
  triggerWithKey(key: string): Promise<{ triggerRunId: string }>;
  /** Retrieve the provider status string for a run. */
  getRunStatus(triggerRunId: string): Promise<{ status: string }>;
  /**
   * Verify a completed run's output resolves to the scoped published row.
   */
  verifyPublishedRun(triggerRunId: string): Promise<boolean>;
};

export async function triggerOrRepairMatchInvocation(input: {
  invocationFingerprint: string;
  adapters: MatchInvocationAdapters;
}): Promise<{ triggerRunId: string; key: string; alreadyPublished: boolean }> {
  let key = baseInvocationKey(input.invocationFingerprint);
  for (let hop = 0; hop <= MATCH_INVOCATION_MAX_RECOVERY_HOPS; hop += 1) {
    const { triggerRunId } = await input.adapters.triggerWithKey(key);
    const { status } = await input.adapters.getRunStatus(triggerRunId);
    const state = mapProviderRunState(status);
    if (state === "live") {
      // In-flight runs are never reset or versioned.
      return { triggerRunId, key, alreadyPublished: false };
    }
    if (state === "completed") {
      if (await input.adapters.verifyPublishedRun(triggerRunId)) {
        // A valid completed run keeps its key untouched: the caller learns
        // this invocation is already published and no new run exists.
        return { triggerRunId, key, alreadyPublished: true };
      }
      // Completed without a verified publication: recovery hop.
    } else if (state === "failed_auto_cleared") {
      // The provider auto-clears a failed run's key; retriggering the same
      // exact key starts the retry.
      const retry = await input.adapters.triggerWithKey(key);
      return { triggerRunId: retry.triggerRunId, key, alreadyPublished: false };
    }
    if (hop === MATCH_INVOCATION_MAX_RECOVERY_HOPS) break;
    key = recoveryInvocationKey(input.invocationFingerprint, triggerRunId);
  }
  throw new MatchInvocationUnavailableError();
}
