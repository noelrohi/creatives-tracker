"use client";

import { Fragment } from "react";
import { ArrowDown, ArrowUp } from "@/components/icons";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useManagerAdActions } from "./manager-ad-actions";
import { ManagerAdSetRows } from "./manager-ledger-children";
import {
  ACTION_COLUMN,
  ManagerLedgerRow,
  STATUS_COLUMN,
} from "./manager-ledger-row";
import {
  ManagerLedgerErrorRow,
  ManagerLedgerNoResultsRow,
} from "./manager-ledger-states";
import {
  MANAGER_SORT_COLUMN_LABELS,
  MANAGER_SORT_COLUMNS,
  type ManagerSort,
  type ManagerSortColumn,
  sortManagerRows,
} from "./manager-ledger-sort";
import type {
  ManagerCampaignRow,
  ManagerLedgerFilters,
} from "./manager-ledger-types";
import { useManagerExpansion } from "./use-manager-expansion";
import { useManagerSort } from "./use-manager-sort";

const HEAD = "h-8 px-2 text-[11px] font-medium text-muted-foreground/70";
const NUMERIC_HEAD = `${HEAD} text-right`;

// Owns the expand/collapse state for the whole tree (see useManagerExpansion —
// ids are globally unique across levels, so one state covers campaigns and ad
// sets). Children rows mount only while expanded, which is what makes the
// loading lazy and what makes search auto-expansion fire their queries (§6).
//
// Sorting (§7) is one rule for the whole tree: campaigns are ordered here and
// `sort` is handed down so every children query orders its own sibling group
// the same way — the hierarchy never flattens.
//
// §9: the campaigns query's failure and its filtered-to-nothing result both land
// in the table body, so the header and the filter bar above stay usable. The
// unfiltered-empty case never reaches here — the page shows the centered empty
// state in place of the whole ledger.
export function ManagerLedger({
  campaigns,
  filters,
  isError,
  onRetry,
  onClearFilters,
}: {
  campaigns: ManagerCampaignRow[];
  filters: ManagerLedgerFilters;
  isError: boolean;
  onRetry: () => void;
  onClearFilters: () => void;
}) {
  const expansion = useManagerExpansion(Boolean(filters.search?.trim()));
  const { sort, toggleSort } = useManagerSort();
  const rows = sortManagerRows(campaigns, sort);

  // §8 actions are owned here so the pause/rename dialogs mount once for the
  // whole ledger and sit outside the <table>, whatever is expanded below.
  const { actions: adActions, dialogs: adActionDialogs } =
    useManagerAdActions(filters);

  return (
    <div className="rounded-lg border">
      <Table className="text-[13px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn(HEAD, "w-7")} />
            <TableHead className={HEAD}>Name</TableHead>
            <TableHead className={cn(HEAD, STATUS_COLUMN)}>Status</TableHead>
            {MANAGER_SORT_COLUMNS.map((column) => (
              <TableHead
                key={column}
                className={cn(NUMERIC_HEAD, "w-[84px]")}
                aria-sort={
                  sort.column === column
                    ? sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                <ManagerSortHeader
                  column={column}
                  sort={sort}
                  onToggle={toggleSort}
                />
              </TableHead>
            ))}
            {/* Row actions (§8) — hover-revealed, so the header stays blank. */}
            <TableHead className={cn(HEAD, ACTION_COLUMN)} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {isError && (
            <ManagerLedgerErrorRow
              message="Couldn't load campaigns."
              onRetry={onRetry}
            />
          )}
          {!isError && rows.length === 0 && (
            <ManagerLedgerNoResultsRow onClear={onClearFilters} />
          )}
          {rows.map((campaign) => {
            const isExpanded = expansion.isExpanded(campaign);
            return (
              <Fragment key={campaign.id}>
                <ManagerLedgerRow
                  row={campaign}
                  level="campaign"
                  isExpanded={isExpanded}
                  onToggle={() => expansion.toggle(campaign)}
                />
                {isExpanded && (
                  <ManagerAdSetRows
                    campaignId={campaign.id}
                    campaignStatus={campaign.status}
                    filters={filters}
                    expansion={expansion}
                    sort={sort}
                    adActions={adActions}
                  />
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      {adActionDialogs}
    </div>
  );
}

function ManagerSortHeader({
  column,
  sort,
  onToggle,
}: {
  column: ManagerSortColumn;
  sort: ManagerSort;
  onToggle: (column: ManagerSortColumn) => void;
}) {
  const active = sort.column === column;
  const Indicator = sort.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <button
      type="button"
      onClick={() => onToggle(column)}
      className={cn(
        "ml-auto flex items-center gap-1 rounded py-0.5 hover:text-foreground",
        active && "text-foreground",
      )}
    >
      {MANAGER_SORT_COLUMN_LABELS[column]}
      {active && <Indicator className="size-3" />}
    </button>
  );
}
