"use client";

import { useState } from "react";
import { type ColumnDef, type VisibilityState } from "@tanstack/react-table";
import {
  formatDistanceStrict,
  formatDistanceToNowStrict,
  parseISO,
  format,
} from "date-fns";
import { Calendar, CalendarClock, Loader2, Sparkles, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DataTable, DataTableColumnToggle } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";

type SyncRun = {
  id: string;
  accountName: string;
  triggerType: "scheduled" | "manual_backfill";
  dateFrom: string;
  dateTo: string;
  breakdownsRequested: string[];
  breakdownsCompleted: string[];
  currentPhase: string | null;
  requestedAt: Date;
  startedAt?: Date | null;
  finishedAt: Date | null;
  rowsSynced: number;
  errorMessage: string | null;
  status:
    | "queued"
    | "running"
    | "success"
    | "partial_success"
    | "failed"
    | "cancelled"
    | "stale";
};

interface SyncRunsTableProps {
  runs: SyncRun[];
  hasNextPage?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
}

function getStatusClasses(status: SyncRun["status"]) {
  switch (status) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "partial_success":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "running":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400";
    case "queued":
      return "border-border bg-muted/40 text-muted-foreground";
    case "stale":
      return "border-amber-500/30 bg-amber-500/5 text-amber-600/80 dark:text-amber-400/80";
    case "failed":
    case "cancelled":
      return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400";
    default:
      return "border-border text-muted-foreground";
  }
}

function formatStatus(status: SyncRun["status"]) {
  switch (status) {
    case "partial_success":
      return "Partial";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

function formatPhase(phase: string | null) {
  if (!phase) return null;
  return phase.replaceAll(":", " / ").replaceAll("_", " ");
}

function formatShortDate(ymd: string) {
  try {
    return format(parseISO(ymd), "MMM d");
  } catch {
    return ymd;
  }
}

function formatRelativeShort(value: Date | null | undefined) {
  if (!value) return null;
  return formatDistanceToNowStrict(new Date(value), { addSuffix: false });
}

function formatDuration(run: SyncRun): string | null {
  const start = run.startedAt ?? run.requestedAt;
  const end = run.finishedAt;
  if (!end) {
    if (run.status === "running" || run.status === "queued") return null;
    return null;
  }
  try {
    return formatDistanceStrict(new Date(end), new Date(start));
  } catch {
    return null;
  }
}

const BREAKDOWN_LETTER: Record<string, string> = {
  age: "A",
  gender: "G",
  country: "C",
  device_platform: "D",
};

function renderBreakdowns(run: SyncRun) {
  if (run.breakdownsRequested.length === 0) {
    return (
      <span className="inline-flex items-center rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Base
      </span>
    );
  }

  const completedSet = new Set(run.breakdownsCompleted);

  return (
    <div className="flex items-center gap-0.5">
      {run.breakdownsRequested.map((breakdown) => {
        const done = completedSet.has(breakdown);
        const letter = BREAKDOWN_LETTER[breakdown] ?? breakdown.charAt(0).toUpperCase();
        return (
          <Tooltip key={breakdown}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "inline-flex size-[18px] cursor-help items-center justify-center rounded text-[9px] font-bold uppercase",
                  done
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground/50",
                )}
              >
                {letter}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              {breakdown.replaceAll("_", " ")} · {done ? "complete" : "pending"}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

const columns: ColumnDef<SyncRun>[] = [
  {
    id: "accountName",
    accessorKey: "accountName",
    header: "Account",
    cell: ({ row }) => (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block max-w-[180px] cursor-help truncate text-[13px] font-medium">
            {row.original.accountName}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-[11px]">
          {row.original.accountName}
        </TooltipContent>
      </Tooltip>
    ),
  },
  {
    id: "status",
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const phase = formatPhase(row.original.currentPhase);
      const showPhase =
        (row.original.status === "running" || row.original.status === "queued") && phase;
      return (
        <div className="flex flex-col gap-0.5">
          <span
            className={cn(
              "inline-flex w-fit items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
              getStatusClasses(row.original.status),
            )}
          >
            {row.original.status === "running" && (
              <span className="size-1.5 animate-pulse rounded-full bg-current" />
            )}
            {formatStatus(row.original.status)}
          </span>
          {showPhase && (
            <span className="text-[10px] capitalize text-muted-foreground/70">
              {phase}
            </span>
          )}
        </div>
      );
    },
  },
  {
    id: "triggerType",
    accessorKey: "triggerType",
    header: "Trigger",
    cell: ({ row }) => {
      const isManual = row.original.triggerType === "manual_backfill";
      const Icon = isManual ? User : CalendarClock;
      return (
        <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
          <Icon className="size-3" />
          {isManual ? "Manual" : "Scheduled"}
        </span>
      );
    },
  },
  {
    id: "range",
    header: "Window",
    accessorFn: (row) => `${row.dateFrom} ${row.dateTo}`,
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] tabular-nums">
        <Calendar className="size-3 text-muted-foreground/60" />
        {formatShortDate(row.original.dateFrom)}
        <span className="text-muted-foreground/40">→</span>
        {formatShortDate(row.original.dateTo)}
      </span>
    ),
    enableSorting: false,
  },
  {
    id: "breakdowns",
    header: "Breakdowns",
    accessorFn: (row) => row.breakdownsRequested.join(","),
    cell: ({ row }) => renderBreakdowns(row.original),
    enableSorting: false,
  },
  {
    id: "rowsSynced",
    accessorKey: "rowsSynced",
    header: () => <span className="block text-right">Rows</span>,
    cell: ({ row }) => (
      <span
        className={cn(
          "block text-right tabular-nums",
          row.original.rowsSynced === 0
            ? "text-muted-foreground/50"
            : "text-foreground",
        )}
      >
        {row.original.rowsSynced === 0
          ? "—"
          : row.original.rowsSynced.toLocaleString()}
      </span>
    ),
  },
  {
    id: "requestedAt",
    accessorKey: "requestedAt",
    header: "Started",
    cell: ({ row }) => {
      const started = row.original.startedAt ?? row.original.requestedAt;
      const relative = formatRelativeShort(started);
      return (
        <span
          className="whitespace-nowrap text-[12px] text-muted-foreground"
          title={new Date(started).toLocaleString()}
        >
          {relative ? `${relative} ago` : "—"}
        </span>
      );
    },
  },
  {
    id: "duration",
    header: "Duration",
    accessorFn: (row) => {
      if (!row.finishedAt) return 0;
      const start = row.startedAt ?? row.requestedAt;
      return new Date(row.finishedAt).getTime() - new Date(start).getTime();
    },
    cell: ({ row }) => {
      const duration = formatDuration(row.original);
      if (duration) {
        return (
          <span className="whitespace-nowrap tabular-nums text-[12px] text-muted-foreground">
            {duration}
          </span>
        );
      }
      if (row.original.status === "running") {
        return (
          <span className="inline-flex items-center gap-1 text-[12px] text-sky-600 dark:text-sky-400">
            <Sparkles className="size-3" />
            running
          </span>
        );
      }
      return <span className="text-muted-foreground/40">—</span>;
    },
  },
  {
    id: "errorMessage",
    accessorKey: "errorMessage",
    header: "Error",
    cell: ({ row }) =>
      row.original.errorMessage ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block max-w-[200px] cursor-help truncate text-[11px] text-rose-600 dark:text-rose-400">
              {row.original.errorMessage}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[400px] text-[11px]">
            {row.original.errorMessage}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-muted-foreground/40">—</span>
      ),
    enableSorting: false,
  },
];

const DEFAULT_VISIBILITY: VisibilityState = {
  errorMessage: false,
};

export function SyncRunsTable({
  runs,
  hasNextPage,
  isLoadingMore,
  onLoadMore,
}: SyncRunsTableProps) {
  const [visibility, setVisibility] = useState<VisibilityState>(DEFAULT_VISIBILITY);

  const hasErrors = runs.some((r) => r.errorMessage);

  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center text-[13px] text-muted-foreground">
        No sync runs yet.
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] tabular-nums text-muted-foreground/60">
            {runs.length} {runs.length === 1 ? "run" : "runs"} loaded
            {hasErrors && (
              <span className="ml-2 text-rose-500">
                · {runs.filter((r) => r.errorMessage).length} with errors
              </span>
            )}
          </span>
          <DataTableColumnToggle
            columns={columns}
            visibility={visibility}
            onVisibilityChange={setVisibility}
          />
        </div>
        <DataTable
          columns={columns}
          data={runs}
          pageSize={10}
          getRowId={(row) => row.id}
          columnVisibility={visibility}
          onColumnVisibilityChange={setVisibility}
        />
        {hasNextPage && onLoadMore && (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-[13px]"
              onClick={onLoadMore}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading
                </>
              ) : (
                "Load older runs"
              )}
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
