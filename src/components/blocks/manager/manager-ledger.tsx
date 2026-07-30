"use client";

import { Fragment } from "react";
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
import type {
  ManagerCampaignRow,
  ManagerLedgerFilters,
} from "./manager-ledger-types";
import { useManagerExpansion } from "./use-manager-expansion";

const HEAD = "h-8 px-2 text-[11px] font-medium text-muted-foreground/70";
const NUMERIC_HEAD = `${HEAD} text-right`;

const METRIC_HEADERS = ["Spend", "ROAS", "CPA", "CTR", "Conv"] as const;

// Owns the expand/collapse state for the whole tree (see useManagerExpansion —
// ids are globally unique across levels, so one state covers campaigns and ad
// sets). Children rows mount only while expanded, which is what makes the
// loading lazy and what makes search auto-expansion fire their queries (§6).
export function ManagerLedger({
  campaigns,
  filters,
}: {
  campaigns: ManagerCampaignRow[];
  filters: ManagerLedgerFilters;
}) {
  const expansion = useManagerExpansion(Boolean(filters.search?.trim()));

  return (
    <div className="rounded-lg border">
      <Table className="text-[13px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn(HEAD, "w-7")} />
            <TableHead className={HEAD}>Name</TableHead>
            <TableHead className={cn(HEAD, "w-16")}>Status</TableHead>
            {METRIC_HEADERS.map((label) => (
              <TableHead key={label} className={cn(NUMERIC_HEAD, "w-[84px]")}>
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {campaigns.map((campaign) => {
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
