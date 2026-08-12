import { logger, metadata, schedules, task } from "@trigger.dev/sdk";
import { formatDateOnly } from "@/lib/date";
import { executeRetention } from "@/lib/retention/execute";
import { listRetentionOrganizationIds, planRetention } from "@/lib/retention/plan";
import {
  redactOrganizationId,
  retentionEnforcedOrganizationIds,
} from "@/lib/retention/policy";
import { rollupMonthlySummaries } from "@/lib/retention/rollup";
import { RETENTION_TASK_RETRY } from "./retry";

const RETENTION_QUEUE = {
  name: "retention-sweep",
  concurrencyLimit: 1,
};

type RetentionRunPayload = {
  organizationId: string;
  execute?: boolean;
};

export function mayExecuteRetention(
  organizationId: string,
  executeRequested: boolean,
  enforcedOrganizationIds: ReadonlySet<string>,
) {
  return executeRequested && enforcedOrganizationIds.has(organizationId);
}

function deletedRowCount(deleted: Record<string, number>) {
  return Object.values(deleted).reduce((total, count) => total + count, 0);
}

async function runRetentionForOrganization(input: {
  organizationId: string;
  executeRequested: boolean;
  progress?: string;
}) {
  const { organizationId, executeRequested, progress } = input;
  const today = formatDateOnly(new Date());
  const redactedOrganizationId = redactOrganizationId(organizationId);
  const enforcedOrganizationIds = retentionEnforcedOrganizationIds();
  const enforce = mayExecuteRetention(
    organizationId,
    executeRequested,
    enforcedOrganizationIds,
  );
  const mode = enforce ? "enforce" : "dry-run";

  metadata.set("organizationId", redactedOrganizationId);
  if (progress) metadata.set("organizationProgress", progress);
  metadata.set("mode", mode);

  const rollup = await rollupMonthlySummaries({ organizationId, today });
  const plan = await planRetention({ organizationId, today });

  logger.info("Retention plan", {
    organizationId: redactedOrganizationId,
    mode,
    monthsUpserted: rollup.monthsUpserted,
    today: plan.today,
    cutoffs: plan.cutoffs,
    categories: plan.categories,
    totalCandidateRows: plan.totalCandidateRows,
  });

  metadata.set("candidateRows", plan.totalCandidateRows);
  const result = await executeRetention({
    organizationId,
    today,
    dryRun: !enforce,
  });
  const deletedRows = deletedRowCount(result.deleted);
  metadata.set("deletedRows", deletedRows);

  logger.info("Retention run completed", {
    organizationId: redactedOrganizationId,
    mode,
    candidateRows: plan.totalCandidateRows,
    deletedRows,
  });

  return {
    organizationId: redactedOrganizationId,
    mode,
    monthsUpserted: rollup.monthsUpserted,
    candidateRows: plan.totalCandidateRows,
    deletedRows,
  };
}

export const retentionSweepScheduled = schedules.task({
  id: "retention-sweep-scheduled",
  cron: "0 21 * * *",
  retry: RETENTION_TASK_RETRY,
  queue: RETENTION_QUEUE,
  run: async () => {
    const organizationIds = await listRetentionOrganizationIds();
    const results = [];

    for (const [index, organizationId] of organizationIds.entries()) {
      results.push(
        await runRetentionForOrganization({
          organizationId,
          executeRequested: true,
          progress: `${index + 1}/${organizationIds.length}`,
        }),
      );
    }

    return { organizations: organizationIds.length, results };
  },
});

export const retentionRunTask = task({
  id: "retention-run",
  retry: RETENTION_TASK_RETRY,
  queue: RETENTION_QUEUE,
  run: async (payload: RetentionRunPayload) =>
    runRetentionForOrganization({
      organizationId: payload.organizationId,
      executeRequested: payload.execute === true,
    }),
});
