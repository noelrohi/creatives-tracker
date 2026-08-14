import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { router, orgAdminProcedure } from "../init";
import { GOOGLE_ADS_API_VERSION } from "@/lib/google-ads/client";
import { accountDay, addDays } from "@/lib/google-ads/facts";
import { prepareGoogleAdsFactsRun } from "@/lib/google-ads/facts-runner";
import {
  failGclidProbeReport,
  prepareGclidProbeRun,
} from "@/lib/google-ads/gclid-probe";
import {
  getGoogleBucketNetSales,
  getLatestGclidProbeReport,
  listCampaignFactsSummary,
} from "@/lib/google-ads/queries";
import {
  connectionScope,
  createGoogleAdsSyncRun,
  ensurePilotGoogleAdsConnection,
  failGoogleAdsSyncRun,
  getPilotGoogleAdsConnectionForOrganization,
  listGoogleAdsSyncRuns,
  type ConnectionRecord,
} from "@/lib/google-ads/sync-store";
import type { GoogleAdsScope } from "@/lib/google-ads/types";

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const BACKFILL_DAYS = 90;

async function requirePilotConnection(
  organizationId: string,
): Promise<ConnectionRecord> {
  const connection = await getPilotGoogleAdsConnectionForOrganization(organizationId);
  if (!connection) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Google Ads pilot connection is not configured",
    });
  }
  return connection;
}

/**
 * The initial-handoff key is taskId + syncRunId with explicit global scope,
 * matching the "first dispatch" idempotency key the nightly schedule uses
 * for facts (`google-ads-facts:first:${run.id}`) — a repeated browser call
 * for the same prepared run resolves the same child instead of double
 * dispatching. If the trigger call itself fails (definitively or
 * ambiguously), the run row must not stay "running" forever and wedge the
 * scope's one-running partial unique index, so it is terminally failed here
 * with the same `trigger_dispatch_failed` code the nightly schedule uses
 * when its own dispatch fails after the run row was already created.
 */
async function triggerGoogleAdsSyncRun(input: {
  scope: GoogleAdsScope;
  syncRunId: string;
  operation: "discovery" | "facts";
  taskId: string;
}): Promise<void> {
  try {
    const idempotencyKey = await idempotencyKeys.create(
      `${input.taskId}:first:${input.syncRunId}`,
      { scope: "global" },
    );
    await tasks.trigger(
      input.taskId,
      { syncRunId: input.syncRunId },
      { idempotencyKey, idempotencyKeyTTL: "7d" },
    );
  } catch {
    try {
      await failGoogleAdsSyncRun({
        scope: input.scope,
        syncRunId: input.syncRunId,
        operation: input.operation,
        error: {
          code: "trigger_dispatch_failed",
          message: `Google Ads ${input.operation} dispatch failed`,
        },
      });
    } catch {
      // The reconciler covers a finalizer race; the safe error still returns.
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Google Ads task handoff failed",
    });
  }
}

export const googleAdsRouter = router({
  health: orgAdminProcedure.query(async ({ ctx }) => {
    const connection = await getPilotGoogleAdsConnectionForOrganization(
      ctx.organizationId,
    );
    if (!connection) return { connection: null, syncRuns: [] };
    const syncRuns = await listGoogleAdsSyncRuns(connection.id);
    return {
      connection: {
        id: connection.id,
        status: connection.status,
        googleCustomerId: connection.googleCustomerId,
        descriptiveName: connection.descriptiveName,
        currencyCode: connection.currencyCode,
        timezone: connection.timezone,
        lastDiscoverySyncedAt: connection.lastDiscoverySyncedAt,
        lastFactsSyncedAt: connection.lastFactsSyncedAt,
        backfillCompletedAt: connection.backfillCompletedAt,
      },
      syncRuns,
    };
  }),

  probeReport: orgAdminProcedure.query(async ({ ctx }) => {
    const connection = await getPilotGoogleAdsConnectionForOrganization(
      ctx.organizationId,
    );
    // The probe is org/store-scoped and can run before any connection
    // exists; resolve the store from the connection when present, else
    // there is no report to show (the probe bootstrap creates the
    // connection's store binding through the same env domain).
    if (!connection) return null;
    return getLatestGclidProbeReport({
      organizationId: connection.organizationId,
      storeId: connection.storeId,
    });
  }),

  campaignFacts: orgAdminProcedure
    .input(z.object({ fromDay: daySchema, toDay: daySchema }))
    .query(async ({ input, ctx }) => {
      if (input.fromDay > input.toDay) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid day range" });
      }
      const connection = await requirePilotConnection(ctx.organizationId);
      const [campaigns, reference] = await Promise.all([
        listCampaignFactsSummary({
          connectionId: connection.id,
          fromDay: input.fromDay,
          toDay: input.toDay,
        }),
        getGoogleBucketNetSales({
          organizationId: connection.organizationId,
          storeId: connection.storeId,
          fromDay: input.fromDay,
          toDay: input.toDay,
        }),
      ]);
      return {
        campaigns,
        googleBucketReference: reference,
        currencyCode: connection.currencyCode,
      };
    }),

  startDiscovery: orgAdminProcedure.mutation(async ({ ctx }) => {
    // Bootstrap resolves the store server-side from the environment binding;
    // reject a session organization that does not own that store.
    const connection = await ensurePilotGoogleAdsConnection();
    if (connection.organizationId !== ctx.organizationId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Google Ads pilot is configured for a different organization",
      });
    }
    const scope = connectionScope(connection);
    const run = await createGoogleAdsSyncRun({
      scope,
      operation: "discovery",
      apiVersion: GOOGLE_ADS_API_VERSION,
    });
    await triggerGoogleAdsSyncRun({
      scope,
      syncRunId: run.id,
      operation: "discovery",
      taskId: "google-ads-discovery",
    });
    return { syncRunId: run.id };
  }),

  startFactsSync: orgAdminProcedure.mutation(async ({ ctx }) => {
    const connection = await requirePilotConnection(ctx.organizationId);
    if (!connection.timezone) {
      // A ready connection always has a discovered timezone; substituting
      // UTC here would silently shift the account-day window instead of
      // surfacing the anomaly, matching the nightly schedule's skip
      // discipline for the same condition.
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Google Ads connection has no timezone; run discovery first",
      });
    }
    const yesterday = addDays(accountDay(new Date(), connection.timezone), -1);
    const run = await prepareGoogleAdsFactsRun({
      organizationId: ctx.organizationId,
      windowFromDay: addDays(yesterday, -(BACKFILL_DAYS - 1)),
      windowToDay: yesterday,
    });
    await triggerGoogleAdsSyncRun({
      scope: {
        organizationId: run.organizationId,
        storeId: run.storeId,
        connectionId: run.connectionId,
      },
      syncRunId: run.id,
      operation: "facts",
      taskId: "google-ads-facts-batch",
    });
    return { syncRunId: run.id };
  }),

  runProbe: orgAdminProcedure.mutation(async ({ ctx }) => {
    const report = await prepareGclidProbeRun();
    if (report.organizationId !== ctx.organizationId) {
      // The report row was minted for the configured store's org; an
      // unrelated org's admin cannot claim it. The orphaned running row is
      // visible to (and re-runnable by) the owning org's admins.
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Google Ads pilot is configured for a different organization",
      });
    }
    try {
      const idempotencyKey = await idempotencyKeys.create(
        `gclid-probe:first:${report.id}`,
        { scope: "global" },
      );
      await tasks.trigger(
        "gclid-probe",
        { probeReportId: report.id },
        { idempotencyKey, idempotencyKeyTTL: "7d" },
      );
    } catch {
      try {
        await failGclidProbeReport({
          probeReportId: report.id,
          code: "trigger_dispatch_failed",
          message: "gclid probe dispatch failed",
        });
      } catch {
        // The reconciler covers a finalizer race; the safe error still returns.
      }
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Google Ads task handoff failed",
      });
    }
    return { probeReportId: report.id };
  }),
});
