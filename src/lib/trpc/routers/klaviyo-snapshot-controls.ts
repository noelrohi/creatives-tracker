import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, orgAdminProcedure } from "../init";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { klaviyoConnections } from "@/schema/klaviyo";
import { configureSnapshotDefinition, getSnapshotSyncStatus, listSnapshotRunSummaries, requestSnapshotRefresh, prepareSnapshotRun, loadSnapshotRun } from "@/lib/klaviyo/snapshot-store";
import { dispatchSnapshotRun } from "@/lib/klaviyo/snapshot-dispatch";
import { KLAVIYO_SNAPSHOT_DATASETS, snapshotEventsScopeInputSchema, snapshotCampaignValuesScopeInputSchema } from "@/lib/klaviyo/snapshot-contracts";

const dataset = z.enum(KLAVIYO_SNAPSHOT_DATASETS);
async function connectionScope(organizationId: string, requireReady = false) {
  // No environment binding or credential resolver on administrative paths.
  // Without a public store selector, multiple stored bindings are ambiguous;
  // do not fall through from a disabled binding to an unrelated store.
  const connections = await db.select({
    connectionId: klaviyoConnections.id,
    storeId: klaviyoConnections.storeId,
    status: klaviyoConnections.status,
    accountId: klaviyoConnections.klaviyoAccountId,
  }).from(klaviyoConnections).where(eq(klaviyoConnections.organizationId, organizationId)).limit(2);
  const connection = connections.length === 1 ? connections[0] : null;
  if (!connection || connection.status === "disabled") {
    throw new TRPCError({ code: "NOT_FOUND", message: "Klaviyo connection not configured unambiguously" });
  }
  if (requireReady && (connection.status !== "ready" || !connection.accountId)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ready account-bound Klaviyo connection required" });
  }
  return { organizationId, storeId: connection.storeId, connectionId: connection.connectionId };
}

/** Session owner/admin only; deliberately not exposed as API-key OpenAPI controls. */
export const klaviyoSnapshotControlsRouter = router({
  configure: orgAdminProcedure.input(z.object({
    dataset, dailyEnabled: z.boolean(),
    eventsMetricIds: z.array(z.string().regex(/^[A-Za-z0-9]+$/).max(128)).min(1).max(20).optional(),
    conversionMetricId: z.string().regex(/^[A-Za-z0-9]+$/).max(256).optional(),
    window: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("rolling_days"), rollingDays: z.number().int().min(1).max(365) }).strict(),
      z.object({ mode: z.literal("fixed"), from: z.coerce.date(), to: z.coerce.date() }).strict(),
    ]).optional(),
  }).strict()).mutation(async ({ ctx, input }) => configureSnapshotDefinition({
    ...input, scope: await connectionScope(ctx.organizationId), now: new Date(),
  })),
  refresh: orgAdminProcedure.input(z.object({
    dataset,
    oneOff: z.union([snapshotEventsScopeInputSchema, snapshotCampaignValuesScopeInputSchema]).optional(),
  }).strict()).mutation(async ({ ctx, input }) => {
    const scope = await connectionScope(ctx.organizationId, true);
    const now = new Date();
    // Catalogs need no recurring definition; requesting one never enrolls it.
    const prepared = (input.dataset === "campaigns" || input.dataset === "metrics") && !input.oneOff
      ? await prepareSnapshotRun({ scope, dataset: input.dataset, resolvedScope: { dataset: input.dataset }, triggerType: "manual", definitionId: null, configurationVersion: 0, now })
      : await requestSnapshotRefresh({ ...input, scope, now });
    if (!prepared.snapshotRunId) return { ...prepared, triggerRunId: null };
    try {
      return { ...prepared, ...await dispatchSnapshotRun(prepared.snapshotRunId) };
    } catch {
      // Retain the durable ID: retrying dispatch uses the same global key.
      return { ...prepared, triggerRunId: null, dispatchState: "pending" as const };
    }
  }),
  retryDispatch: orgAdminProcedure.input(z.object({ snapshotRunId: z.string().min(1) }).strict()).mutation(async ({ ctx, input }) => {
    const scope = await connectionScope(ctx.organizationId, true);
    const run = await loadSnapshotRun(input.snapshotRunId).catch(() => null);
    if (!run || run.scope.organizationId !== scope.organizationId || run.scope.storeId !== scope.storeId || run.scope.connectionId !== scope.connectionId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Snapshot run not found" });
    }
    return dispatchSnapshotRun(input.snapshotRunId);
  }),
  status: orgAdminProcedure.query(async ({ ctx }) => getSnapshotSyncStatus(await connectionScope(ctx.organizationId))),
  history: orgAdminProcedure.input(z.object({
    dataset: dataset.optional(), limit: z.number().int().min(1).max(100).default(25),
    cursor: z.object({ startedAt: z.coerce.date(), id: z.string().min(1) }).strict().nullable().default(null),
  }).strict().default({ limit: 25, cursor: null })).query(async ({ ctx, input }) => listSnapshotRunSummaries({
    ...input, scope: await connectionScope(ctx.organizationId),
  })),
});
