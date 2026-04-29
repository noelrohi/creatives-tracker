import { TRPCClientError } from "@trpc/client";
import { Command } from "commander";
import { createApiClient, resolveApiKey, resolveApiUrl } from "../client.js";
import { printOutput } from "../output.js";
import { compactObject, parseInteger } from "../utils.js";

const DEFAULT_BREAKDOWNS = [null, "age", "gender", "country", "device_platform"] as const;
const FRESHNESS_WINDOW_HOURS = 4;
const RETRY_DELAY_MS = 5_000;

type Breakdown = Exclude<(typeof DEFAULT_BREAKDOWNS)[number], null>;

type SyncableAccount = {
  accountId: string;
  name: string;
  suggestedDateFrom: string;
  suggestedDateTo: string;
  gapDays: number;
};

type RecentRun = {
  accountId: string;
  accountName: string;
  dateFrom: string;
  dateTo: string;
  breakdownsRequested: string[];
  currentPhase: string | null;
  requestedAt: Date | string;
  finishedAt: Date | string | null;
  rowsSynced: number;
  errorMessage: string | null;
  status: string;
};

type BreakdownResult = {
  importedRows: number;
  failureReason: string | null;
};

type AccountResult = {
  accountName: string;
  dateFrom: string;
  dateTo: string;
  hasThirtyDayCap: boolean;
  rowsSynced: number;
  skippedBreakdowns: string[];
  failures: string[];
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIsoDate(value: string | undefined, optionName: string) {
  if (!value) {
    return undefined;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${optionName} must use YYYY-MM-DD format`);
  }

  return value;
}

function breakdownLabel(breakdown: Breakdown | null) {
  if (breakdown === null) {
    return "base";
  }

  if (breakdown === "device_platform") {
    return "device";
  }

  return breakdown;
}

function arrayEquals(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toTimestamp(value: Date | string | null) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function wasFresh(run: RecentRun, accountId: string, dateFrom: string, dateTo: string, breakdown: Breakdown | null) {
  if (run.accountId !== accountId || run.dateFrom !== dateFrom || run.dateTo !== dateTo) {
    return false;
  }

  if (run.status !== "success") {
    return false;
  }

  const expectedBreakdowns = breakdown ? [breakdown] : [];
  if (!arrayEquals(run.breakdownsRequested, expectedBreakdowns)) {
    return false;
  }

  const finishedAt = toTimestamp(run.finishedAt);
  if (!finishedAt) {
    return false;
  }

  return finishedAt >= Date.now() - FRESHNESS_WINDOW_HOURS * 60 * 60 * 1000;
}

function formatError(error: unknown) {
  if (error instanceof TRPCClientError || error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function withRetry<T>(label: string, action: () => Promise<T>) {
  try {
    return await action();
  } catch (firstError) {
    console.error(`[meta-sync] ${label} failed, retrying once in 5s: ${formatError(firstError)}`);
    await sleep(RETRY_DELAY_MS);
    return action();
  }
}

async function loadRecentRuns(client: ReturnType<typeof createApiClient>, accountId?: string) {
  const runs: RecentRun[] = [];
  let cursor: string | null | undefined = null;

  for (let page = 0; page < 5; page += 1) {
    const result = await withRetry("listRecentRuns", () =>
      client.metaSync.listRecentRuns.query(
        compactObject({
          accountId,
          limit: 100,
          cursor: cursor ?? undefined,
        }),
      ),
    );

    runs.push(...(result.runs as RecentRun[]));
    cursor = result.nextCursor;

    if (!cursor) {
      break;
    }
  }

  return runs;
}

async function waitForReady(
  client: ReturnType<typeof createApiClient>,
  syncRunId: string,
  pollIntervalSeconds: number,
  pollTimeoutPolls: number,
) {
  for (let pollCount = 0; pollCount < pollTimeoutPolls; pollCount += 1) {
    const result = await withRetry("pollReport", () =>
      client.metaSync.pollReport.query({ syncRunId }),
    );

    if (result.phase === "ready" && result.ready) {
      return { ok: true as const };
    }

    if (result.phase === "failed") {
      return {
        ok: false as const,
        reason: result.errorMessage ?? "Meta reported a failure while generating the report",
      };
    }

    if (pollCount < pollTimeoutPolls - 1) {
      await sleep(pollIntervalSeconds * 1_000);
    }
  }

  return { ok: false as const, reason: `timeout after ${pollTimeoutPolls * pollIntervalSeconds}s` };
}

async function importUntilDone(client: ReturnType<typeof createApiClient>, syncRunId: string) {
  let cursor: string | null | undefined;
  let totalImported = 0;

  while (true) {
    const result = await withRetry("importReport", () =>
      client.metaSync.importReport.mutate({
        syncRunId,
        cursor: cursor ?? null,
      }),
    );

    totalImported = result.totalImported;

    if (result.done) {
      return totalImported;
    }

    cursor = result.nextCursor;
  }
}

async function enrichAccount(
  client: ReturnType<typeof createApiClient>,
  accountId: string,
  enrichLimit: number,
) {
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const result = await withRetry("enrichPreviews", () =>
      client.metaSync.enrichPreviews.mutate({
        accountId,
        limit: enrichLimit,
      }),
    );

    if (result.remaining <= 0) {
      return;
    }
  }
}

function summarizeAccount(result: AccountResult) {
  const windowLabel = `${result.dateFrom} -> ${result.dateTo}${result.hasThirtyDayCap ? ", 30-day cap" : ""}`;
  const prefix = `- **${result.accountName}** (${windowLabel}): ${result.rowsSynced.toLocaleString()} rows`;

  if (result.failures.length === 0 && result.skippedBreakdowns.length === 0) {
    return `${prefix}, all breakdowns \u2713`;
  }

  const details: string[] = [];
  if (result.failures.length > 0) {
    details.push(result.failures.join("; "));
  }
  if (result.skippedBreakdowns.length > 0) {
    details.push(`${result.skippedBreakdowns.join("/")} skipped (fresh, <4h old)`);
  }

  return `${prefix}, ${details.join("; ")}`;
}

async function runSync(
  client: ReturnType<typeof createApiClient>,
  options: {
    accountId?: string;
    dateFrom?: string;
    dateTo?: string;
    enrichLimit: number;
    force?: boolean;
    pollIntervalSeconds: number;
    pollTimeoutPolls: number;
    staleThresholdHours?: number;
  },
) {
  const accounts = (await withRetry("listSyncableAccounts", () =>
    client.metaSync.listSyncableAccounts.query(
      compactObject({
        staleThresholdHours: options.staleThresholdHours,
      }),
    ),
  )) as SyncableAccount[];

  const filteredAccounts = options.accountId
    ? accounts.filter((account) => account.accountId === options.accountId)
    : accounts;

  if (filteredAccounts.length === 0) {
    if (options.accountId) {
      console.log(`No Meta-enabled account found for accountId ${options.accountId}.`);
      return;
    }

    console.log("No Meta-enabled accounts found in the active workspace.");
    return;
  }

  const recentRuns = options.force ? [] : await loadRecentRuns(client, options.accountId);
  const accountResults: AccountResult[] = [];
  let totalRows = 0;
  let failureCount = 0;
  let skippedFreshCount = 0;

  for (const account of filteredAccounts) {
    const dateFrom = options.dateFrom ?? account.suggestedDateFrom;
    const dateTo = options.dateTo ?? account.suggestedDateTo;
    const accountResult: AccountResult = {
      accountName: account.name,
      dateFrom,
      dateTo,
      hasThirtyDayCap: !options.dateFrom && !options.dateTo && account.gapDays === 30,
      rowsSynced: 0,
      skippedBreakdowns: [],
      failures: [],
    };

    for (const breakdown of DEFAULT_BREAKDOWNS) {
      const label = breakdownLabel(breakdown);

      if (!options.force && recentRuns.some((run) => wasFresh(run, account.accountId, dateFrom, dateTo, breakdown))) {
        accountResult.skippedBreakdowns.push(label);
        skippedFreshCount += 1;
        continue;
      }

      console.error(`[meta-sync] ${account.name}: syncing ${label} (${dateFrom} -> ${dateTo})`);

      const breakdownResult: BreakdownResult = await (async () => {
        try {
          const startResult = await withRetry("startReport", () =>
            client.metaSync.startReport.mutate({
              accountId: account.accountId,
              dateFrom,
              dateTo,
              breakdown,
              triggerType: "manual_backfill",
            }),
          );

          const readyResult = await waitForReady(
            client,
            startResult.syncRunId,
            options.pollIntervalSeconds,
            options.pollTimeoutPolls,
          );

          if (!readyResult.ok) {
            return {
              importedRows: 0,
              failureReason: readyResult.reason,
            };
          }

          const importedRows = await importUntilDone(client, startResult.syncRunId);
          return {
            importedRows,
            failureReason: null,
          };
        } catch (error) {
          return {
            importedRows: 0,
            failureReason: formatError(error),
          };
        }
      })();

      accountResult.rowsSynced += breakdownResult.importedRows;

      if (breakdownResult.failureReason) {
        accountResult.failures.push(`${label} failed (${breakdownResult.failureReason})`);
        failureCount += 1;
      }
    }

    try {
      await enrichAccount(client, account.accountId, options.enrichLimit);
    } catch (error) {
      accountResult.failures.push(`preview enrichment failed (${formatError(error)})`);
      failureCount += 1;
    }

    totalRows += accountResult.rowsSynced;
    accountResults.push(accountResult);
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`### Meta sync summary - ${today}`);
  console.log("");
  for (const accountResult of accountResults) {
    console.log(summarizeAccount(accountResult));
  }
  console.log("");
  console.log(
    `**Total:** ${totalRows.toLocaleString()} rows across ${accountResults.length} accounts. ${failureCount} failures, ${skippedFreshCount} skipped as fresh.`,
  );
}

async function triggerSync(
  client: ReturnType<typeof createApiClient>,
  options: {
    accountId?: string;
    dateFrom?: string;
    dateTo?: string;
    force?: boolean;
  },
) {
  const result = await withRetry("triggerMetaSync", () =>
    client.trigger.triggerMetaSync.mutate(
      compactObject({
        accountId: options.accountId,
        dateFrom: options.dateFrom,
        dateTo: options.dateTo,
        force: options.force,
        triggerType:
          options.accountId || options.dateFrom || options.dateTo
            ? "manual_backfill"
            : "scheduled",
      }),
    ),
  );

  console.log(`Queued Trigger.dev Meta sync run: ${result.runId}`);
  console.log("Use `meta-sync history` or the /import page to inspect imported account runs.");
}

async function runHistory(
  client: ReturnType<typeof createApiClient>,
  options: {
    accountId?: string;
    cursor?: string;
    limit?: number;
  },
) {
  const result = await withRetry("listRecentRuns", () =>
    client.metaSync.listRecentRuns.query(
      compactObject({
        accountId: options.accountId,
        cursor: options.cursor,
        limit: options.limit,
      }),
    ),
  );

  const rows = (result.runs as RecentRun[]).map((run) => ({
    account: run.accountName,
    window: `${run.dateFrom} -> ${run.dateTo}`,
    breakdown: run.breakdownsRequested.length === 0 ? "base" : run.breakdownsRequested.join(","),
    status: run.status,
    phase: run.currentPhase ?? "-",
    rowsSynced: run.rowsSynced,
    requestedAt: run.requestedAt instanceof Date ? run.requestedAt.toISOString() : String(run.requestedAt),
    finishedAt:
      run.finishedAt instanceof Date
        ? run.finishedAt.toISOString()
        : run.finishedAt
          ? String(run.finishedAt)
          : "-",
    error: run.errorMessage ?? "-",
  }));

  printOutput(rows, true);
  if (result.nextCursor) {
    console.log(`Next cursor: ${result.nextCursor}`);
  }
}

export function registerMetaSyncCommands(program: Command) {
  const metaSync = program.command("meta-sync").description("Run or inspect Meta sync workflows");

  metaSync
    .command("trigger")
    .description("Queue the Trigger.dev Meta sync task")
    .option("--account-id <accountId>", "Sync only one account")
    .option("--date-from <date>", "Override dateFrom (YYYY-MM-DD)")
    .option("--date-to <date>", "Override dateTo (YYYY-MM-DD)")
    .option("--force", "Ignore the 4-hour freshness skip window")
    .action(async (options, command) => {
      try {
        const apiKey = resolveApiKey(command);
        if (!apiKey) {
          throw new Error("ADSOLUTE_API_KEY is required. Pass --api-key or set it in the environment.");
        }

        const client = createApiClient(resolveApiUrl(command), apiKey);
        await triggerSync(client, {
          accountId: options.accountId,
          dateFrom: parseIsoDate(options.dateFrom, "--date-from"),
          dateTo: parseIsoDate(options.dateTo, "--date-to"),
          force: options.force,
        });
      } catch (error) {
        console.error(formatError(error));
        process.exitCode = 1;
      }
    });

  metaSync
    .command("sync")
    .description("Legacy local sync loop for base and demographic Meta insights")
    .option("--account-id <accountId>", "Sync only one account")
    .option("--date-from <date>", "Override dateFrom (YYYY-MM-DD)")
    .option("--date-to <date>", "Override dateTo (YYYY-MM-DD)")
    .option("--force", "Ignore the 4-hour freshness skip window")
    .option("--stale-threshold-hours <hours>", "Pass a custom stale threshold to listSyncableAccounts", parseInteger)
    .option("--poll-interval-seconds <seconds>", "Seconds between pollReport calls", parseInteger, 10)
    .option("--poll-timeout-polls <count>", "Maximum number of pollReport calls per report", parseInteger, 30)
    .option("--enrich-limit <count>", "Batch size for enrichPreviews", parseInteger, 100)
    .action(async (options, command) => {
      try {
        const apiKey = resolveApiKey(command);
        if (!apiKey) {
          throw new Error("ADSOLUTE_API_KEY is required. Pass --api-key or set it in the environment.");
        }

        const client = createApiClient(resolveApiUrl(command), apiKey);
        await runSync(client, {
          accountId: options.accountId,
          dateFrom: parseIsoDate(options.dateFrom, "--date-from"),
          dateTo: parseIsoDate(options.dateTo, "--date-to"),
          enrichLimit: options.enrichLimit,
          force: options.force,
          pollIntervalSeconds: options.pollIntervalSeconds,
          pollTimeoutPolls: options.pollTimeoutPolls,
          staleThresholdHours: options.staleThresholdHours,
        });
      } catch (error) {
        console.error(formatError(error));
        process.exitCode = 1;
      }
    });

  metaSync
    .command("history")
    .description("Show recent Meta sync runs")
    .option("--account-id <accountId>", "Filter runs by account")
    .option("--limit <count>", "Maximum runs to return", parseInteger, 20)
    .option("--cursor <cursor>", "Opaque cursor from the previous history call")
    .action(async (options, command) => {
      try {
        const apiKey = resolveApiKey(command);
        if (!apiKey) {
          throw new Error("ADSOLUTE_API_KEY is required. Pass --api-key or set it in the environment.");
        }

        const client = createApiClient(resolveApiUrl(command), apiKey);
        await runHistory(client, {
          accountId: options.accountId,
          cursor: options.cursor,
          limit: options.limit,
        });
      } catch (error) {
        console.error(formatError(error));
        process.exitCode = 1;
      }
    });
}
