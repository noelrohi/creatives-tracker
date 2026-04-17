import { and, desc, eq, or, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { adAccounts } from "@/schema/account";
import { accountSyncRuns, orgSyncRuns } from "@/schema/sync-run";

type SyncRunCursor = { requestedAt: Date; id: string };

export function encodeSyncRunCursor(cursor: SyncRunCursor): string {
  return `${cursor.requestedAt.toISOString()}|${cursor.id}`;
}

export function decodeSyncRunCursor(value: string): SyncRunCursor | null {
  const separator = value.indexOf("|");
  if (separator < 0) return null;
  const timestamp = new Date(value.slice(0, separator));
  if (Number.isNaN(timestamp.getTime())) return null;
  const id = value.slice(separator + 1);
  if (!id) return null;
  return { requestedAt: timestamp, id };
}

export const SYNC_TRIGGER_TYPES = ["scheduled", "manual_backfill"] as const;
export type SyncTriggerType = (typeof SYNC_TRIGGER_TYPES)[number];

export const ACCOUNT_SYNC_RESULTS = [
  "success",
  "partial_success",
  "failed",
  "cancelled",
] as const;
export type AccountSyncResult = (typeof ACCOUNT_SYNC_RESULTS)[number];

export const ACCOUNT_SYNC_STATUSES = [
  "queued",
  "running",
  "success",
  "partial_success",
  "failed",
  "cancelled",
  "stale",
] as const;
export type AccountSyncStatus = (typeof ACCOUNT_SYNC_STATUSES)[number];

export const SYNC_RUN_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

type AccountSyncRunRow = typeof accountSyncRuns.$inferSelect;

export function deriveAccountSyncRunStatus(
  run: Pick<AccountSyncRunRow, "requestedAt" | "startedAt" | "finishedAt" | "result">,
  now = Date.now(),
): AccountSyncStatus {
  if (!run.startedAt && !run.finishedAt) {
    return "queued";
  }

  if (run.startedAt && !run.finishedAt) {
    return now - new Date(run.startedAt).getTime() > SYNC_RUN_STALE_AFTER_MS
      ? "stale"
      : "running";
  }

  switch (run.result) {
    case "success":
    case "partial_success":
    case "failed":
    case "cancelled":
      return run.result;
    default:
      return "failed";
  }
}

export async function createOrgSyncRun(input: {
  organizationId: string;
  triggerType: SyncTriggerType;
  meta?: Record<string, unknown>;
}) {
  const [run] = await db.insert(orgSyncRuns).values({
    organizationId: input.organizationId,
    triggerType: input.triggerType,
    meta: input.meta,
  }).returning();

  return run;
}

export async function createAccountSyncRun(input: {
  orgSyncRunId?: string;
  organizationId: string;
  accountId: string;
  triggerType: SyncTriggerType;
  dateFrom: string;
  dateTo: string;
  breakdownsRequested: string[];
  meta?: Record<string, unknown>;
}) {
  const [run] = await db.insert(accountSyncRuns).values({
    orgSyncRunId: input.orgSyncRunId,
    organizationId: input.organizationId,
    accountId: input.accountId,
    triggerType: input.triggerType,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    breakdownsRequested: input.breakdownsRequested,
    breakdownsCompleted: [],
    meta: input.meta,
  }).returning();

  return run;
}

export async function findLatestRunningAccountSyncRun(input: {
  organizationId: string;
  accountId: string;
}) {
  const runs = await db
    .select()
    .from(accountSyncRuns)
    .where(
      and(
        eq(accountSyncRuns.organizationId, input.organizationId),
        eq(accountSyncRuns.accountId, input.accountId),
      ),
    )
    .orderBy(desc(accountSyncRuns.requestedAt))
    .limit(10);

  const activeRun = runs.find((run) => {
    const status = deriveAccountSyncRunStatus(run);
    return status === "running" || status === "stale";
  });

  return activeRun ?? null;
}

export async function updateAccountSyncRun(input: {
  id: string;
  currentPhase?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  result?: AccountSyncResult | null;
  rowsSynced?: number;
  breakdownsCompleted?: string[];
  errorMessage?: string | null;
  meta?: Record<string, unknown> | null;
}) {
  const [run] = await db.update(accountSyncRuns).set({
    ...(input.currentPhase !== undefined ? { currentPhase: input.currentPhase } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.rowsSynced !== undefined ? { rowsSynced: input.rowsSynced } : {}),
    ...(input.breakdownsCompleted !== undefined
      ? { breakdownsCompleted: input.breakdownsCompleted }
      : {}),
    ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  }).where(eq(accountSyncRuns.id, input.id)).returning();

  return run;
}

export async function refreshOrgSyncRunAggregate(orgSyncRunId: string) {
  const runs = await db
    .select({
      id: accountSyncRuns.id,
      finishedAt: accountSyncRuns.finishedAt,
      result: accountSyncRuns.result,
    })
    .from(accountSyncRuns)
    .where(eq(accountSyncRuns.orgSyncRunId, orgSyncRunId));

  if (runs.length === 0) {
    return null;
  }

  if (runs.some((run) => !run.finishedAt)) {
    return null;
  }

  const results = runs.map((run) => run.result);
  const allSuccess = results.every((result) => result === "success");
  const allFailedOrCancelled = results.every(
    (result) => result === "failed" || result === "cancelled",
  );
  const aggregateResult = allSuccess
    ? "success"
    : allFailedOrCancelled
      ? "failed"
      : "partial_success";

  const [updated] = await db.update(orgSyncRuns).set({
    finishedAt: new Date(),
    result: aggregateResult,
    meta: {
      accountRunCount: runs.length,
      successfulCount: results.filter((result) => result === "success").length,
      failedCount: results.filter((result) => result === "failed").length,
      partialCount: results.filter((result) => result === "partial_success").length,
      cancelledCount: results.filter((result) => result === "cancelled").length,
    },
  }).where(eq(orgSyncRuns.id, orgSyncRunId)).returning();

  return updated;
}

export async function listRecentAccountSyncRuns(input: {
  organizationId: string;
  accountId?: string;
  limit: number;
  cursor?: string | null;
}) {
  const conditions = [eq(accountSyncRuns.organizationId, input.organizationId)];
  if (input.accountId) {
    conditions.push(eq(accountSyncRuns.accountId, input.accountId));
  }

  const cursor = input.cursor ? decodeSyncRunCursor(input.cursor) : null;
  if (cursor) {
    conditions.push(
      or(
        lt(accountSyncRuns.requestedAt, cursor.requestedAt),
        and(
          eq(accountSyncRuns.requestedAt, cursor.requestedAt),
          sql`${accountSyncRuns.id} < ${cursor.id}`,
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      id: accountSyncRuns.id,
      orgSyncRunId: accountSyncRuns.orgSyncRunId,
      organizationId: accountSyncRuns.organizationId,
      accountId: accountSyncRuns.accountId,
      accountName: adAccounts.name,
      triggerType: accountSyncRuns.triggerType,
      dateFrom: accountSyncRuns.dateFrom,
      dateTo: accountSyncRuns.dateTo,
      breakdownsRequested: accountSyncRuns.breakdownsRequested,
      breakdownsCompleted: accountSyncRuns.breakdownsCompleted,
      currentPhase: accountSyncRuns.currentPhase,
      requestedAt: accountSyncRuns.requestedAt,
      startedAt: accountSyncRuns.startedAt,
      finishedAt: accountSyncRuns.finishedAt,
      result: accountSyncRuns.result,
      rowsSynced: accountSyncRuns.rowsSynced,
      errorMessage: accountSyncRuns.errorMessage,
    })
    .from(accountSyncRuns)
    .innerJoin(adAccounts, eq(accountSyncRuns.accountId, adAccounts.id))
    .where(and(...conditions))
    .orderBy(desc(accountSyncRuns.requestedAt), desc(accountSyncRuns.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const tail = page[page.length - 1];
  const nextCursor = hasMore && tail
    ? encodeSyncRunCursor({ requestedAt: tail.requestedAt, id: tail.id })
    : null;

  return { runs: page, nextCursor };
}
