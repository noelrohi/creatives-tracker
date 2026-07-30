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
import { ManagerAdSetRows } from "./manager-ledger-children";
import { ManagerLedgerRow } from "./manager-ledger-row";
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
export function ManagerLedger({
  campaigns,
  filters,
}: {
  campaigns: ManagerCampaignRow[];
  filters: ManagerLedgerFilters;
}) {
  const expansion = useManagerExpansion(Boolean(filters.search?.trim()));
  const { sort, toggleSort } = useManagerSort();
  const rows = sortManagerRows(campaigns, sort);

  return (
    <div className="rounded-lg border">
      <Table className="text-[13px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn(HEAD, "w-7")} />
            <TableHead className={HEAD}>Name</TableHead>
            <TableHead className={cn(HEAD, "w-16")}>Status</TableHead>
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
          </TableRow>
        </TableHeader>
        <TableBody>
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
                    filters={filters}
                    expansion={expansion}
                    sort={sort}
                  />
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
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
