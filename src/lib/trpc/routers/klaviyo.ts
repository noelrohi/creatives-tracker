import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { router, orgAdminProcedure } from "../init";
import { prepareKlaviyoDiscoveryRun } from "@/lib/klaviyo/discovery";
import { reviewJoinRule, reviewProbeReport } from "@/lib/klaviyo/join-rules";
import { prepareKlaviyoProbeRun } from "@/lib/klaviyo/probe";
import { startOrResumeOrderCoreSync } from "@/lib/klaviyo/source-runner";
import {
  ensurePilotConnection,
  failKlaviyoSyncRunAfterRetryExhaustion,
  getKlaviyoHealthForOrganization,
  getPilotConnectionForOrganization,
  listKlaviyoProbeReview,
  listKlaviyoSyncRuns,
  type ConnectionRecord,
} from "@/lib/klaviyo/source-store";
import {
  inclusiveStoreDaysToHalfOpenUtc,
  type KlaviyoConnectionScope,
} from "@/lib/klaviyo/types";

const reviewNoteSchema = z.string().trim().min(1).max(1000);
const resourceIdSchema = z.string().trim().min(1);
const storeDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function requirePilotConnection(
  organizationId: string,
): Promise<ConnectionRecord> {
  const connection = await getPilotConnectionForOrganization(organizationId);
  if (!connection) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Klaviyo pilot connection is not configured",
    });
  }
  return connection;
}

/**
 * The initial-handoff key is operation + syncRunId with explicit global
 * scope, so repeating a browser call for the same live run resolves the
 * same child. Payloads carry only the internal run ID.
 */
async function triggerPreparedSyncRun(input: {
  scope: KlaviyoConnectionScope;
  syncRunId: string;
  operation: "discovery" | "probe" | "events";
  taskId: string;
}): Promise<{ id: string }> {
  try {
    const idempotencyKey = await idempotencyKeys.create(
      `klaviyo:${input.operation}:first:${input.syncRunId}`,
      { scope: "global" },
    );
    return await tasks.trigger(
      input.taskId,
      { syncRunId: input.syncRunId },
      { idempotencyKey, idempotencyKeyTTL: "7d" },
    );
  } catch {
    // Definitive or ambiguous handoff failure: terminally fail the exact
    // prepared row with the fixed code; an ambiguously delivered child then
    // observes a terminal row and performs no source write. The caught
    // error never reaches persistence.
    try {
      await failKlaviyoSyncRunAfterRetryExhaustion({
        scope: input.scope,
        syncRunId: input.syncRunId,
        operation: input.operation,
      });
    } catch {
      // The reconciler covers a finalizer race; the safe error still returns.
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Klaviyo task handoff failed",
    });
  }
}

export const klaviyoRouter = router({
  health: orgAdminProcedure.query(({ ctx }) =>
    getKlaviyoHealthForOrganization(ctx.organizationId),
  ),

  syncRuns: orgAdminProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(20),
          cursor: z.string().nullish(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      return listKlaviyoSyncRuns({
        scope: connection,
        limit: input?.limit ?? 20,
        cursor: input?.cursor ?? null,
      });
    }),

  probe: orgAdminProcedure.query(async ({ ctx }) => {
    const connection = await getPilotConnectionForOrganization(
      ctx.organizationId,
    );
    return connection
      ? listKlaviyoProbeReview({ scope: connection })
      : { reports: [], rules: [] };
  }),

  startDiscovery: orgAdminProcedure.mutation(async ({ ctx }) => {
    const connection = await ensurePilotConnection(ctx.organizationId);
    const run = await prepareKlaviyoDiscoveryRun({
      scope: connection,
      triggerType: "manual",
      now: new Date(),
    });
    const handle = await triggerPreparedSyncRun({
      scope: connection,
      syncRunId: run.syncRunId,
      operation: "discovery",
      taskId: "klaviyo-discovery",
    });
    return { runId: handle.id, syncRunId: run.syncRunId };
  }),

  runProbe: orgAdminProcedure
    .input(z.object({ sampleSize: z.number().int().min(20).max(50) }))
    .mutation(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const run = await prepareKlaviyoProbeRun({
        scope: connection,
        sampleSize: input.sampleSize,
        triggerType: "manual",
      });
      const handle = await triggerPreparedSyncRun({
        scope: connection,
        syncRunId: run.syncRunId,
        operation: "probe",
        taskId: "klaviyo-probe",
      });
      return { runId: handle.id, syncRunId: run.syncRunId };
    }),

  approveProbe: orgAdminProcedure
    .input(z.object({ reportId: resourceIdSchema, reviewNote: reviewNoteSchema }))
    .mutation(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      await reviewProbeReport({
        scope: connection,
        reportId: input.reportId,
        reviewerId: ctx.userId!,
        decision: "passed",
        reviewNote: input.reviewNote,
      });
      return { reportId: input.reportId, status: "passed" as const };
    }),

  rejectProbe: orgAdminProcedure
    .input(z.object({ reportId: resourceIdSchema, reviewNote: reviewNoteSchema }))
    .mutation(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      await reviewProbeReport({
        scope: connection,
        reportId: input.reportId,
        reviewerId: ctx.userId!,
        decision: "failed",
        reviewNote: input.reviewNote,
      });
      return { reportId: input.reportId, status: "failed" as const };
    }),

  approveJoinRule: orgAdminProcedure
    .input(z.object({ ruleId: resourceIdSchema, reviewNote: reviewNoteSchema }))
    .mutation(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      await reviewJoinRule({
        scope: connection,
        ruleId: input.ruleId,
        reviewerId: ctx.userId!,
        decision: "approved",
        reviewNote: input.reviewNote,
      });
      return { ruleId: input.ruleId, state: "approved" as const };
    }),

  rejectJoinRule: orgAdminProcedure
    .input(z.object({ ruleId: resourceIdSchema, reviewNote: reviewNoteSchema }))
    .mutation(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      await reviewJoinRule({
        scope: connection,
        ruleId: input.ruleId,
        reviewerId: ctx.userId!,
        decision: "rejected",
        reviewNote: input.reviewNote,
      });
      return { ruleId: input.ruleId, state: "rejected" as const };
    }),

  startOrderCoreSync: orgAdminProcedure
    .input(z.object({ dateFrom: storeDaySchema, dateTo: storeDaySchema }))
    .mutation(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const window = inclusiveStoreDaysToHalfOpenUtc({
        ...input,
        timeZone: connection.storeTimezone,
      });
      const run = await startOrResumeOrderCoreSync({
        scope: connection,
        window,
        triggerType: "manual_backfill",
      });
      const handle = await triggerPreparedSyncRun({
        scope: connection,
        syncRunId: run.syncRunId,
        operation: "events",
        taskId: "klaviyo-order-core-batch",
      });
      return {
        runId: handle.id,
        syncRunId: run.syncRunId,
        resumed: run.resumed,
      };
    }),
});
