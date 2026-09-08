"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ledger as copy } from "../copy";
import {
  formatCount,
  formatCurrency,
  formatPercent,
  formatSentDay,
} from "./ledger-format";
import type {
  LedgerLevel,
  LedgerMessageData,
  LedgerRowData,
} from "./ledger-types";

// Mirrors the Meta ledger's density so the two tables read identically.
export const ROW_HEIGHT = "h-[29px]";
export const CELL = "px-2 py-0 text-[13px]";
export const NUMERIC_CELL = `${CELL} text-right font-mono tabular-nums`;
export const METRIC_COLUMN = "w-[84px]";
// chevron · name · sent · 8 metrics.
export const LEDGER_COLUMN_COUNT = 11;

const LEVEL_CHIPS: Record<LedgerLevel, { label: string; className: string }> = {
  campaign: { label: copy.chips.campaign, className: "bg-primary/15 text-primary" },
  flow: {
    label: copy.chips.flow,
    className: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
  message: { label: "", className: "" },
};

const LEVEL_STRIPES: Record<LedgerLevel, string> = {
  campaign: "before:bg-primary/70",
  flow: "before:bg-violet-500/70",
  message: "before:bg-border",
};

type RowShape = LedgerRowData | LedgerMessageData;

function isParent(row: RowShape): row is LedgerRowData {
  return "sentAt" in row;
}

/** Message rows show the channel chip only; parents show level + channel. */
function chipsFor(row: RowShape, level: LedgerLevel) {
  const chips: Array<{ label: string; className: string }> = [];
  if (level !== "message") chips.push(LEVEL_CHIPS[level]);
  if (row.channel === "email" || row.channel === "sms") {
    chips.push({
      label: row.channel === "email" ? copy.chips.email : copy.chips.sms,
      className: "bg-muted text-muted-foreground",
    });
  }
  return chips;
}

export function LedgerRow({
  row,
  level,
  expandable = false,
  isExpanded = false,
  onToggle,
  onOpen,
}: {
  row: RowShape;
  level: LedgerLevel;
  expandable?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  onOpen?: () => void;
}) {
  const sent = isParent(row) ? formatSentDay(row.sentAt) : null;
  const sentLabel = isParent(row)
    ? (sent ?? (row.objectType === "flow" ? copy.ongoing : "—"))
    : "";
  return (
    <TableRow
      className={cn(
        ROW_HEIGHT,
        "group",
        onOpen && "cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none",
      )}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `Open ${row.name}` : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!onOpen || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <TableCell
        className={cn(CELL, "w-7")}
        onClick={(event) => event.stopPropagation()}
      >
        {expandable && onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
            className="flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")}
            />
          </button>
        ) : null}
      </TableCell>
      <TableCell
        className={cn(
          CELL,
          "relative before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-['']",
          LEVEL_STRIPES[level],
          level === "message" && "pl-6",
        )}
      >
        <div className="flex items-center gap-2">
          {chipsFor(row, level).map((chip) => (
            <Badge
              key={chip.label}
              variant="secondary"
              className={cn(
                "h-4 shrink-0 rounded px-1 font-mono text-[9px] tracking-wider",
                chip.className,
              )}
            >
              {chip.label}
            </Badge>
          ))}
          <span className="truncate">{row.name}</span>
          {!isParent(row) && row.subject ? (
            <span className="truncate text-[11px] text-muted-foreground">
              · {row.subject}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className={cn(CELL, "w-16 text-muted-foreground")}>
        {sentLabel}
      </TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>
        {formatCount(row.klaviyo?.recipients ?? null)}
      </TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>
        {formatPercent(row.rates.delivered)}
      </TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>
        {formatPercent(row.rates.open)}
      </TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>
        {formatPercent(row.rates.click)}
      </TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>
        {formatCount(row.orderCount)}
      </TableCell>
      <TableCell className={cn(NUMERIC_CELL, METRIC_COLUMN)}>
        {formatCurrency(row.revenue)}
      </TableCell>
      <TableCell
        className={cn(NUMERIC_CELL, METRIC_COLUMN, "text-muted-foreground")}
      >
        {formatCurrency(row.klaviyo?.conversionValue ?? null)}
      </TableCell>
      <TableCell
        className={cn(
          NUMERIC_CELL,
          METRIC_COLUMN,
          (row.klaviyo?.unsubscribes ?? 0) > 0 && "text-amber-600",
        )}
      >
        {formatCount(row.klaviyo?.unsubscribes ?? null)}
      </TableCell>
    </TableRow>
  );
}

/** One skeleton child row at the exact row height while a messages query runs. */
export function LedgerChildSkeletonRow() {
  return (
    <TableRow className={ROW_HEIGHT}>
      <TableCell className={cn(CELL, "w-7")} />
      <TableCell className={CELL}>
        <Skeleton className="h-3 w-56" />
      </TableCell>
      <TableCell className={CELL} />
      {Array.from({ length: 8 }).map((_, index) => (
        <TableCell key={index} className={NUMERIC_CELL}>
          <Skeleton className="ml-auto h-3 w-10" />
        </TableCell>
      ))}
    </TableRow>
  );
}

/** Inline state row (error, empty) at the ledger's row height. */
export function LedgerStateRow({ children }: { children: ReactNode }) {
  return (
    <TableRow className={cn(ROW_HEIGHT, "hover:bg-transparent")}>
      <TableCell colSpan={LEDGER_COLUMN_COUNT} className={CELL}>
        {children}
      </TableCell>
    </TableRow>
  );
}
