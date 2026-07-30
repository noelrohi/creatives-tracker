"use client";

import { Fragment, useCallback, useState } from "react";
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

const HEAD = "h-8 px-2 text-[11px] font-medium text-muted-foreground/70";
const NUMERIC_HEAD = `${HEAD} text-right`;

const METRIC_HEADERS = ["Spend", "ROAS", "CPA", "CTR", "Conv"] as const;

// Owns the expand/collapse state for the whole tree — ids are globally unique
// across levels, so one set covers campaigns and ad sets. Children rows mount
// only while expanded, which is what makes the loading lazy (§6).
export function ManagerLedger({
  campaigns,
  filters,
}: {
  campaigns: ManagerCampaignRow[];
  filters: ManagerLedgerFilters;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

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
            const isExpanded = expanded.has(campaign.id);
            return (
              <Fragment key={campaign.id}>
                <ManagerLedgerRow
                  row={campaign}
                  level="campaign"
                  isExpanded={isExpanded}
                  onToggle={toggle}
                />
                {isExpanded && (
                  <ManagerAdSetRows
                    campaignId={campaign.id}
                    filters={filters}
                    expanded={expanded}
                    onToggle={toggle}
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
