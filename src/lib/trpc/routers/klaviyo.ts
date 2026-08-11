import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { idempotencyKeys, runs, tasks } from "@trigger.dev/sdk";
import { router, orgAdminProcedure } from "../init";
import { uninstallKlaviyoConnection } from "@/lib/klaviyo/connection-lifecycle";
import { prepareKlaviyoDiscoveryRun } from "@/lib/klaviyo/discovery";
import { reviewJoinRule, reviewProbeReport } from "@/lib/klaviyo/join-rules";
import { prepareKlaviyoProbeRun } from "@/lib/klaviyo/probe";
import {
  MATCH_INVOCATION_KEY_TTL,
  triggerOrRepairMatchInvocation,
} from "@/lib/klaviyo/match-invocation";
import { selectLatestMatchInputs } from "@/lib/klaviyo/match-service";
import { loadEmailAttribution } from "@/lib/klaviyo/email-attribution";
import {
  listEvidenceOrders,
  listUnmatchedEvents,
  loadEvidenceCoverage,
  loadOrderClaims,
  loadOrderExplanation,
  loadOrderInspector,
  loadOrderJourney,
  loadOrderProducts,
} from "@/lib/klaviyo/queries";
import {
  failReportSync,
  listCurrentReportFacts,
  startOrResumeReportSync,
} from "@/lib/klaviyo/report-repository";
import { startOrResumeOrderCoreSync } from "@/lib/klaviyo/source-runner";
import { klaviyoMatchRuns } from "@/schema/klaviyo-match";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
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

  coverage: orgAdminProcedure
    .input(z.object({ dateFrom: storeDaySchema, dateTo: storeDaySchema }))
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const window = inclusiveStoreDaysToHalfOpenUtc({
        ...input,
        timeZone: connection.storeTimezone,
      });
      return loadEvidenceCoverage({ scope: connection, window });
    }),

  emailAttribution: orgAdminProcedure
    .input(z.object({ dateFrom: storeDaySchema, dateTo: storeDaySchema }))
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const window = inclusiveStoreDaysToHalfOpenUtc({
        ...input,
        timeZone: connection.storeTimezone,
      });
      return loadEmailAttribution({ scope: connection, window, days: input });
    }),

  orders: orgAdminProcedure
    .input(
      z.object({
        dateFrom: storeDaySchema,
        dateTo: storeDaySchema,
        orderStatus: z
          .enum([
            "confirmed",
            "candidate",
            "ambiguous",
            "no_klaviyo_event",
            "duplicate_conversion_events",
            "not_evaluated",
          ])
          .optional(),
        productStatus: z
          .enum(["exact", "partial", "contradictory", "unavailable"])
          .optional(),
        claimType: z
          .enum(["campaign", "flow", "message", "interaction", "none"])
          .optional(),
        channel: z.enum(["email", "sms", "onsite", "unknown"]).optional(),
        bucket: z
          .enum([
            "meta",
            "google",
            "klaviyo",
            "tiktok",
            "ai",
            "organic_direct",
            "unattributed",
            "untracked",
          ])
          .optional(),
        cursor: z.string().nullish(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const window = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        timeZone: connection.storeTimezone,
      });
      return listEvidenceOrders({
        scope: connection,
        window,
        orderStatus: input.orderStatus,
        productStatus: input.productStatus,
        claimType: input.claimType,
        channel: input.channel,
        bucket: input.bucket,
        cursor: input.cursor,
        limit: input.limit,
      });
    }),

  orderExplanation: orgAdminProcedure
    .input(z.object({ orderId: resourceIdSchema }))
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const explanation = await loadOrderExplanation({
        scope: connection,
        orderId: input.orderId,
      });
      if (!explanation) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }
      return explanation;
    }),

  orderProducts: orgAdminProcedure
    .input(
      z.object({
        orderId: resourceIdSchema,
        candidateId: resourceIdSchema.optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const response = await loadOrderProducts({
        scope: connection,
        orderId: input.orderId,
        candidateId: input.candidateId,
      });
      if (response.kind === "not_found") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
      }
      return response;
    }),

  orderJourney: orgAdminProcedure
    .input(
      z.object({
        orderId: resourceIdSchema,
        lookbackDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
      }),
    )
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      return loadOrderJourney({
        scope: connection,
        orderId: input.orderId,
        lookbackDays: input.lookbackDays,
      });
    }),

  orderClaims: orgAdminProcedure
    .input(
      z.object({
        orderId: resourceIdSchema,
        candidateId: resourceIdSchema.optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const response = await loadOrderClaims({
        scope: connection,
        orderId: input.orderId,
        candidateId: input.candidateId ?? null,
      });
      if (response === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
      }
      return response;
    }),

  orderInspector: orgAdminProcedure
    .input(
      z.object({
        orderId: resourceIdSchema,
        candidateId: resourceIdSchema.optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const response = await loadOrderInspector({
        scope: connection,
        orderId: input.orderId,
        candidateId: input.candidateId ?? null,
      });
      if (response === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
      }
      return response;
    }),

  reports: orgAdminProcedure
    .input(
      z.object({
        dateFrom: storeDaySchema,
        dateTo: storeDaySchema,
        kind: z.enum(["campaign", "flow"]),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      // Report calendar days use the bound Klaviyo account timezone
      // (send-date semantics) — never the Shopify store conversion.
      const accountWindow = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        timeZone: connection.accountTimezone ?? "UTC",
      });
      void accountWindow;
      // Facts come only from the requested slot's single current
      // generation; staging, failed, and superseded rows never surface.
      return listCurrentReportFacts({
        scope: connection,
        kind: input.kind,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  refreshReports: orgAdminProcedure
    .input(
      z.object({
        dateFrom: storeDaySchema,
        dateTo: storeDaySchema,
        kinds: z.array(z.enum(["campaign", "flow"])).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      // Inclusive browser calendar dates convert through the connection's
      // account timezone into the half-open internal window (DST-safe).
      const accountTimezone = connection.accountTimezone ?? "UTC";
      const window = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        timeZone: accountTimezone,
      });
      const prepared = await startOrResumeReportSync({
        scope: connection,
        window,
        kinds: input.kinds,
        // The router is the only manual caller; the incremental supervisor
        // alone supplies "scheduled". Browser input never carries reason.
        reason: "manual",
        now: new Date(),
      });
      if (prepared.kind === "fresh") return { kind: "fresh" as const };
      try {
        const idempotencyKey = await idempotencyKeys.create(
          `klaviyo:reports:first:${prepared.syncRunId}`,
          { scope: "global" },
        );
        await tasks.trigger(
          "klaviyo-reports",
          { syncRunId: prepared.syncRunId },
          { idempotencyKey, idempotencyKeyTTL: "7d" },
        );
      } catch {
        try {
          await failReportSync({
            scope: connection,
            syncRunId: prepared.syncRunId,
            now: new Date(),
          });
        } catch {
          // Lease reconciliation covers a finalizer race.
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Klaviyo report handoff failed",
        });
      }
      return {
        kind: prepared.kind,
        syncRunId: prepared.syncRunId,
        stagedKinds: prepared.stagedKinds,
      };
    }),

  unmatchedEvents: orgAdminProcedure
    .input(
      z.object({
        dateFrom: storeDaySchema,
        dateTo: storeDaySchema,
        eventStatus: z
          .enum(["confirmed", "candidate", "ambiguous", "unmatched", "not_evaluated"])
          .optional(),
        channel: z.enum(["email", "sms", "onsite", "unknown"]).optional(),
        cursor: z.string().nullish(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const window = inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        timeZone: connection.storeTimezone,
      });
      return listUnmatchedEvents({
        scope: connection,
        window,
        channel: input.channel,
        eventStatus: input.eventStatus,
        cursor: input.cursor,
        limit: input.limit,
      });
    }),

  recomputeMatches: orgAdminProcedure
    .input(z.object({ dateFrom: storeDaySchema, dateTo: storeDaySchema }))
    .mutation(async ({ input, ctx }) => {
    const connection = await requirePilotConnection(ctx.organizationId);
    // One store-timezone conversion for the browser range; the atomic
    // publication itself still derives its authoritative window from the
    // exact retained source/evidence runs.
    const requestedWindow = inclusiveStoreDaysToHalfOpenUtc({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      timeZone: connection.storeTimezone,
    });
    void requestedWindow;
    const inputs = await selectLatestMatchInputs(connection);
    const payload = {
      invocationFingerprint: inputs.invocationFingerprint,
      connectionId: connection.connectionId,
      sourceRunId: inputs.sourceRunId,
      shopifyEvidenceRunId: inputs.shopifyEvidenceRunId,
      from: inputs.window.from.toISOString(),
      to: inputs.window.to.toISOString(),
      reason: "manual" as const,
    };
    const { triggerRunId, alreadyPublished } = await triggerOrRepairMatchInvocation({
      invocationFingerprint: inputs.invocationFingerprint,
      adapters: {
        async triggerWithKey(key) {
          const idempotencyKey = await idempotencyKeys.create(key, {
            scope: "global",
          });
          const handle = await tasks.trigger("klaviyo-match", payload, {
            idempotencyKey,
            idempotencyKeyTTL: MATCH_INVOCATION_KEY_TTL,
          });
          return { triggerRunId: handle.id };
        },
        async getRunStatus(runId) {
          const run = await runs.retrieve(runId);
          return { status: run.status };
        },
        async verifyPublishedRun(runId) {
          const run = await runs.retrieve(runId);
          const output = run.output as { matchRunId?: string } | undefined;
          if (!output?.matchRunId) return false;
          const [row] = await db
            .select({ id: klaviyoMatchRuns.id })
            .from(klaviyoMatchRuns)
            .where(
              and(
                eq(klaviyoMatchRuns.id, output.matchRunId),
                eq(klaviyoMatchRuns.organizationId, connection.organizationId),
                eq(klaviyoMatchRuns.storeId, connection.storeId),
                eq(klaviyoMatchRuns.connectionId, connection.connectionId),
                eq(
                  klaviyoMatchRuns.invocationFingerprint,
                  inputs.invocationFingerprint,
                ),
                eq(klaviyoMatchRuns.status, "published"),
              ),
            )
            .limit(1);
          return row !== undefined;
        },
      },
    });
    return {
      triggerRunId,
      invocationFingerprint: inputs.invocationFingerprint,
      alreadyPublished,
    };
  }),

  matchInvocationStatus: orgAdminProcedure
    .input(z.object({ triggerRunId: resourceIdSchema }))
    .query(async ({ input, ctx }) => {
      const connection = await requirePilotConnection(ctx.organizationId);
      const run = await runs.retrieve(input.triggerRunId).catch(() => null);
      if (!run || run.taskIdentifier !== "klaviyo-match") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      const payload = run.payload as
        | { connectionId?: string; invocationFingerprint?: string }
        | undefined;
      if (
        !payload?.connectionId ||
        !payload.invocationFingerprint ||
        payload.connectionId !== connection.connectionId
      ) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      const invocationFingerprint = payload.invocationFingerprint;
      const status = run.status.toUpperCase();
      if (
        ["QUEUED", "PENDING", "EXECUTING", "WAITING", "REATTEMPTING", "DELAYED", "FROZEN"].includes(
          status,
        )
      ) {
        return { status: "running" as const, invocationFingerprint };
      }
      if (status === "COMPLETED") {
        const output = run.output as { matchRunId?: string } | undefined;
        if (output?.matchRunId) {
          const [row] = await db
            .select({ id: klaviyoMatchRuns.id })
            .from(klaviyoMatchRuns)
            .where(
              and(
                eq(klaviyoMatchRuns.id, output.matchRunId),
                eq(klaviyoMatchRuns.organizationId, connection.organizationId),
                eq(klaviyoMatchRuns.storeId, connection.storeId),
                eq(klaviyoMatchRuns.connectionId, connection.connectionId),
                eq(
                  klaviyoMatchRuns.invocationFingerprint,
                  invocationFingerprint,
                ),
                eq(klaviyoMatchRuns.status, "published"),
              ),
            )
            .limit(1);
          if (row) {
            return {
              status: "published" as const,
              invocationFingerprint,
              matchRunId: row.id,
            };
          }
        }
      }
      return { status: "failed" as const, invocationFingerprint };
    }),

  uninstall: orgAdminProcedure.mutation(async ({ ctx }) => {
    const connection = await requirePilotConnection(ctx.organizationId);
    return uninstallKlaviyoConnection(connection);
  }),
});
