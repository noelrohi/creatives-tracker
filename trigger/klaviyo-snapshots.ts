import { schedules, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { klaviyoConnections } from "@/schema/klaviyo";
import { processSnapshotBatch } from "@/lib/klaviyo/snapshot-collector";
import { dispatchSnapshotRun } from "@/lib/klaviyo/snapshot-dispatch";
import { KlaviyoReadError } from "@/lib/klaviyo/read-transport";
import { failSnapshotRun, loadSnapshotRun, prepareDailySnapshotRuns, claimSnapshotLease } from "@/lib/klaviyo/snapshot-store";
import { KLAVIYO_TASK_RETRY } from "./retry";

const schema = z.object({ snapshotRunId: z.string().min(1) }).strict();
type Payload = z.infer<typeof schema>;

async function finalize({ payload, ctx }: { payload: Payload; ctx: { run: { id: string } } }) {
  const { scope, row } = await loadSnapshotRun(payload.snapshotRunId);
  if (row.leaseOwner !== ctx.run.id) return;
  await failSnapshotRun({ scope, snapshotRunId: payload.snapshotRunId, leaseToken: row.leaseToken, code: "failed", now: new Date() });
}

export async function collectSnapshot(payload: Payload, reports: boolean, owner: string) {
  const initial = await loadSnapshotRun(payload.snapshotRunId);
  if ((initial.row.dataset === "campaign_values") !== reports) throw new Error("Snapshot task dataset mismatch");
  let failures = 0;
  for (;;) {
    const leaseToken = await claimSnapshotLease({ scope: initial.scope, snapshotRunId: payload.snapshotRunId, owner, now: new Date() });
    if (!leaseToken) return { done: true, state: "not_owned" };
    try {
      const result = await processSnapshotBatch(payload.snapshotRunId, { leaseToken });
      if (result.done) return result;
      failures = 0;
    } catch (error) {
      if (!(error instanceof KlaviyoReadError) || !["rate_limited", "unavailable"].includes(error.code)) {
        throw new Error("Snapshot collection unavailable");
      }
      if (++failures >= 3) { await finalize({ payload, ctx: { run: { id: owner } } }); return { done: true, state: "failed" }; }
      const delay = Math.max(error.retryAfterMs ?? 0, 5000 * 2 ** (failures - 1));
      // Renew between durable wait chunks, without spending provider quota.
      // The store also enforces the absolute run lifetime on every claim.
      let remaining = Math.ceil(delay / 1000);
      while (remaining > 0) {
        const seconds = Math.min(remaining, 300);
        await wait.for({ seconds });
        remaining -= seconds;
        const renewed = await claimSnapshotLease({ scope: initial.scope, snapshotRunId: payload.snapshotRunId, owner, now: new Date() });
        if (!renewed) return { done: true, state: "not_owned" };
      }
    }
  }
}

export const klaviyoSnapshotsTask = schemaTask({
  id: "klaviyo-snapshots", schema, retry: KLAVIYO_TASK_RETRY,
  maxDuration: 21600, queue: { name: "klaviyo-snapshots", concurrencyLimit: 1 },
  onFailure: finalize,
  run: (payload, { ctx }) => collectSnapshot(payload, false, ctx.run.id),
});
export const klaviyoSnapshotReportsTask = schemaTask({
  id: "klaviyo-snapshot-reports", schema, retry: KLAVIYO_TASK_RETRY,
  maxDuration: 21600,
  queue: { name: "klaviyo-reports-low-quota", concurrencyLimit: 1 },
  onFailure: finalize,
  run: (payload, { ctx }) => collectSnapshot(payload, true, ctx.run.id),
});

/**
 * Intentional independent snapshot stage on the existing 20:30 UTC cadence.
 * This is a separate schedule, not an incremental-supervisor child: stored
 * ready connections/definitions are enumerated without the evidence gate,
 * and snapshot failures cannot block consent, evidence, claims or reports.
 */
export const klaviyoSnapshotsDailyTask = schedules.task({
  id: "klaviyo-snapshots-daily",
  cron: { pattern: "30 20 * * *", timezone: "UTC" },
  retry: KLAVIYO_TASK_RETRY,
  run: async () => {
    const connections = await db.select({
      organizationId: klaviyoConnections.organizationId,
      storeId: klaviyoConnections.storeId,
      connectionId: klaviyoConnections.id,
    }).from(klaviyoConnections).where(eq(klaviyoConnections.status, "ready"));
    let dispatched = 0;
    let failed = 0;
    const now = new Date();
    for (const scope of connections) {
      try {
        const prepared = await prepareDailySnapshotRuns({ scope, now });
        for (const run of prepared) {
          if (!run.snapshotRunId) continue;
          try { await dispatchSnapshotRun(run.snapshotRunId); dispatched++; }
          catch { failed++; }
        }
      } catch { failed++; }
    }
    return { dispatched, failed };
  },
});
