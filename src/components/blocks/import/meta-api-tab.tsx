"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "@/lib/trpc/client";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { AccountFreshnessPanel } from "./account-freshness-panel";
import { SyncRunsTable } from "./sync-runs-table";
import {
  Loader2,
  Key,
  CirclePlus,
  Download,
  CloudDownload,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateOnly, parseDateOnly } from "@/lib/date";
import { cn } from "@/lib/utils";

interface MetaApiTabProps {
  accounts: {
    id: string;
    name: string;
    metaAccountId: string;
    hasMetaAccessToken: boolean;
  }[];
  accountId: string;
  onAccountIdChange: (id: string) => void;
  dateFrom: string;
  onDateFromChange: (value: string) => void;
  dateTo: string;
  onDateToChange: (value: string) => void;
  onRequestCreateAccount: () => void;
}

function downloadCsv(rows: Record<string, unknown>[], filename: string) {
  if (rows.length === 0) return;

  const headers = Object.keys(rows[0]!);
  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"`
      : v;

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((h) => escape(String(row[h] ?? ""))).join(","),
    ),
  ];

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function MetaApiTab({
  accounts,
  accountId,
  onAccountIdChange,
  dateFrom,
  onDateFromChange,
  dateTo,
  onDateToChange,
  onRequestCreateAccount,
}: MetaApiTabProps) {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  const apiAccounts = accounts.filter((a) => a.hasMetaAccessToken);

  const [exporting, setExporting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const syncableAccounts = useQuery({
    ...trpc.metaSync.listSyncableAccounts.queryOptions(),
    enabled: apiAccounts.length > 0,
  });

  const runsQuery = useQuery({
    queryKey: ["metaSync", "listRecentRuns", { limit: 100 }],
    queryFn: () => trpcClient.metaSync.listRecentRuns.query({ limit: 100 }),
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasActive = data?.runs.some(
        (run) => run.status === "queued" || run.status === "running",
      ) ?? false;
      return hasActive ? 15000 : false;
    },
  });

  const runs = runsQuery.data?.runs ?? [];
  const hasActiveBackgroundRun = runs.some(
    (run) => run.status === "queued" || run.status === "running",
  );

  const triggerSync = useMutation(
    trpc.trigger.triggerMetaSync.mutationOptions({
      onSuccess: () => {
        toast.success("Meta sync queued in Trigger.dev.");
        void runsQuery.refetch();
        void queryClient.invalidateQueries({
          queryKey: trpc.metaSync.listSyncableAccounts.queryKey(),
        });
      },
      onError: (err) => {
        toast.error(getUserFacingErrorMessage(err, "Failed to queue sync."));
      },
    }),
  );

  function runSync(input: {
    accountId: string;
    dateFrom: string;
    dateTo: string;
    force?: boolean;
  }) {
    triggerSync.mutate({
      ...input,
      triggerType: "manual_backfill",
    });
  }

  async function handleExport() {
    if (!accountId) {
      toast.error("Select an account first.");
      return;
    }

    setExporting(true);
    try {
      const rows = await trpcClient.performanceLog.exportByAccount.query({
        accountId,
        dateFrom,
        dateTo,
      });

      if (rows.length === 0) {
        toast.info("No data found for the selected date range.");
        return;
      }

      downloadCsv(rows, `metrics_${dateFrom}_${dateTo}.csv`);
      toast.success(`Exported ${rows.length.toLocaleString()} rows`);
    } catch (err) {
      toast.error(getUserFacingErrorMessage(err, "Export failed."));
    } finally {
      setExporting(false);
    }
  }

  const isSyncing = triggerSync.isPending || hasActiveBackgroundRun;

  if (apiAccounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
        <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-muted">
          <Key className="size-5 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-medium">No accounts with API access</h3>
        <p className="mt-1 max-w-xs text-sm text-muted-foreground">
          {accounts.length === 0
            ? "Create an ad account with an access token to pull data from the Meta Marketing API."
            : "Add an access token to one of your accounts to use the Meta Marketing API."}
        </p>
        <Button onClick={onRequestCreateAccount} className="mt-4" size="sm">
          <CirclePlus className="size-4" />
          {accounts.length === 0 ? "Create account" : "Add account with token"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <AccountFreshnessPanel
        accounts={syncableAccounts.data ?? []}
        recentRuns={runs}
        activeSync={null}
        isSyncDisabled={isSyncing}
        isLoading={syncableAccounts.isLoading}
        onSync={(account) => {
          void runSync({
            accountId: account.accountId,
            dateFrom: account.suggestedDateFrom,
            dateTo: account.suggestedDateTo,
          });
        }}
      />

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/40"
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform",
                advancedOpen && "rotate-90",
              )}
            />
            <span className="font-medium text-foreground/80">Advanced</span>
            <span className="text-muted-foreground/70">·</span>
            <span>custom range &amp; export</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/60 bg-muted/10 px-3 py-2.5">
            <div className="flex min-w-[180px] flex-1 flex-col gap-1">
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Account
              </label>
              <Select
                value={accountId}
                onValueChange={onAccountIdChange}
                disabled={isSyncing}
              >
                <SelectTrigger className="h-7 text-[13px]">
                  <SelectValue placeholder="Select account…" />
                </SelectTrigger>
                <SelectContent>
                  {apiAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="text-[13px]">{a.name}</span>
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {a.metaAccountId}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex min-w-[220px] flex-1 flex-col gap-1">
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Date range
              </label>
              <DateRangePicker
                from={parseDateOnly(dateFrom)}
                to={parseDateOnly(dateTo)}
                onChange={(range) => {
                  if (range?.from) onDateFromChange(formatDateOnly(range.from));
                  if (range?.to) onDateToChange(formatDateOnly(range.to));
                }}
              />
            </div>

            <div className="flex items-end gap-1.5">
              <Button
                size="sm"
                className="h-7 gap-1.5 text-[13px]"
                onClick={() => {
                  if (!accountId) {
                    toast.error("Select an account first.");
                    return;
                  }
                  void runSync({ accountId, dateFrom, dateTo, force: true });
                }}
                disabled={isSyncing || exporting || !accountId}
              >
                {isSyncing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <CloudDownload className="size-3.5" />
                )}
                {isSyncing ? "Syncing" : "Sync window"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-[13px]"
                onClick={handleExport}
                disabled={isSyncing || exporting || !accountId}
              >
                {exporting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {exporting ? "Exporting" : "Export CSV"}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-medium">Sync runs</h2>
            <span className="text-[11px] text-muted-foreground/70">
              Background &amp; scheduled · manual syncs not shown
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <span
              className={cn(
                "size-1.5 rounded-full",
                hasActiveBackgroundRun
                  ? "bg-emerald-500 animate-pulse"
                  : "bg-muted-foreground/30",
              )}
              aria-hidden
            />
            <span>
              {hasActiveBackgroundRun ? "Live · refreshing" : "Idle"}
            </span>
          </div>
        </div>
        <SyncRunsTable runs={runs} />
      </div>
    </div>
  );
}
