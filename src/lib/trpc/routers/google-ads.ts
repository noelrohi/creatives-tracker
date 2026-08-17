import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { router, orgAdminProcedure } from "../init";
import { requireStore } from "./attribution.shared";
import { GOOGLE_ADS_API_VERSION } from "@/lib/google-ads/client";
import { accountDay, addDays } from "@/lib/google-ads/facts";
import { prepareGoogleAdsFactsRun } from "@/lib/google-ads/facts-runner";
import {
  failGclidProbeReport,
  prepareGclidProbeRun,
  resolvePilotProbeStore,
} from "@/lib/google-ads/gclid-probe";
import {
  getGoogleBucketNetSales,
  getLatestGclidProbeReport,
  listCampaignFactsSummary,
} from "@/lib/google-ads/queries";
import { loadGoogleAdsRevenuePanel } from "@/lib/google-ads/revenue-panel";
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

/** Postgres unique_violation; same detection idiom as facts-runner.ts. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code: unknown }).code) === "23505"
  );
}

/**
 * The initial-handoff key is `${taskId}:first:${syncRunId}` with explicit
 * global scope (e.g. `google-ads-facts-batch:first:<id>`) — a repeated
 * browser call for the same prepared run resolves the same child instead of
 * double dispatching, the same idea behind the nightly schedule's own
 * first-dispatch idempotency key for facts. If the trigger call itself
 * fails (definitively or ambiguously), the run row must not stay "running"
 * forever and wedge the scope's one-running partial unique index, so it is
 * terminally failed here with the same `trigger_dispatch_failed` code the
 * nightly schedule uses when its own dispatch fails after the run row was
 * already created.
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
    // The probe is org/store-scoped and can run before any Google Ads
    // connection exists, so resolve the store directly from the provider's
    // shop-domain binding (mirroring prepareGclidProbeRun) rather than
    // going through a connection row. Any provider/env resolution failure
    // degrades to the connection-based lookup instead of failing this read.
    let store: { id: string; organizationId: string } | null = null;
    try {
      store = await resolvePilotProbeStore();
    } catch {
      store = null;
    }
    if (store) {
      if (store.organizationId !== ctx.organizationId) return null;
      return getLatestGclidProbeReport({
        organizationId: store.organizationId,
        storeId: store.id,
      });
    }
    const connection = await getPilotGoogleAdsConnectionForOrganization(
      ctx.organizationId,
    );
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
    let run: Awaited<ReturnType<typeof createGoogleAdsSyncRun>>;
    try {
      run = await createGoogleAdsSyncRun({
        scope,
        operation: "discovery",
        apiVersion: GOOGLE_ADS_API_VERSION,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A Google Ads discovery run is already in progress",
        });
      }
      throw error;
    }
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
    let run: Awaited<ReturnType<typeof prepareGoogleAdsFactsRun>>;
    try {
      run = await prepareGoogleAdsFactsRun({
        organizationId: ctx.organizationId,
        windowFromDay: addDays(yesterday, -(BACKFILL_DAYS - 1)),
        windowToDay: yesterday,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already running")) {
        throw new TRPCError({ code: "CONFLICT", message });
      }
      throw error;
    }
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
    // Check the org BEFORE any row is created: an unrelated org's admin
    // must never be able to mint (even a terminally-failed) probe report
    // row, since that row would become the pilot org's "latest report" the
    // moment it exists. `store` is null when the shop domain has no store
    // yet — fall through to `prepareGclidProbeRun`, which raises that
    // domain error itself.
    const store = await resolvePilotProbeStore();
    if (store && store.organizationId !== ctx.organizationId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Google Ads pilot is configured for a different organization",
      });
    }
    const report = await prepareGclidProbeRun();
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

  revenuePanel: orgAdminProcedure
    .input(z.object({ dateFrom: daySchema, dateTo: daySchema }))
    .query(async ({ input, ctx }) => {
      if (input.dateFrom > input.dateTo) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid day range" });
      }
      const store = await requireStore(ctx.organizationId);
      return loadGoogleAdsRevenuePanel({
        organizationId: ctx.organizationId,
        storeId: store.id,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
      });
    }),
});
