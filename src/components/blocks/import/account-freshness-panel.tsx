"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow, parseISO, format } from "date-fns";
import { Loader2, CloudDownload, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MetaSyncCard } from "@/components/meta-sync-status";

const BREAKDOWN_ORDER = ["age", "gender", "country", "device_platform"] as const;
const BREAKDOWN_LABEL: Record<(typeof BREAKDOWN_ORDER)[number], string> = {
  age: "Age",
  gender: "Gender",
  country: "Country",
  device_platform: "Device",
};
const BREAKDOWN_LETTER: Record<(typeof BREAKDOWN_ORDER)[number], string> = {
  age: "A",
  gender: "G",
  country: "C",
  device_platform: "D",
};
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const VERY_FRESH_MS = 4 * 60 * 60 * 1000;

type SyncableAccount = {
  accountId: string;
  name: string;
  metaAccountId: string;
  lastSyncedAt: Date | null;
  dataDateEnd: string | null;
  isStale: boolean;
  suggestedDateFrom: string;
  suggestedDateTo: string;
  gapDays: number;
};

type RecentRun = {
  id: string;
  accountId: string;
  breakdownsRequested: string[];
  currentPhase?: string | null;
  result: string | null;
  finishedAt: Date | null;
  status: string;
};

type SyncPhase = "idle" | "requesting" | "processing" | "downloading" | "importing" | "done";

type ActiveSync = {
  accountId: string;
  phase: SyncPhase;
  progress: number;
} | null;

interface AccountFreshnessPanelProps {
  accounts: SyncableAccount[];
  recentRuns: RecentRun[];
  activeSync: ActiveSync;
  onSync: (account: SyncableAccount) => void;
  isSyncDisabled?: boolean;
  isLoading: boolean;
}

function freshBreakdowns(accountId: string, runs: RecentRun[]) {
  const fresh = new Set<string>();
  const now = Date.now();
  for (const run of runs) {
    if (run.accountId !== accountId) continue;
    if (run.result !== "success") continue;
    if (!run.finishedAt) continue;
    if (now - new Date(run.finishedAt).getTime() > FRESH_WINDOW_MS) continue;
    for (const breakdown of run.breakdownsRequested) {
      fresh.add(breakdown);
    }
  }
  return fresh;
}

function phaseLabel(phase: SyncPhase, progress: number) {
  switch (phase) {
    case "requesting":
      return "Requesting report…";
    case "processing":
      return progress > 0 ? `Generating ${progress}%` : "Generating report…";
    case "downloading":
      return "Downloading…";
    case "importing":
      return "Importing…";
    default:
      return "Syncing…";
  }
}

function runPhaseLabel(run: RecentRun) {
  if (run.status === "queued") return "Queued in background";
  if (!run.currentPhase) return "Running in background";
  return run.currentPhase.replaceAll("_", " ");
}

function latestActiveRun(accountId: string, runs: RecentRun[]) {
  return runs.find(
    (run) =>
      run.accountId === accountId &&
      (run.status === "queued" || run.status === "running"),
  ) ?? null;
}

function activeProgressWidth(activeSync: NonNullable<ActiveSync>) {
  switch (activeSync.phase) {
    case "processing":
      return activeSync.progress > 0 ? `${activeSync.progress}%` : undefined;
    case "requesting":
      return "8%";
    case "downloading":
      return "75%";
    case "importing":
      return "90%";
    case "done":
      return "100%";
    default:
      return "4%";
  }
}

function formatRelative(date: Date | null) {
  if (!date) return "never";
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}

function formatShortDate(ymd: string) {
  try {
    return format(parseISO(ymd), "MMM d");
  } catch {
    return ymd;
  }
}

function useCurrentTime(tickMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

function freshnessDotClass(account: SyncableAccount, nowMs: number) {
  if (!account.lastSyncedAt) return "bg-muted-foreground/30";
  const age = nowMs - new Date(account.lastSyncedAt).getTime();
  if (account.isStale) return "bg-rose-500";
  if (age < VERY_FRESH_MS) return "bg-emerald-500";
  if (age < FRESH_WINDOW_MS) return "bg-amber-400";
  return "bg-muted-foreground/40";
}

export function AccountFreshnessPanel({
  accounts,
  recentRuns,
  activeSync,
  onSync,
  isSyncDisabled = false,
  isLoading,
}: AccountFreshnessPanelProps) {
  const nowMs = useCurrentTime(60_000);

  if (isLoading && accounts.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 px-3 py-3 text-[13px] text-muted-foreground">
        Loading accounts…
      </div>
    );
  }

  if (accounts.length === 0) {
    return null;
  }

  const someSyncing = activeSync !== null || isSyncDisabled;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex gap-4">
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border/60">
          <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-3 py-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-medium">Accounts</h2>
              <span className="text-[11px] text-muted-foreground/70">
                {accounts.length} · click sync for background import
              </span>
            </div>
            <div className="flex items-center gap-2.5 text-[10px] text-muted-foreground/60">
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                fresh
              </span>
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-amber-400" />
                aging
              </span>
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-rose-500" />
                stale
              </span>
            </div>
          </div>

        <ul className="divide-y divide-border/40">
          {accounts.map((account) => {
            const fresh = freshBreakdowns(account.accountId, recentRuns);
            const activeRun = latestActiveRun(account.accountId, recentRuns);
            const isClientActive = activeSync?.accountId === account.accountId;
            const isActive = isClientActive || activeRun !== null;
            const dotClass = isActive
              ? "bg-primary animate-pulse"
              : freshnessDotClass(account, nowMs);

            return (
              <li
                key={account.accountId}
                className={cn(
                  "group relative grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-3 py-2 transition-colors",
                  isActive && "bg-muted/30",
                )}
              >
                <span
                  className={cn("size-2 rounded-full shrink-0", dotClass)}
                  aria-hidden
                />

                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help truncate text-[13px] font-medium">
                        {account.name}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start" className="text-[11px]">
                      <div className="font-medium">{account.name}</div>
                      <div className="text-muted-foreground">
                        Meta ID {account.metaAccountId}
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        Window {account.suggestedDateFrom} → {account.suggestedDateTo}
                      </div>
                    </TooltipContent>
                  </Tooltip>

                  {account.isStale && !isActive && (
                    <span className="rounded bg-rose-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
                      stale
                    </span>
                  )}

                  <span className="text-[11px] text-muted-foreground/70">
                    {isClientActive ? (
                      <span className="font-medium text-foreground/80">
                        {phaseLabel(activeSync.phase, activeSync.progress)}
                      </span>
                    ) : activeRun ? (
                      <span className="font-medium capitalize text-foreground/80">
                        {runPhaseLabel(activeRun)}
                      </span>
                    ) : (
                      <>
                        {formatRelative(account.lastSyncedAt)}
                        {account.dataDateEnd && (
                          <>
                            <span className="mx-1 text-muted-foreground/40">·</span>
                            through {formatShortDate(account.dataDateEnd)}
                          </>
                        )}
                      </>
                    )}
                  </span>

                  {account.gapDays >= 30 && !isActive && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex cursor-help items-center gap-0.5 rounded bg-amber-500/10 px-1 py-px text-[9px] font-medium text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="size-2.5" strokeWidth={2.5} />
                          30d cap
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="text-[11px]">
                        Account is more than 30 days stale. Only the last 30 days will sync in this run.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>

                <div className="flex items-center gap-0.5" aria-label="Demographic breakdown freshness">
                  {BREAKDOWN_ORDER.map((breakdown) => {
                    const isFresh = fresh.has(breakdown);
                    return (
                      <Tooltip key={breakdown}>
                        <TooltipTrigger asChild>
                          <span
                            className={cn(
                              "inline-flex size-5 cursor-help items-center justify-center rounded text-[9px] font-bold tabular-nums transition-colors",
                              isFresh
                                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                : "bg-muted text-muted-foreground/40",
                            )}
                          >
                            {BREAKDOWN_LETTER[breakdown]}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-[11px]">
                          {BREAKDOWN_LABEL[breakdown]} ·{" "}
                          {isFresh ? (
                            <span className="text-emerald-500">synced &lt;24h</span>
                          ) : (
                            <span className="text-muted-foreground">
                              not synced recently
                            </span>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>

                <Button
                  size="sm"
                  className="h-7 gap-1.5 text-[13px]"
                  onClick={() => onSync(account)}
                  disabled={someSyncing}
                >
                  {isActive ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <CloudDownload className="size-3.5" />
                  )}
                  {isActive ? "Syncing" : "Sync"}
                </Button>

                {isActive && (
                  <div className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden bg-primary/10">
                    <div
                      className={cn(
                        "h-full bg-primary transition-all duration-500",
                        isClientActive &&
                          activeSync.phase === "processing" &&
                          activeSync.progress === 0 &&
                          "w-1/12 animate-pulse",
                        !isClientActive && "w-1/3 animate-pulse",
                      )}
                      style={{
                        width: isClientActive
                          ? activeProgressWidth(activeSync)
                          : undefined,
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        </div>

        <MetaSyncCard />
      </div>
    </TooltipProvider>
  );
}
