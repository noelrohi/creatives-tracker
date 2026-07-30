"use client";

import { ChevronRight } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  formatConversions,
  formatCtr,
  formatCurrency,
  formatRoas,
  roasTintClassName,
} from "./manager-ledger-format";
import type { ManagerLedgerRow, ManagerLevel } from "./manager-ledger-types";

const ROW_HEIGHT = "h-[29px]";
const CELL = "px-2 py-0 text-[13px]";
const NUMERIC_CELL = `${CELL} text-right font-mono tabular-nums`;

// Hierarchy encoding (§5): a chip plus a colored inset edge stripe per level,
// zero indentation so names keep full width.
const LEVEL_CHIPS: Record<ManagerLevel, { label: string; className: string }> = {
  campaign: { label: "CMP", className: "bg-primary/15 text-primary" },
  adSet: { label: "SET", className: "bg-muted text-muted-foreground" },
  ad: { label: "AD", className: "bg-transparent text-muted-foreground/60" },
};

const LEVEL_STRIPES: Record<ManagerLevel, string> = {
  campaign: "before:bg-primary/70",
  adSet: "before:bg-border",
  ad: "before:bg-transparent",
};

export function ManagerLedgerRow({
  row,
  level,
  isExpanded,
  onToggle,
}: {
  row: ManagerLedgerRow;
  level: ManagerLevel;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const chip = LEVEL_CHIPS[level];
  const expandable = row.hasChildren;

  return (
    <TableRow className={ROW_HEIGHT}>
      <TableCell className={cn(CELL, "w-7")}>
        {expandable && (
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
        )}
      </TableCell>
      <TableCell
        className={cn(
          CELL,
          "relative before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-['']",
          LEVEL_STRIPES[level],
        )}
      >
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className={cn(
              "h-4 shrink-0 rounded px-1 font-mono text-[9px] tracking-wider",
              chip.className,
            )}
          >
            {chip.label}
          </Badge>
          <span className="truncate">{row.name}</span>
        </div>
      </TableCell>
      <TableCell className={cn(CELL, "w-16")}>
        <ManagerStatusTag status={row.status} />
      </TableCell>
      <TableCell className={NUMERIC_CELL}>{formatCurrency(row.spend)}</TableCell>
      <TableCell className={cn(NUMERIC_CELL, roasTintClassName(row.roas))}>
        {formatRoas(row.roas)}
      </TableCell>
      <TableCell className={NUMERIC_CELL}>{formatCurrency(row.cpa)}</TableCell>
      <TableCell className={NUMERIC_CELL}>{formatCtr(row.ctr)}</TableCell>
      <TableCell className={NUMERIC_CELL}>
        {formatConversions(row.conversions)}
      </TableCell>
    </TableRow>
  );
}

// ON for active, OFF plus the actual word otherwise, matching the badge
// conventions in creative-ads-tab.tsx.
function ManagerStatusTag({ status }: { status: ManagerLedgerRow["status"] }) {
  if (status === "active") {
    return (
      <Badge
        variant="outline"
        className="h-4 rounded px-1 text-[9px] border-emerald-200 text-emerald-600 dark:border-emerald-900 dark:text-emerald-400"
      >
        ON
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="h-4 rounded px-1 text-[9px] capitalize">
      {status}
    </Badge>
  );
}

// §9 expand state: one inline skeleton child row while a children query runs.
export function ManagerLedgerChildSkeletonRow() {
  return (
    <TableRow className={ROW_HEIGHT}>
      <TableCell className={cn(CELL, "w-7")} />
      <TableCell className={CELL}>
        <Skeleton className="h-3 w-56" />
      </TableCell>
      {Array.from({ length: 6 }).map((_, index) => (
        <TableCell key={index} className={NUMERIC_CELL}>
          <Skeleton className="ml-auto h-3 w-10" />
        </TableCell>
      ))}
    </TableRow>
  );
}
