import { metadata, retry, schedules, task, tags, wait } from "@trigger.dev/sdk";
import { createApiClient, getEnvConfig } from "./client";

const BREAKDOWNS = [null, "age", "gender", "country", "device_platform"] as const;
type Breakdown = Exclude<(typeof BREAKDOWNS)[number], null>;

type SyncableAccount = {
  accountId: string;
  name: string;
  suggestedDateFrom: string;
  suggestedDateTo: string;
  gapDays: number;
};

type RecentRun = {
  accountId: string;
  dateFrom: string;
  dateTo: string;
  breakdownsRequested: string[];
  status: string;
  finishedAt: Date | string | null;
};

type SyncPayload = {
  organizationId: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  force?: boolean;
  triggerType?: "scheduled" | "manual_backfill";
};

type AccountResult = {
  accountName: string;
  dateFrom: string;
  dateTo: string;
  rowsSynced: number;
  skippedBreakdowns: string[];
  failures: string[];
};

function breakdownLabel(breakdown: Breakdown | null) {
  if (breakdown === null) return "base";
  if (breakdown === "device_platform") return "device";
  return breakdown;
}

function metaSyncOrgTag(organizationId: string) {
  return `meta-sync:org:${organizationId}`;
}

function enabledMetaSyncOrganizationIds() {
  return new Set(
    (process.env.ADSOLUTE_META_SYNC_ORGANIZATION_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function filterEnabledOrganizations<T extends { organizationId: string }>(organizations: T[]) {
  const enabledOrganizationIds = enabledMetaSyncOrganizationIds();
  if (enabledOrganizationIds.size === 0) return organizations;
  return organizations.filter((organization) =>
    enabledOrganizationIds.has(organization.organizationId),
  );
}

function toTimestamp(value: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function wasFresh(run: RecentRun, accountId: string, dateFrom: string, dateTo: string, breakdown: Breakdown | null) {
  if (run.accountId !== accountId || run.dateFrom !== dateFrom || run.dateTo !== dateTo) return false;
  if (run.status !== "success") return false;

  const expectedBreakdowns = breakdown ? [breakdown] : [];
  if (run.breakdownsRequested.length !== expectedBreakdowns.length) return false;
  if (expectedBreakdowns.length > 0 && !expectedBreakdowns.every((b, i) => run.breakdownsRequested[i] === b)) return false;

  const finishedAt = toTimestamp(run.finishedAt);
  if (!finishedAt) return false;

  return finishedAt >= Date.now() - 4 * 60 * 60 * 1000;
}

async function loadRecentRuns(client: ReturnType<typeof createApiClient>, accountId?: string) {
  const runs: RecentRun[] = [];
  let cursor: string | null | undefined = null;

  for (let page = 0; page < 5; page += 1) {
    const result = await retry.onThrow(
      () => client.metaSync.listRecentRuns.query({ accountId, limit: 100, cursor: cursor ?? undefined }),
      { maxAttempts: 3 }
    );
    runs.push(...(result.runs as RecentRun[]));
    cursor = result.nextCursor;
    if (!cursor) break;
  }

  return runs;
}

async function waitForReady(client: ReturnType<typeof createApiClient>, syncRunId: string) {
  for (let pollCount = 0; pollCount < 30; pollCount += 1) {
    const result = await retry.onThrow(
      () => client.metaSync.pollReport.query({ syncRunId }),
      { maxAttempts: 3 }
    );

    if (result.phase === "ready" && result.ready) return { ok: true as const };
    if (result.phase === "failed") {
      return { ok: false as const, reason: result.errorMessage ?? "Meta reported a failure" };
    }

    await wait.for({ seconds: 10 });
  }

  return { ok: false as const, reason: "timeout after 300s" };
}

async function importUntilDone(client: ReturnType<typeof createApiClient>, syncRunId: string) {
  let cursor: string | null | undefined;
  let totalImported = 0;

  while (true) {
    const result = await retry.onThrow(
      () => client.metaSync.importReport.mutate({ syncRunId, cursor: cursor ?? null }),
      { maxAttempts: 3 }
    );
    totalImported = result.totalImported;
    if (result.done) return totalImported;
    cursor = result.nextCursor;
  }
}

async function enrichAccount(client: ReturnType<typeof createApiClient>, accountId: string) {
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const result = await retry.onThrow(
      () => client.metaSync.enrichPreviews.mutate({ accountId, limit: 100 }),
      { maxAttempts: 3 }
    );
    if (result.remaining <= 0) return;
  }
}

export const metaSyncTask = task({
  id: "meta-sync",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000 },
  queue: { concurrencyLimit: 1 },
  run: async (payload: SyncPayload) => {
    const { apiUrl, apiKey } = getEnvConfig();
    const client = createApiClient(apiUrl, apiKey, payload.organizationId);

    await tags.add(metaSyncOrgTag(payload.organizationId));

    metadata.set("status", "fetching_accounts");
    const accounts = (await retry.onThrow(
      () => client.metaSync.listSyncableAccounts.query({}),
      { maxAttempts: 3 }
    )) as SyncableAccount[];

    const filteredAccounts = payload.accountId
      ? accounts.filter((a) => a.accountId === payload.accountId)
      : accounts;

    if (filteredAccounts.length === 0) {
      metadata.set("status", "no_accounts");
      return { totalRows: 0, accounts: [], message: "No Meta-enabled accounts found" };
    }

    metadata.set("totalAccounts", filteredAccounts.length);
    metadata.set("status", "loading_recent_runs");

    const recentRuns = payload.force ? [] : await loadRecentRuns(client, payload.accountId);
    const triggerType = payload.triggerType ?? (payload.accountId ? "manual_backfill" : "scheduled");
    const accountResults: AccountResult[] = [];
    let totalRows = 0;

    for (let i = 0; i < filteredAccounts.length; i++) {
      const account = filteredAccounts[i];
      const dateFrom = payload.dateFrom ?? account.suggestedDateFrom;
      const dateTo = payload.dateTo ?? account.suggestedDateTo;

      metadata.set("currentAccount", account.name);
      metadata.set("currentAccountId", account.accountId);
      metadata.set("accountProgress", `${i + 1}/${filteredAccounts.length}`);
      metadata.set("status", "syncing");

      const accountResult: AccountResult = {
        accountName: account.name,
        dateFrom,
        dateTo,
        rowsSynced: 0,
        skippedBreakdowns: [],
        failures: [],
      };

      for (let j = 0; j < BREAKDOWNS.length; j++) {
        const breakdown = BREAKDOWNS[j];
        const label = breakdownLabel(breakdown);

        metadata.set("currentBreakdown", label);
        metadata.set("breakdownProgress", `${j + 1}/${BREAKDOWNS.length}`);

        if (!payload.force && recentRuns.some((run) => wasFresh(run, account.accountId, dateFrom, dateTo, breakdown))) {
          accountResult.skippedBreakdowns.push(label);
          continue;
        }

        try {
          const startResult = await retry.onThrow(
            () => client.metaSync.startReport.mutate({
              accountId: account.accountId,
              dateFrom,
              dateTo,
              breakdown,
              triggerType,
            }),
            { maxAttempts: 3 }
          );

          const readyResult = await waitForReady(client, startResult.syncRunId);
          if (!readyResult.ok) {
            accountResult.failures.push(`${label}: ${readyResult.reason}`);
            continue;
          }

          const importedRows = await importUntilDone(client, startResult.syncRunId);
          accountResult.rowsSynced += importedRows;
        } catch (error) {
          accountResult.failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      metadata.set("currentBreakdown", "enriching");
      try {
        await enrichAccount(client, account.accountId);
      } catch (error) {
        accountResult.failures.push(`enrich: ${error instanceof Error ? error.message : String(error)}`);
      }

      totalRows += accountResult.rowsSynced;
      accountResults.push(accountResult);
    }

    metadata.set("status", "completed");
    metadata.set("totalRows", totalRows);

    return {
      totalRows,
      accounts: accountResults,
      summary: `Synced ${totalRows.toLocaleString()} rows across ${accountResults.length} accounts`,
    };
  },
});

export const metaSyncScheduled = schedules.task({
  id: "meta-sync-scheduled",
  cron: "0 18 * * *", // 2am PHT daily
  run: async () => {
    const { apiUrl, apiKey } = getEnvConfig();
    const client = createApiClient(apiUrl, apiKey);
    const organizations = filterEnabledOrganizations(
      await client.metaSync.listOrganizations.query(),
    );
    const results = [];

    for (const organization of organizations) {
      const result = await metaSyncTask.triggerAndWait({
        organizationId: organization.organizationId,
        triggerType: "scheduled",
      });
      if (!result.ok) {
        throw new Error(`Scheduled sync failed for ${organization.organizationId}: ${result.error}`);
      }
      results.push(result.output);
    }

    return {
      organizations: organizations.length,
      results,
    };
  },
});
