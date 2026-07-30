"use client";

import { ChevronRight, MoreHorizontal, PauseCircle, Pencil } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  formatConversions,
  formatCtr,
  formatCurrency,
  formatRoas,
  roasTintClassName,
} from "./manager-ledger-format";
import {
  MANAGER_ANCESTOR_OFF_LABELS,
  type ManagerAncestorOff,
  type ManagerRowData,
  type ManagerLevel,
  type ManagerRowActions,
} from "./manager-ledger-types";

// Shared with the header in manager-ledger.tsx and the state rows in
// manager-ledger-states.tsx so every row of the ledger lines up. Status
// widened from w-16 to fit the §8 "campaign off" / "ad set off" annotation.
export const ROW_HEIGHT = "h-[29px]";
export const CELL = "px-2 py-0 text-[13px]";
export const STATUS_COLUMN = "w-28";
export const ACTION_COLUMN = "w-14";
// chevron · name · status · 5 metrics · actions.
export const LEDGER_COLUMN_COUNT = 9;

const NUMERIC_CELL = `${CELL} text-right font-mono tabular-nums`;

// Hover-only affordance that still reaches keyboard users, and stays put while
// its dropdown is open so the menu never detaches from a vanished trigger.
const HOVER_REVEAL =
  "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";

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
  isExpanded = false,
  onToggle,
  ancestorOff = null,
  actions = null,
}: {
  row: ManagerRowData;
  level: ManagerLevel;
  // Expansion only applies to rows with children; ad rows omit both.
  isExpanded?: boolean;
  onToggle?: () => void;
  ancestorOff?: ManagerAncestorOff;
  actions?: ManagerRowActions | null;
}) {
  const chip = LEVEL_CHIPS[level];
  const expandable = row.hasChildren && onToggle != null;

  return (
    // `group` drives the §8 hover affordances. The dim is on the row so an
    // "ON" ad under a switched-off parent never reads as delivering (§8) —
    // the status tag itself still reports the row's own state.
    <TableRow className={cn(ROW_HEIGHT, "group", ancestorOff && "opacity-50")}>
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
      <TableCell className={cn(CELL, STATUS_COLUMN)}>
        <div className="flex items-center gap-1.5">
          <ManagerStatusTag status={row.status} />
          {ancestorOff && (
            <span className="whitespace-nowrap text-[10px] text-muted-foreground/60">
              {MANAGER_ANCESTOR_OFF_LABELS[ancestorOff]}
            </span>
          )}
        </div>
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
      <TableCell className={cn(CELL, ACTION_COLUMN)}>
        {actions && <ManagerRowActionButtons row={row} actions={actions} />}
      </TableCell>
    </TableRow>
  );
}

// §8: pause is a direct hover icon (one click from the row), rename sits behind
// the kebab so the rarer, riskier action is out of mis-click range. Both stay
// inside the 29px row height.
function ManagerRowActionButtons({
  row,
  actions,
}: {
  row: ManagerRowData;
  actions: ManagerRowActions;
}) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      {actions.onPause && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn("size-5", HOVER_REVEAL)}
              disabled={actions.isPending}
              aria-label={`Pause ${row.name}`}
              onClick={actions.onPause}
            >
              <PauseCircle className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Pause in Meta</TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("size-5", HOVER_REVEAL)}
            disabled={actions.isPending}
            aria-label={`Actions for ${row.name}`}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={actions.onRename}>
            <Pencil className="size-3.5" /> Rename
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ON for active, OFF plus the actual word otherwise, matching the badge
// conventions in creative-ads-tab.tsx.
function ManagerStatusTag({ status }: { status: ManagerRowData["status"] }) {
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
      <TableCell className={cn(CELL, ACTION_COLUMN)} />
    </TableRow>
  );
}
