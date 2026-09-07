import "server-only";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { loadSnapshotRun } from "./snapshot-store";

/** One worker owns the entire resumable run: retries never fork continuations. */
export async function dispatchSnapshotRun(snapshotRunId: string) {
  const { row } = await loadSnapshotRun(snapshotRunId);
  if (row.state !== "running") return { triggerRunId: null };
  const idempotencyKey = await idempotencyKeys.create(
    `klaviyo:snapshots:first:${snapshotRunId}`, { scope: "global" },
  );
  const handle = await tasks.trigger(
    row.dataset === "campaign_values" ? "klaviyo-snapshot-reports" : "klaviyo-snapshots",
    { snapshotRunId },
    { idempotencyKey, idempotencyKeyTTL: "7d" },
  );
  // Ambiguous dispatch failures leave the run recoverable via this same key.
  return { triggerRunId: handle.id };
}
